import { describe, expect, it } from 'vitest';
import worker from '../../../backend/src/worker.js';
import { makeEnv } from './helpers.js';

describe('backend worker boot', () => {
  it('exposes fetch and returns health response', async () => {
    expect(typeof worker.fetch).toBe('function');

    const request = new Request('https://api.businessflow.local/api/v1/health', { method: 'GET' });
    const response = await worker.fetch(request, makeEnv());

    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean };
    expect(body.success).toBe(true);
  });
});
