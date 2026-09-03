import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('network log capture channel hardening', () => {
  it('uses extension runtime messaging instead of window.postMessage bridge', () => {
    const file = resolve(process.cwd(), 'src/content/interceptor.ts');
    const source = readFileSync(file, 'utf8');

    expect(source).toContain("chrome.runtime.sendMessage({ type: 'TT_NETWORK_LOG', payload })");
    expect(source).not.toContain("window.postMessage({ type: '__TT_NETWORK_LOG'");
    expect(source).not.toContain('__TT_SESSION_ACTIVE');
  });
});
