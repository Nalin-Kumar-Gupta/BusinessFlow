import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests run in Node — no browser, no DOM, no Chrome APIs.
    // Chrome-API-touching code (background, content, storage) is excluded here;
    // those are covered by Playwright e2e tests.
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**'],
      exclude: ['src/core/types.ts'], // type-only, no logic
    },
  },
});
