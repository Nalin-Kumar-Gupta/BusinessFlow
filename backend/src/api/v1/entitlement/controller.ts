import type { AuthContext } from '../../../types.js';
import type { AuthService } from '../../../domain/auth/service.js';
import type { EntitlementService } from '../../../domain/entitlement/service.js';
import { jsonSuccess } from '../../../http/response.js';

export async function getMyEntitlement(
  auth: AuthContext,
  authService: AuthService,
  entitlementService: EntitlementService,
  requestId: string,
): Promise<Response> {
  const identity = await authService.requireIdentity(auth);
  const entitlement = await entitlementService.evaluate(identity);
  return jsonSuccess(entitlement, requestId, 200);
}
