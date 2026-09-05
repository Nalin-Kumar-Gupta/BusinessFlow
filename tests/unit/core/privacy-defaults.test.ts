import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_SETTINGS } from '../../../src/core/settings.js';

describe('privacy defaults', () => {
  it('disables network body capture by default', () => {
    expect(DEFAULT_SETTINGS.captureNetworkErrorBodies).toBe(false);
  });

  it('uses persistent host permission for local-only capture reliability', () => {
    const manifestPath = join(process.cwd(), 'src', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      host_permissions?: string[];
      optional_host_permissions?: string[];
    };

    expect(manifest.host_permissions ?? []).toEqual(['<all_urls>']);
    expect(manifest.optional_host_permissions ?? []).toEqual([]);
  });
});
