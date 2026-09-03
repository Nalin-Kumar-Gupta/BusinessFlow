import { describe, expect, it } from 'vitest';

import { hasEvidenceIntegrityRisk, summarizeRecordingIntegrity } from '../../../src/core/reliability.js';
import type { Step, TestEvent } from '../../../src/core/types.js';

describe('reliability integrity summary', () => {
  it('flags unresolved and critical evidence failures', () => {
    const events: TestEvent[] = [
      {
        id: 'req-1', sessionId: 's1', ts: 1, seq: 1, kind: 'evidence_requested',
        tabId: 1, trigger: 'manual', confidence: 'observed',
      },
      {
        id: 'req-2', sessionId: 's1', ts: 2, seq: 2, kind: 'evidence_requested',
        tabId: 1, trigger: 'manual', confidence: 'observed',
      },
      {
        id: 'ok-1', sessionId: 's1', ts: 3, seq: 3, kind: 'evidence_stored',
        tabId: 1, requestedEventId: 'req-1', trigger: 'manual', blobKey: 'b1',
        width: 1, height: 1, bytes: 1, format: 'image/jpeg', confidence: 'observed',
      },
      {
        id: 'fail-1', sessionId: 's1', ts: 4, seq: 4, kind: 'evidence_failed',
        tabId: 1, requestedEventId: 'req-2', trigger: 'manual',
        unavailableReason: 'capture_failed', confidence: 'observed',
      },
      {
        id: 'req-3', sessionId: 's1', ts: 5, seq: 5, kind: 'evidence_requested',
        tabId: 1, trigger: 'manual', confidence: 'observed',
      },
    ];

    const steps: Step[] = [
      {
        id: 'step-1', sessionId: 's1', tabId: 1, index: 1, seq: 1, ts: 1,
        label: 'a', semanticLabel: 'a', clickEventIds: [], systemEvidenceEventIds: [],
        beforeEvidenceEventId: 'ok-1',
      },
      {
        id: 'step-2', sessionId: 's1', tabId: 1, index: 2, seq: 2, ts: 2,
        label: 'b', semanticLabel: 'b', clickEventIds: [], systemEvidenceEventIds: [],
        noChangeDetected: false,
      },
    ];

    const summary = summarizeRecordingIntegrity(events, steps);
    expect(summary.requested).toBe(3);
    expect(summary.stored).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.unresolved).toBe(1);
    expect(summary.criticalFailures).toBe(1);
    expect(summary.stepsMissingBefore).toBe(1);
    expect(summary.stepsMissingAfter).toBe(2);
    expect(hasEvidenceIntegrityRisk(summary)).toBe(true);
  });

  it('does not flag risk when all step evidence is complete', () => {
    const events: TestEvent[] = [
      {
        id: 'req-1', sessionId: 's1', ts: 1, seq: 1, kind: 'evidence_requested',
        tabId: 1, trigger: 'manual', confidence: 'observed',
      },
      {
        id: 'ok-1', sessionId: 's1', ts: 2, seq: 2, kind: 'evidence_stored',
        tabId: 1, requestedEventId: 'req-1', trigger: 'manual', blobKey: 'b1',
        width: 1, height: 1, bytes: 1, format: 'image/jpeg', confidence: 'observed',
      },
    ];

    const steps: Step[] = [
      {
        id: 'step-1', sessionId: 's1', tabId: 1, index: 1, seq: 1, ts: 1,
        label: 'a', semanticLabel: 'a', clickEventIds: [], systemEvidenceEventIds: [],
        beforeEvidenceEventId: 'ok-1', afterEvidenceEventId: 'ok-1',
      },
    ];

    const summary = summarizeRecordingIntegrity(events, steps);
    expect(summary.unresolved).toBe(0);
    expect(summary.criticalFailures).toBe(0);
    expect(summary.stepsMissingBefore).toBe(0);
    expect(summary.stepsMissingAfter).toBe(0);
    expect(hasEvidenceIntegrityRisk(summary)).toBe(false);
  });
});
