import type { AuthContext } from '../../../types.js';
import type { AuthService } from '../../../domain/auth/service.js';
import type { AccountService } from '../../../domain/account/service.js';
import { jsonSuccess } from '../../../http/response.js';

export async function getAccount(
  auth: AuthContext,
  authService: AuthService,
  accountService: AccountService,
  requestId: string,
): Promise<Response> {
  const identity = await authService.requireIdentity(auth);
  const snapshot = await accountService.getAccountSnapshot(identity);
  return jsonSuccess(snapshot, requestId, 200);
}
