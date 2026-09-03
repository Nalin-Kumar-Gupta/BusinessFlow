import { describe, expect, it } from 'vitest';
import { parseJsonBody } from '../../../backend/src/validation/json.js';
import { validateHealthCheckRequest } from '../../../backend/src/validation/health.js';

describe('request validation', () => {
  it('rejects wrong content type', async () => {
    const request = new Request('https://api.businessflow.local/api/v1/health', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    });

    await expect(parseJsonBody(request)).rejects.toThrowError(/application\/json/);
  });

  it('rejects invalid health mode', () => {
    expect(() => validateHealthCheckRequest({ mode: 'banana' })).toThrowError(/mode must be either/);
  });

  it('accepts valid health mode', () => {
    expect(validateHealthCheckRequest({ mode: 'readiness' })).toEqual({ mode: 'readiness' });
  });
});
