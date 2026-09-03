// TestTrace lint guardrails.
//
// Two custom rules enforce architectural invariants that the product's privacy
// claim legally depends on. They are implemented inline (no plugin package) so
// every shipped byte stays auditable.
//
//   1. no-egress      — nothing in src/ may open a network connection.
//   2. no-chrome-core — src/core/ must stay chrome-free so it is unit-testable
//                       in plain Node and replayable offline.

import tseslint from 'typescript-eslint';

/** Globals that can move bytes off the machine. */
const EGRESS_IDENTIFIERS = new Set([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'importScripts',
]);

const noEgress = {
  meta: {
    type: 'problem',
    docs: { description: 'Ban all network egress from extension source.' },
    schema: [],
    messages: {
      egress:
        "Network egress '{{name}}' is banned in src/. TestTrace is local-only; " +
        'this rule underpins the Chrome Web Store "no data collected" declaration. ' +
        'To decode a data: URL use atob() + Uint8Array, never fetch().',
    },
  },
  create(context) {
    const flag = (node, name) => context.report({ node, messageId: 'egress', data: { name } });
    return {
      NewExpression(node) {
        if (node.callee.type === 'Identifier' && EGRESS_IDENTIFIERS.has(node.callee.name)) {
          flag(node, node.callee.name);
        }
      },
      CallExpression(node) {
        const { callee } = node;
        if (callee.type === 'Identifier' && EGRESS_IDENTIFIERS.has(callee.name)) {
          flag(node, callee.name);
        }
        // navigator.sendBeacon(...)
        if (
          callee.type === 'MemberExpression' &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'sendBeacon'
        ) {
          flag(node, 'navigator.sendBeacon');
        }
      },
    };
  },
};

const noChromeInCore = {
  meta: {
    type: 'problem',
    docs: { description: 'Keep src/core free of Chrome APIs.' },
    schema: [],
    messages: {
      chromeInCore:
        'src/core must stay chrome-free (pure, unit-testable, replayable). ' +
        'Move Chrome API access to src/background or src/storage and pass plain data in.',
    },
  },
  create(context) {
    return {
      Identifier(node) {
        if (node.name !== 'chrome') return;
        // Ignore property positions like `foo.chrome`.
        if (node.parent?.type === 'MemberExpression' && node.parent.property === node) return;
        context.report({ node, messageId: 'chromeInCore' });
      },
    };
  },
};

const testtrace = { rules: { 'no-egress': noEgress, 'no-chrome-core': noChromeInCore } };

export default tseslint.config(
  {
    ignores: [
      'dist/**', 'node_modules/**', 'poc/**',
      'test-results/**', 'playwright-report/**',
      'prettier.config.js',  // not TS
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { testtrace },
    rules: {
      'testtrace/no-egress': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['src/background/auth-entitlement.ts'],
    rules: {
      'testtrace/no-egress': 'off',
    },
  },
  {
    files: ['backend/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['src/core/**/*.ts'],
    plugins: { testtrace },
    rules: { 'testtrace/no-chrome-core': 'error' },
  },
  {
    files: ['fixture/**/*.mjs', 'build.mjs', 'tests/**/*.ts', 'playwright.config.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
);
