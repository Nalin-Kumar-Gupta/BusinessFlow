import type { Step, TestEvent, UnavailableReason } from './types.js';

const CRITICAL_CAPTURE_FAILURES = new Set<UnavailableReason>([
  'capture_failed',
  'worker_terminated',
  'tab_not_found',
  'tab_not_active',
]);

export interface RecordingIntegritySummary {
  requested: number;
  stored: number;
  failed: number;
  unresolved: number;
  criticalFailures: number;
  stepsMissingBefore: number;
  stepsMissingAfter: number;
}

export function summarizeRecordingIntegrity(
  events: readonly TestEvent[],
  steps: readonly Step[],
): RecordingIntegritySummary {
  const requestedIds = new Set<string>();
  const settledRequestIds = new Set<string>();

  let stored = 0;
  let failed = 0;
  let criticalFailures = 0;

  for (const event of events) {
    if (event.kind === 'evidence_requested') {
      requestedIds.add(event.id);
      continue;
    }
    if (event.kind === 'evidence_stored') {
      stored += 1;
      settledRequestIds.add(event.requestedEventId);
      continue;
    }
    if (event.kind === 'evidence_failed') {
      failed += 1;
      settledRequestIds.add(event.requestedEventId);
      if (CRITICAL_CAPTURE_FAILURES.has(event.unavailableReason)) criticalFailures += 1;
    }
  }

  let unresolved = 0;
  for (const requestedId of requestedIds) {
    if (!settledRequestIds.has(requestedId)) unresolved += 1;
  }

  let stepsMissingBefore = 0;
  let stepsMissingAfter = 0;
  for (const step of steps) {
    if (!step.beforeEvidenceEventId) stepsMissingBefore += 1;
    if (!step.noChangeDetected && !step.afterEvidenceEventId) stepsMissingAfter += 1;
  }

  return {
    requested: requestedIds.size,
    stored,
    failed,
    unresolved,
    criticalFailures,
    stepsMissingBefore,
    stepsMissingAfter,
  };
}

export function hasEvidenceIntegrityRisk(summary: RecordingIntegritySummary): boolean {
  return summary.unresolved > 0
    || summary.criticalFailures > 0
    || summary.stepsMissingBefore > 0
    || summary.stepsMissingAfter > 0;
}
