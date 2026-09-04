import type { EnvBindings } from './types.js';
import { loadConfig, type AppConfig } from './config/env.js';
import { createRequestContext } from './http/context.js';
import { createLogger } from './observability/logger.js';
import { D1DatabaseClient } from './db/client.js';
import { HealthService } from './domain/health/service.js';
import { buildAuthContext } from './auth/context.js';
import { routeRequest } from './api/router.js';
import { isApiError } from './errors/api-error.js';
import { jsonError } from './http/response.js';
import { applyCors, handleCorsPreflight } from './http/cors.js';
import { applySecurityHeaders } from './http/security-headers.js';
import { SupabaseAuthProvider } from './auth/supabase-provider.js';
import { D1AuthRepository, type AuthRepository } from './db/auth-repository.js';
import { AuthService } from './domain/auth/service.js';
import { AccountService } from './domain/account/service.js';
import type { AuthProvider } from './auth/provider.js';
import type { PaddleClient } from './billing/paddle-client.js';
import { PaddleApiClient } from './billing/paddle-client.js';
import type { BillingRepository } from './db/billing-repository.js';
import { D1BillingRepository } from './db/billing-repository.js';
import { BillingService } from './domain/billing/service.js';
import type { EntitlementRepository } from './db/entitlement-repository.js';
import { D1EntitlementRepository } from './db/entitlement-repository.js';
import { EntitlementService } from './domain/entitlement/service.js';

interface AppDependencies {
  createAuthProvider?: (config: AppConfig) => AuthProvider;
  createAuthRepository?: (env: EnvBindings) => AuthRepository;
  createPaddleClient?: (config: AppConfig) => PaddleClient;
  createBillingRepository?: (env: EnvBindings, config: AppConfig) => BillingRepository;
  createEntitlementRepository?: (env: EnvBindings) => EntitlementRepository;
}

export function createApp(dependencies: AppDependencies = {}) {
  return {
    async fetch(request: Request, env: EnvBindings): Promise<Response> {
      const requestContext = createRequestContext(request);
      const fallbackLogger = createLogger('info', requestContext);
      let config: AppConfig | null = null;

      try {
        config = loadConfig(env);
        const logger = createLogger(config.logLevel, requestContext);

        if (request.method === 'OPTIONS') {
          const preflight = handleCorsPreflight(request, config);
          return applySecurityHeaders(preflight, config.env);
        }

        const auth = buildAuthContext(request, config.auth.sessionCookieName);
        const db = new D1DatabaseClient(env.DB);
        const healthService = new HealthService(config, db);

        const authProvider = dependencies.createAuthProvider
          ? dependencies.createAuthProvider(config)
          : new SupabaseAuthProvider(config.auth.supabaseUrl, config.auth.supabasePublishableKey || config.auth.supabaseAnonKey);

        const authRepository = dependencies.createAuthRepository
          ? dependencies.createAuthRepository(env)
          : new D1AuthRepository(env.DB);

        const authService = new AuthService(authProvider, authRepository, {
          sessionTtlSeconds: config.auth.sessionTtlSeconds,
          sessionEncryptionKey: config.auth.sessionEncryptionKey,
        });

        const accountService = new AccountService(authRepository);

        const paddleClient = dependencies.createPaddleClient
          ? dependencies.createPaddleClient(config)
          : new PaddleApiClient(config.billing.paddleApiBaseUrl, config.billing.paddleApiKey);

        const billingRepository = dependencies.createBillingRepository
          ? dependencies.createBillingRepository(env, config)
          : new D1BillingRepository(env.DB, config.billing.paddlePriceIds);

        const billingService = new BillingService(
          billingRepository,
          paddleClient,
          {
            priceMap: config.billing.paddlePriceIds,
            productMap: config.billing.paddleProductIds,
            paddleClientToken: config.billing.paddleClientToken,
            paddleEnvironment: config.billing.paddleEnv,
            checkoutSuccessUrl: config.billing.checkoutSuccessUrl,
            checkoutCancelUrl: config.billing.checkoutCancelUrl,
          },
        );

        const entitlementRepository = dependencies.createEntitlementRepository
          ? dependencies.createEntitlementRepository(env)
          : new D1EntitlementRepository(env.DB);

        const entitlementService = new EntitlementService(entitlementRepository, {
          refreshAfterSeconds: config.entitlement.refreshIntervalSeconds,
          cacheMaxAgeSeconds: config.entitlement.cacheMaxAgeSeconds,
          offlineGraceSeconds: config.entitlement.offlineGraceSeconds,
        });

        const response = await routeRequest(request, {
          auth,
          config,
          requestId: requestContext.requestId,
          logger,
          services: {
            healthService,
            authService,
            accountService,
            billingService,
            entitlementService,
          },
        });

        const withCors = applyCors(request, response, config);
        return applySecurityHeaders(withCors, config.env);
      } catch (error) {
        if (isApiError(error)) {
          fallbackLogger.warn('Handled API error', {
            code: error.code,
            status: error.status,
          });
          const response = jsonError(
            error.code,
            error.message,
            requestContext.requestId,
            error.status,
            error.details,
          );
          const withCors = config ? applyCors(request, response, config) : response;
          return applySecurityHeaders(withCors, config?.env ?? 'local');
        }

        fallbackLogger.error('Unhandled worker error', {
          error: error instanceof Error ? error.message : String(error),
        });
        const response = jsonError(
          'INTERNAL_SERVER_ERROR',
          'An unexpected error occurred',
          requestContext.requestId,
          500,
        );
        const withCors = config ? applyCors(request, response, config) : response;
        return applySecurityHeaders(withCors, config?.env ?? 'local');
      }
    },
  };
}
