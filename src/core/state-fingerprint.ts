/**
 * DOM State Fingerprinting — pure TypeScript, zero browser APIs.
 *
 * A DOMSnapshot is built in the content script from live DOM reads, then
 * passed here as plain data.  computeFingerprint returns a stable string
 * that changes only when meaningful visible UI state changes.
 *
 * Deliberately ignored (noise):
 *   - TestTrace's own elements
 *   - <script> / <style> / <head> content
 *   - Timestamps (hh:mm:ss patterns, "X mins ago", ISO dates)
 *   - Monotonic counters (short pure-numeric strings)
 *   - CSS animation/transition properties
 */

// ─── Snapshot type ─────────────────────────────────────────────────────────────
// Built by the content script, fingerprinted here.

export interface DOMSnapshot {
  /** Full URL — changes on SPA route transitions */
  url: string;
  /** Visible h1–h3 and [role=heading] text (max 5) */
  headings: string[];
  /** Visible [role=alert] and [aria-live=assertive] text */
  alertTexts: string[];
  /** Visible [role=status] and [aria-live=polite] text */
  statusTexts: string[];
  /** Visible [role=dialog] or [role=alertdialog] accessible labels */
  dialogLabels: string[];
  /** Count of elements with aria-invalid=true */
  invalidFieldCount: number;
  /** True if any visible aria-busy=true element exists */
  hasBusyElement: boolean;
  /**
   * Key interactive element states — for enabled/disabled tracking.
   * Capped at 10 to avoid n² comparisons on form-heavy pages.
   */
  primaryButtons: ReadonlyArray<{ label: string; disabled: boolean }>;
}

// ─── Fingerprint computation ───────────────────────────────────────────────────

/** § is unlikely to appear in UI text; used as a section delimiter. */
const SEP = '§'; // §

/**
 * Compute a stable fingerprint string from a DOMSnapshot.
 * Two snapshots with the same fingerprint represent equivalent visible UI state.
 */
export function computeFingerprint(s: DOMSnapshot): string {
  return [
    cleanUrl(s.url),
    s.headings.slice(0, 5).map(cleanText).join('|'),
    s.alertTexts.map(cleanText).join('|'),
    s.statusTexts.map(cleanText).join('|'),
    s.dialogLabels.join('|'),
    String(s.invalidFieldCount),
    s.hasBusyElement ? '1' : '0',
    s.primaryButtons
      .slice(0, 10)
      .map((b) => `${cleanText(b.label)}:${b.disabled ? '1' : '0'}`)
      .join('|'),
  ].join(SEP);
}

/** True when the visible UI state meaningfully changed. */
export function fingerprintDiffers(before: string, after: string): boolean {
  return before !== after;
}

/** Extract the URL segment of a stored fingerprint. */
export function extractRoute(fp: string): string {
  return fp.split(SEP)[0] ?? '';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip query params that don't affect displayed content; keep the pathname. */
function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return u.origin + u.pathname;
  } catch {
    return raw;
  }
}

/** Remove timestamps and pure-numeric sequences that update continuously. */
function cleanText(t: string): string {
  return t
    // hh:mm or hh:mm:ss
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '')
    // ISO-ish dates
    .replace(/\d{4}-\d{2}-\d{2}/g, '')
    // "X mins/seconds/hours ago"
    .replace(/\d+\s*(min|sec|hour|day)s?\s*ago/gi, '')
    // standalone short numbers (counters, badges ≤ 6 digits)
    .replace(/\b\d{1,6}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
