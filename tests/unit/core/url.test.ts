import { describe, it, expect } from 'vitest';
import { redactUrl, safeOrigin, safePath, urlMatchesScope, originToPattern } from '../../../src/core/url.js';

describe('redactUrl', () => {
  it('strips userinfo credentials', () => {
    expect(redactUrl('https://user:pass@example.com/path')).toBe('https://example.com/path');
  });

  it('leaves URLs without credentials unchanged', () => {
    expect(redactUrl('https://example.com/path?q=1')).toBe('https://example.com/path?q=1');
  });

  it('returns original on unparseable input (truncated)', () => {
    const garbage = 'not-a-url';
    expect(redactUrl(garbage)).toBe(garbage);
  });

  it('truncates excessively long query strings', () => {
    const long = 'https://example.com/?' + 'x='.padEnd(600, 'a');
    const result = redactUrl(long);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain('…');
  });
});

describe('safeOrigin', () => {
  it('returns scheme+host+port', () => {
    expect(safeOrigin('https://example.com:8080/path')).toBe('https://example.com:8080');
  });

  it('returns empty string for invalid URL', () => {
    expect(safeOrigin('not-a-url')).toBe('');
  });
});

describe('safePath', () => {
  it('returns the pathname without query/fragment', () => {
    expect(safePath('https://example.com/foo/bar?q=1#hash')).toBe('/foo/bar');
  });

  it('returns raw string for invalid URL', () => {
    expect(safePath('not-a-url')).toBe('not-a-url');
  });
});

describe('originToPattern', () => {
  it('normalizes a standard https origin', () => {
    expect(originToPattern('https://example.com')).toBe('https://example.com/*');
  });

  it('drops port from localhost origins so permission checks stay valid', () => {
    expect(originToPattern('http://localhost:5173')).toBe('http://localhost/*');
  });

  it('returns empty string for unsupported schemes', () => {
    expect(originToPattern('file:///tmp/test.html')).toBe('');
  });
});

describe('urlMatchesScope', () => {
  it('matches when origin is in scope', () => {
    expect(urlMatchesScope('https://example.com/page', ['https://example.com/*'])).toBe(true);
  });

  it('does not match a different origin', () => {
    expect(urlMatchesScope('https://other.com/page', ['https://example.com/*'])).toBe(false);
  });

  it('returns false for unparseable URL', () => {
    expect(urlMatchesScope('not-a-url', ['https://example.com/*'])).toBe(false);
  });

  it('handles bare origin patterns (no wildcard)', () => {
    expect(urlMatchesScope('https://example.com/path', ['https://example.com'])).toBe(true);
  });
});
