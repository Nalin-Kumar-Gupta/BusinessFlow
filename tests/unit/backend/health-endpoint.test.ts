import { describe, expect, it } from 'vitest';
import { createApp } from '../../../backend/src/app.js';
import { makeEnv } from './helpers.js';

describe('health endpoint', () => {
  const app = createApp();

  it('supports GET readiness', async () => {
    const response = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/health', { method: 'GET' }),
      makeEnv(),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; data: { mode: string; db: { ok: boolean } } };
    expect(body.success).toBe(true);
    expect(body.data.mode).toBe('readiness');
    expect(body.data.db.ok).toBe(true);
  });

  it('supports POST liveness payload', async () => {
    const response = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/health', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'liveness' }),
      }),
      makeEnv(),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { data: { mode: string; db: { latencyMs: number | null } } };
    expect(body.data.mode).toBe('liveness');
    expect(body.data.db.latencyMs).toBeNull();
  });
});
