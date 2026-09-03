import { describe, expect, it } from 'vitest';
import { createApp } from '../../../backend/src/app.js';
import { makeEnv } from './helpers.js';

describe('error handling', () => {
  const app = createApp();

  it('returns structured 404 error for unknown route', async () => {
    const response = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/missing', { method: 'GET' }),
      makeEnv(),
    );

    expect(response.status).toBe(404);
    const body = await response.json() as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns structured validation error for malformed body', async () => {
    const response = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/health', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not-json',
      }),
      makeEnv(),
    );

    expect(response.status).toBe(400);
    const body = await response.json() as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_JSON');
  });
});
