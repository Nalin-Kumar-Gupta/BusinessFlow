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

export interface AfterCoverageSummary {
  eligible: number;
  captured: number;
  skipped: number;
  canceled: number;
  missing: number;
  coveragePct: number;
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

export function summarizeAfterCoverage(steps: readonly Step[]): AfterCoverageSummary {
  let eligible = 0;
  let captured = 0;
  let skipped = 0;
  let canceled = 0;

  for (const step of steps) {
    if (!step.beforeEvidenceEventId) continue;
    if (step.stepState === 'BEFORE_FAILED') continue;
    eligible += 1;

    if (step.afterEvidenceEventId) {
      captured += 1;
      continue;
    }

    if (step.stepState === 'AFTER_CANCELED') {
      canceled += 1;
      continue;
    }

    if (step.noChangeDetected || step.stepState === 'AFTER_SKIPPED') {
      skipped += 1;
    }
  }

  const resolved = captured + skipped + canceled;
  const missing = Math.max(eligible - resolved, 0);
  const coveragePct = eligible === 0 ? 100 : (resolved / eligible) * 100;

  return { eligible, captured, skipped, canceled, missing, coveragePct };
}

export function meetsAfterCoverageSlo(summary: AfterCoverageSummary, minCoveragePct = 98): boolean {
  return summary.coveragePct >= minCoveragePct;
}

export function hasEvidenceIntegrityRisk(summary: RecordingIntegritySummary): boolean {
  return summary.unresolved > 0
    || summary.criticalFailures > 0
    || summary.stepsMissingBefore > 0
    || summary.stepsMissingAfter > 0;
}
