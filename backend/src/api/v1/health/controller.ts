import type { HealthService } from '../../../domain/health/service.js';
import type { AuthContext } from '../../../types.js';
import { jsonSuccess } from '../../../http/response.js';
import { parseJsonBody } from '../../../validation/json.js';
import { validateHealthCheckRequest } from '../../../validation/health.js';

export async function getHealth(
  service: HealthService,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const snapshot = await service.getSnapshot('readiness', auth);
  return jsonSuccess(snapshot, requestId, snapshot.status === 'ok' ? 200 : 503);
}

export async function postHealth(
  request: Request,
  service: HealthService,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const body = await parseJsonBody(request);
  const validated = validateHealthCheckRequest(body);
  const snapshot = await service.getSnapshot(validated.mode, auth);
  return jsonSuccess(snapshot, requestId, snapshot.status === 'ok' ? 200 : 503);
}
