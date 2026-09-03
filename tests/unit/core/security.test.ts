import { describe, expect, it } from 'vitest';

import {
  escapeHtml,
  isAllowedImageMimeType,
  sanitizeDownloadFilename,
  sanitizeExcelCellText,
  sanitizeFilenameSegment,
} from '../../../src/core/security.js';

describe('core security helpers', () => {
  it('escapes dangerous HTML characters', () => {
    expect(escapeHtml(`<img src=x onerror='alert(1)'>`)).toBe('&lt;img src=x onerror=&#39;alert(1)&#39;&gt;');
  });

  it('neutralizes spreadsheet formula injection prefixes', () => {
    expect(sanitizeExcelCellText('=CMD()')).toBe("'=CMD()");
    expect(sanitizeExcelCellText('+SUM(1,2)')).toBe("'+SUM(1,2)");
    expect(sanitizeExcelCellText('safe text')).toBe('safe text');
  });

  it('sanitizes filename segments and download names', () => {
    expect(sanitizeFilenameSegment('../evil:*name', 'fallback')).toBe('evil-name');
    expect(sanitizeDownloadFilename('  ../../report?.pdf  ', 'fallback.bin')).toBe('----report-.pdf');
  });

  it('allows only safe screenshot image mime types', () => {
    expect(isAllowedImageMimeType('image/png')).toBe(true);
    expect(isAllowedImageMimeType('image/svg+xml')).toBe(false);
    expect(isAllowedImageMimeType('text/html')).toBe(false);
  });
});
