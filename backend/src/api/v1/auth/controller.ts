import type { AuthContext } from '../../../types.js';
import type { AuthService } from '../../../domain/auth/service.js';
import { jsonSuccess } from '../../../http/response.js';
import { parseJsonBody } from '../../../validation/json.js';
import { validateCredentialRequest, validateEmailRequest } from '../../../validation/auth.js';
import { serializeCookie } from '../../../http/cookies.js';
import { enforceRateLimit } from '../../../http/rate-limit.js';
import type { AppConfig } from '../../../config/env.js';

function appendSessionCookie(response: Response, sessionToken: string, config: AppConfig): Response {
  const headers = new Headers(response.headers);
  headers.append(
    'set-cookie',
    serializeCookie(config.auth.sessionCookieName, sessionToken, {
      maxAgeSeconds: config.auth.sessionTtlSeconds,
      path: '/',
      httpOnly: true,
      secure: config.env !== 'local',
      sameSite: 'Lax',
    }),
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function appendSessionClearCookie(response: Response, config: AppConfig): Response {
  const headers = new Headers(response.headers);
  headers.append(
    'set-cookie',
    serializeCookie(config.auth.sessionCookieName, '', {
      maxAgeSeconds: 0,
      path: '/',
      httpOnly: true,
      secure: config.env !== 'local',
      sameSite: 'Lax',
    }),
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function signup(
  request: Request,
  service: AuthService,
  requestId: string,
  config: AppConfig,
): Promise<Response> {
  enforceRateLimit(request, {
    bucket: 'auth-signup',
    limit: 20,
    windowMs: 5 * 60 * 1000,
  });
  const body = await parseJsonBody(request);
  const credentials = validateCredentialRequest(body);
  const result = await service.signup(credentials.email, credentials.password);
  const response = jsonSuccess({ user: result.profile }, requestId, 201);
  return appendSessionCookie(response, result.sessionToken, config);
}

export async function login(
  request: Request,
  service: AuthService,
  requestId: string,
  config: AppConfig,
): Promise<Response> {
  enforceRateLimit(request, {
    bucket: 'auth-login',
    limit: 25,
    windowMs: 5 * 60 * 1000,
  });
  const body = await parseJsonBody(request);
  const credentials = validateCredentialRequest(body);
  const result = await service.login(credentials.email, credentials.password);
  const response = jsonSuccess({ user: result.profile }, requestId, 200);
  return appendSessionCookie(response, result.sessionToken, config);
}

export async function logout(
  auth: AuthContext,
  service: AuthService,
  requestId: string,
  config: AppConfig,
): Promise<Response> {
  await service.logout(auth);
  const response = jsonSuccess({ loggedOut: true }, requestId, 200);
  return appendSessionClearCookie(response, config);
}

export async function me(auth: AuthContext, service: AuthService, requestId: string): Promise<Response> {
  const identity = await service.requireIdentity(auth);
  return jsonSuccess({ user: identity }, requestId, 200);
}

export async function extensionLogin(
  request: Request,
  service: AuthService,
  requestId: string,
  config: AppConfig,
): Promise<Response> {
  enforceRateLimit(request, {
    bucket: 'auth-extension-login',
    limit: 30,
    windowMs: 5 * 60 * 1000,
  });
  const body = await parseJsonBody(request);
  const credentials = validateCredentialRequest(body);
  const result = await service.login(credentials.email, credentials.password);
  return jsonSuccess({
    user: result.profile,
    sessionToken: result.sessionToken,
    expiresInSeconds: config.auth.sessionTtlSeconds,
  }, requestId, 200);
}

export async function extensionLogout(
  auth: AuthContext,
  service: AuthService,
  requestId: string,
): Promise<Response> {
  await service.logout(auth);
  return jsonSuccess({ loggedOut: true }, requestId, 200);
}

export async function forgotPassword(
  request: Request,
  service: AuthService,
  requestId: string,
): Promise<Response> {
  enforceRateLimit(request, {
    bucket: 'auth-forgot-password',
    limit: 10,
    windowMs: 5 * 60 * 1000,
  });

  const body = await parseJsonBody(request);
  const payload = validateEmailRequest(body);
  await service.requestPasswordReset(payload.email);

  return jsonSuccess({
    accepted: true,
    message: 'If that email exists, a reset link has been sent.',
  }, requestId, 200);
}
