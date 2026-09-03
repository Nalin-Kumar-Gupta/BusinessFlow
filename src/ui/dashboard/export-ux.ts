import type { Session } from '../../core/types.js';
import type { SessionExportBundle } from '../../storage/db.js';

export type ExportFormat = 'pdf' | 'word' | 'excel' | 'bflow';
export type SessionSelectionMode = 'selected' | 'latest' | 'all';
export type ExportModalContext = 'feature' | 'test-case';

export interface ExportFormatDefinition {
  readonly format: ExportFormat;
  readonly label: string;
  readonly shortHelp: string;
  readonly containsLabel: string;
  readonly scopeLabel: 'Run export' | 'Feature archive';
  readonly recommendedForMostTesters: boolean;
}

export interface ExportPreflightSummary {
  readonly selectedRunLabel: string;
  readonly stepCount: number;
  readonly findingCount: number;
  readonly requestCount: number;
  readonly evidenceCount: number;
  readonly missingEvidenceCount: number;
  readonly isLargeRun: boolean;
}

export const EXPORT_FORMATS: readonly ExportFormatDefinition[] = [
  {
    format: 'pdf',
    label: 'PDF',
    shortHelp: 'Polished report to share with stakeholders.',
    containsLabel: 'Executive summary, findings, and supporting screenshots.',
    scopeLabel: 'Run export',
    recommendedForMostTesters: true,
  },
  {
    format: 'word',
    label: 'Word (.docx)',
    shortHelp: 'Editable report for collaboration and rewrites.',
    containsLabel: 'Same run story as PDF, optimized for editing.',
    scopeLabel: 'Run export',
    recommendedForMostTesters: false,
  },
  {
    format: 'excel',
    label: 'Excel (.xlsx)',
    shortHelp: 'Workbook for deep analysis and triage.',
    containsLabel: 'Step-by-step, findings, network, evidence index, performance.',
    scopeLabel: 'Run export',
    recommendedForMostTesters: false,
  },
  {
    format: 'bflow',
    label: '.bflow archive',
    shortHelp: 'Native BusinessFlow package for re-import.',
    containsLabel: 'Feature sessions, events, docs, blob index, and raw evidence.',
    scopeLabel: 'Feature archive',
    recommendedForMostTesters: false,
  },
] as const;

export function defaultExportFormat(): ExportFormat {
  return 'pdf';
}

export function resolveSessionForExport(
  mode: SessionSelectionMode,
  activeSession: Session | null,
  featureSessions: Session[],
): Session | null {
  if (mode === 'selected') return activeSession;
  if (mode === 'latest') return featureSessions[0] ?? null;
  return null;
}

export function exportEligibilityIssue(
  format: ExportFormat,
  session: Session | null,
): string | null {
  if (!isFormatSessionScoped(format)) return null;
  if (!session) return 'No run selected for export.';
  if (session.recordingState !== 'stopped') {
    return 'Stop recording before exporting this run.';
  }
  return null;
}

export function buildExportPreflightSummary(session: Session, bundle: SessionExportBundle): ExportPreflightSummary {
  const storedBlobKeys = new Set(bundle.blobs.map((blob) => blob.key));
  const evidenceEvents = bundle.events.filter((event): event is Extract<typeof event, { kind: 'evidence_stored' }> => event.kind === 'evidence_stored');
  const missingEvidenceCount = evidenceEvents.filter((event) => !storedBlobKeys.has(event.blobKey)).length;

  const stepCount = bundle.steps.length;
  const findingCount = bundle.steps.reduce((sum, step) => sum + (step.bugs?.length ?? (step.isBug ? 1 : 0)), 0);
  const requestCount = bundle.networkLogs.length;
  const evidenceCount = bundle.blobs.length;

  return {
    selectedRunLabel: `${session.testCaseName || 'Untitled Test Case'} • ${new Date(session.startedAt).toLocaleString()}`,
    stepCount,
    findingCount,
    requestCount,
    evidenceCount,
    missingEvidenceCount,
    isLargeRun: stepCount >= 120 || requestCount >= 500 || evidenceCount >= 150,
  };
}

export function isFormatSessionScoped(format: ExportFormat): boolean {
  return format !== 'bflow';
}

export function formatScopeCopy(format: ExportFormat): string {
  return isFormatSessionScoped(format)
    ? 'Exports the selected run when viewing a test case, or latest run per test case when exporting from a feature page.'
    : 'Exports the full feature archive.';
}

export function isExportModalContextValid(
  context: ExportModalContext,
  hasActiveFeature: boolean,
  hasActiveSession: boolean,
): boolean {
  if (!hasActiveFeature) return false;
  return context === 'feature' ? !hasActiveSession : hasActiveSession;
}
