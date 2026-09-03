import { describe, expect, it } from 'vitest';
import { createApp } from '../../../backend/src/app.js';
import { makeEnv } from './helpers.js';

describe('CORS behavior', () => {
  const app = createApp();

  it('allows configured origin', async () => {
    const response = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/health', {
        method: 'GET',
        headers: { origin: 'http://localhost:3000' },
      }),
      makeEnv(),
    );

    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
  });

  it('does not allow unknown origin', async () => {
    const response = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/health', {
        method: 'GET',
        headers: { origin: 'https://evil.example' },
      }),
      makeEnv(),
    );

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('handles allowed preflight', async () => {
    const response = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/health', {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:3000' },
      }),
      makeEnv(),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
  });

  it('rejects disallowed preflight', async () => {
    const response = await app.fetch(
      new Request('https://api.businessflow.local/api/v1/health', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example' },
      }),
      makeEnv(),
    );

    expect(response.status).toBe(403);
  });
});
