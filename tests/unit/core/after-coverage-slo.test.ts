import { beforeEach, describe, expect, it } from 'vitest';

import { meetsAfterCoverageSlo, summarizeAfterCoverage } from '../../../src/core/reliability.js';
import type { Step } from '../../../src/core/types.js';

let stepCounter = 0;

function makeStep(overrides: Partial<Step> = {}): Step {
  stepCounter += 1;
  return {
    id: `step-${stepCounter}`,
    sessionId: 'sess-1',
    tabId: 1,
    index: 1,
    ts: 1,
    seq: 1,
    label: 'Click',
    clickEventIds: ['ev-1'],
    systemEvidenceEventIds: [],
    beforeEvidenceEventId: 'before-1',
    ...overrides,
  };
}

describe('after coverage slo', () => {
  beforeEach(() => {
    stepCounter = 0;
  });

  it('computes resolved vs missing after coverage for step outcomes', () => {
    const steps: Step[] = [
      makeStep({ afterEvidenceEventId: 'after-1', stepState: 'AFTER_STORED' }),
      makeStep({ noChangeDetected: true, stepState: 'AFTER_SKIPPED' }),
      makeStep({ stepState: 'AFTER_CANCELED' }),
      makeStep({ stepState: 'AFTER_QUEUED' }),
      makeStep({ beforeEvidenceEventId: undefined }), // ineligible
      makeStep({ stepState: 'BEFORE_FAILED' }), // ineligible
    ];

    const summary = summarizeAfterCoverage(steps);

    expect(summary.eligible).toBe(4);
    expect(summary.captured).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.canceled).toBe(1);
    expect(summary.missing).toBe(1);
    expect(summary.coveragePct).toBe(75);
  });

  it('enforces coverage slo threshold', () => {
    const strong = summarizeAfterCoverage([
      makeStep({ afterEvidenceEventId: 'after-1', stepState: 'AFTER_STORED' }),
      makeStep({ noChangeDetected: true, stepState: 'AFTER_SKIPPED' }),
      makeStep({ stepState: 'AFTER_CANCELED' }),
      makeStep({ afterEvidenceEventId: 'after-2', stepState: 'AFTER_STORED' }),
      makeStep({ afterEvidenceEventId: 'after-3', stepState: 'AFTER_STORED' }),
    ]);

    const weak = summarizeAfterCoverage([
      makeStep({ afterEvidenceEventId: 'after-1', stepState: 'AFTER_STORED' }),
      makeStep({ stepState: 'AFTER_QUEUED' }),
      makeStep({ stepState: 'AFTER_QUEUED' }),
      makeStep({ stepState: 'AFTER_QUEUED' }),
      makeStep({ stepState: 'AFTER_QUEUED' }),
    ]);

    expect(meetsAfterCoverageSlo(strong, 98)).toBe(true);
    expect(meetsAfterCoverageSlo(weak, 98)).toBe(false);
  });
});
