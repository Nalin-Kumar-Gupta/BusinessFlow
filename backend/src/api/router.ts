import type { AppConfig } from '../config/env.js';
import type { AuthContext } from '../types.js';
import type { Logger } from '../observability/logger.js';
import type { HealthService } from '../domain/health/service.js';
import type { AuthService } from '../domain/auth/service.js';
import type { AccountService } from '../domain/account/service.js';
import type { BillingService } from '../domain/billing/service.js';
import type { EntitlementService } from '../domain/entitlement/service.js';
import { ApiError } from '../errors/api-error.js';
import { getHealth, postHealth } from './v1/health/controller.js';
import { login, logout, me, signup, extensionLogin, extensionLogout } from './v1/auth/controller.js';
import { getAccount } from './v1/account/controller.js';
import { createCheckout, createCustomerPortal, getBillingCatalog, handlePaddleWebhook } from './v1/billing/controller.js';
import { getMyEntitlement } from './v1/entitlement/controller.js';

export interface AppServices {
  healthService: HealthService;
  authService: AuthService;
  accountService: AccountService;
  billingService: BillingService;
  entitlementService: EntitlementService;
}

export interface RouteContext {
  config: AppConfig;
  auth: AuthContext;
  requestId: string;
  logger: Logger;
  services: AppServices;
}

export async function routeRequest(request: Request, context: RouteContext): Promise<Response> {
  const url = new URL(request.url);
  const v1Base = `/api/${context.config.apiVersion}`;

  if (!url.pathname.startsWith('/api/')) {
    throw new ApiError({
      code: 'NOT_FOUND',
      status: 404,
      message: 'Route not found',
    });
  }

  if (url.pathname === `${v1Base}/health` && request.method === 'GET') {
    context.logger.debug('Handling GET health route');
    return getHealth(context.services.healthService, context.auth, context.requestId);
  }

  if (url.pathname === `${v1Base}/health` && request.method === 'POST') {
    context.logger.debug('Handling POST health route');
    return postHealth(request, context.services.healthService, context.auth, context.requestId);
  }

  if (url.pathname === `${v1Base}/auth/signup` && request.method === 'POST') {
    return signup(request, context.services.authService, context.requestId, context.config);
  }

  if (url.pathname === `${v1Base}/auth/login` && request.method === 'POST') {
    return login(request, context.services.authService, context.requestId, context.config);
  }

  if (url.pathname === `${v1Base}/auth/logout` && request.method === 'POST') {
    return logout(context.auth, context.services.authService, context.requestId, context.config);
  }

  if (url.pathname === `${v1Base}/auth/me` && request.method === 'GET') {
    return me(context.auth, context.services.authService, context.requestId);
  }

  if (url.pathname === `${v1Base}/auth/extension/login` && request.method === 'POST') {
    return extensionLogin(request, context.services.authService, context.requestId, context.config);
  }

  if (url.pathname === `${v1Base}/auth/extension/logout` && request.method === 'POST') {
    return extensionLogout(context.auth, context.services.authService, context.requestId);
  }

  if (url.pathname === `${v1Base}/account` && request.method === 'GET') {
    return getAccount(context.auth, context.services.authService, context.services.accountService, context.requestId);
  }

  if (url.pathname === `${v1Base}/billing/catalog` && request.method === 'GET') {
    context.logger.debug('Handling billing catalog request');
    return getBillingCatalog(request, context.services.billingService, context.requestId);
  }

  if (url.pathname === `${v1Base}/billing/checkout` && request.method === 'POST') {
    context.logger.info('Handling billing checkout request');
    return createCheckout(request, context.auth, context.services.authService, context.services.billingService, context.requestId);
  }

  if (url.pathname === `${v1Base}/billing/portal` && request.method === 'POST') {
    context.logger.info('Handling billing portal request');
    return createCustomerPortal(context.auth, context.services.authService, context.services.billingService, context.requestId);
  }

  if (url.pathname === `${v1Base}/billing/webhook` && request.method === 'POST') {
    context.logger.info('Handling billing webhook request');
    return handlePaddleWebhook(request, context.services.billingService, context.requestId, context.config.billing.paddleWebhookSecret);
  }

  if (url.pathname === `${v1Base}/entitlement` && request.method === 'GET') {
    context.logger.debug('Handling entitlement request');
    return getMyEntitlement(context.auth, context.services.authService, context.services.entitlementService, context.requestId);
  }

  if (url.pathname.startsWith(v1Base)) {
    throw new ApiError({
      code: 'NOT_FOUND',
      status: 404,
      message: 'Route not found',
      details: { method: request.method, path: url.pathname },
    });
  }

  throw new ApiError({
    code: 'UNSUPPORTED_API_VERSION',
    status: 404,
    message: `Unsupported API base path. Expected ${v1Base}`,
  });
}
