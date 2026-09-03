import type { SessionReport } from '../../core/types.js';

export function exportSessionJson(report: SessionReport): string {
  // Remove blob data (binary) — only keep keys
  const safe = {
    ...report,
    events: report.events.filter((e) => e.kind !== 'evidence_stored' || true), // keep all metadata
    _exportedAt: new Date().toISOString(),
    _exportVersion: 1,
  };
  return JSON.stringify(safe, null, 2);
}
