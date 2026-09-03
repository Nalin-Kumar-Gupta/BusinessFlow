const EXCEL_FORMULA_PREFIX = /^[=+\-@\t\r]/;
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

export function escapeHtml(input: string | undefined): string {
  return (input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeExcelCellText(input: string): string {
  const normalized = input.replace(/\u0000/g, '').slice(0, 32767);
  return EXCEL_FORMULA_PREFIX.test(normalized) ? `'${normalized}` : normalized;
}

export function sanitizeFilenameSegment(input: string, fallback = 'untitled'): string {
  const normalized = input
    .normalize('NFKC')
    .replace(INVALID_FILENAME_CHARS, '-')
    .replace(/\.+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return normalized || fallback;
}

export function sanitizeDownloadFilename(filename: string, fallback = 'download.bin'): string {
  const normalized = filename
    .normalize('NFKC')
    .replace(INVALID_FILENAME_CHARS, '-')
    .replace(/\.\.+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return normalized || fallback;
}

export function isAllowedImageMimeType(mimeType: string): boolean {
  return mimeType === 'image/png'
    || mimeType === 'image/jpeg'
    || mimeType === 'image/jpg'
    || mimeType === 'image/webp';
}
