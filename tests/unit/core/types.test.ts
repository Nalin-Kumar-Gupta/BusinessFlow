import { describe, it, expect } from 'vitest';
import { EVENT_SCHEMA_VERSION, CORRELATION_VERSION } from '../../../src/core/types.js';

describe('core/types constants', () => {
  it('EVENT_SCHEMA_VERSION is 1', () => {
    expect(EVENT_SCHEMA_VERSION).toBe(1);
  });

  it('CORRELATION_VERSION is 1', () => {
    expect(CORRELATION_VERSION).toBe(1);
  });
});
