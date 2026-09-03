import { describe, expect, it } from 'vitest';
import { D1DatabaseClient } from '../../../backend/src/db/client.js';
import { fakeD1 } from './helpers.js';

describe('database connectivity abstraction', () => {
  it('returns healthy ping from D1 adapter', async () => {
    const client = new D1DatabaseClient(fakeD1);
    const result = await client.ping();
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('throws when DB binding is missing', () => {
    expect(() => new D1DatabaseClient(undefined)).toThrowError(/not configured/i);
  });
});
