import { beforeEach, describe, expect, it } from 'vitest';
import { checkScreenshotThrottle, nextSeq } from '../../../src/storage/session-state.js';

type Store = Record<string, unknown>;

function makeMockChrome(store: Store): void {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string | string[] | null = null): Promise<Record<string, unknown>> => {
          await jitter();
          if (key === null) return { ...store };
          if (Array.isArray(key)) {
            return Object.fromEntries(key.map((k) => [k, store[k]]));
          }
          return { [key]: store[key] };
        },
        set: async (items: Record<string, unknown>): Promise<void> => {
          await jitter();
          Object.assign(store, items);
        },
        remove: async (key: string | string[]): Promise<void> => {
          await jitter();
          const keys = Array.isArray(key) ? key : [key];
          for (const k of keys) delete store[k];
        },
        clear: async (): Promise<void> => {
          await jitter();
          for (const k of Object.keys(store)) delete store[k];
        },
      },
    },
  };
}

async function jitter(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, Math.floor(Math.random() * 3)));
}

describe('session-state locking', () => {
  let store: Store;

  beforeEach(() => {
    store = {};
    makeMockChrome(store);
  });

  it('allocates unique monotonic sequence numbers under concurrency', async () => {
    const all = await Promise.all(Array.from({ length: 60 }, () => nextSeq()));
    const sorted = [...all].sort((a, b) => a - b);

    expect(new Set(all).size).toBe(60);
    expect(sorted[0]).toBe(1);
    expect(sorted[59]).toBe(60);
  });

  it('applies screenshot throttle atomically per tab', async () => {
    const tabId = 17;
    const minIntervalMs = 10_000;

    const burst = await Promise.all(
      Array.from({ length: 20 }, () => checkScreenshotThrottle(tabId, minIntervalMs)),
    );

    expect(burst.filter(Boolean)).toHaveLength(1);
  });
});
