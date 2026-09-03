import type { AuthContext } from '../types.js';
import { parseCookie } from '../http/cookies.js';

export function buildAuthContext(request: Request, sessionCookieName: string): AuthContext {
  const authorization = request.headers.get('authorization')?.trim();
  if (authorization) {
    const [scheme, token] = authorization.split(/\s+/, 2);
    const lower = scheme?.toLowerCase();
    if (lower === 'bearer' && token) {
      return {
        actorType: 'bearer',
        bearerToken: token,
      };
    }

    if (lower === 'session' && token) {
      return {
        actorType: 'session',
        sessionToken: token,
      };
    }
  }

  const sessionToken = parseCookie(request.headers.get('cookie'), sessionCookieName);
  if (sessionToken) {
    return {
      actorType: 'session',
      sessionToken,
    };
  }

  return { actorType: 'anonymous' };
}
