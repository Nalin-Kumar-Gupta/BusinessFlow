import { describe, expect, it } from 'vitest';

import { EVENT_SCHEMA_VERSION } from '../../../src/core/types.js';
import type {
  EvidenceStoredEvent,
  Session,
  Step,
  TestEvent,
} from '../../../src/core/types.js';
import type { SessionExportBundle } from '../../../src/storage/db.js';
import {
  buildFeatureExportModel,
  buildTestCaseExportModel,
} from '../../../src/ui/export/scope-models.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    featureName: 'Checkout',
    testCaseName: 'Buy widget',
    testCaseId: 'TC-1',
    mode: 'guided',
    negativeTest: 'no',
    negativeTestSource: 'default',
    recordingState: 'stopped',
    startedAt: 1_000,
    endedAt: 8_000,
    scopeOrigins: ['https://shop.example.com/*'],
    environment: {
      userAgent: 'TestAgent/1.0',
      chromeVersion: '120',
      platform: 'MacIntel',
      extVersion: '1.0.0',
      timeZone: 'UTC',
      viewport: { width: 1440, height: 900, devicePixelRatio: 2 },
    },
    counters: {
      events: 0,
      networkRequests: 0,
      httpErrors: 0,
      networkErrors: 0,
      consoleErrors: 0,
      consoleWarns: 0,
      pageErrors: 0,
      screenshots: 0,
      manualCaptures: 0,
      rageClicks: 0,
      steps: 0,
    },
    schemaVersion: EVENT_SCHEMA_VERSION,
    testResult: 'pass',
    status: 'pass',
    testType: 'Positive',
    apiSlaSec: 3,
    ...overrides,
  };
}

function makeStep(overrides: Partial<Step> & { id: string; index: number; ts: number }): Step {
  return {
    ...overrides,
    id: overrides.id,
    sessionId: 'sess-1',
    tabId: 1,
    index: overrides.index,
    ts: overrides.ts,
    seq: overrides.index,
    label: overrides.label ?? `Step ${overrides.index}`,
    clickEventIds: overrides.clickEventIds ?? [`click-${overrides.index}`],
    systemEvidenceEventIds: overrides.systemEvidenceEventIds ?? [],
  };
}

function makeEvidenceStored(
  overrides: Partial<EvidenceStoredEvent> & { id: string; blobKey: string; ts: number },
): EvidenceStoredEvent {
  return {
    ...overrides,
    id: overrides.id,
    kind: 'evidence_stored',
    sessionId: overrides.sessionId ?? 'sess-1',
    tabId: overrides.tabId ?? 1,
    ts: overrides.ts,
    seq: overrides.seq ?? 10,
    confidence: overrides.confidence ?? 'observed',
    requestedEventId: overrides.requestedEventId ?? `${overrides.id}-req`,
    trigger: overrides.trigger ?? 'manual',
    blobKey: overrides.blobKey,
    width: overrides.width ?? 1200,
    height: overrides.height ?? 800,
    bytes: overrides.bytes ?? 12345,
    format: overrides.format ?? 'image/jpeg',
  };
}

function makeBundle(overrides: {
  session?: Session;
  steps?: Step[];
  events?: TestEvent[];
  blobKeys?: string[];
} = {}): SessionExportBundle {
  const session = overrides.session ?? makeSession();
  const steps = overrides.steps ?? [];
  const events = overrides.events ?? [];
  const blobKeys = overrides.blobKeys ?? [];

  return {
    session,
    steps,
    events,
    networkLogs: [],
    blobs: blobKeys.map((key) => ({
      key,
      mimeType: 'image/jpeg' as const,
      storedAt: session.startedAt,
      sessionId: session.id,
    })),
  };
}

describe('scope-models — test case scope', () => {
  it('builds a detailed test-case model for a single execution', () => {
    const before = makeEvidenceStored({ id: 'ev-before', blobKey: 'blob-before', ts: 2_000, trigger: 'user_action' });
    const after = makeEvidenceStored({ id: 'ev-after', blobKey: 'blob-after', ts: 2_400, trigger: 'user_action_after' });
    const manual = makeEvidenceStored({ id: 'ev-manual', blobKey: 'blob-manual', ts: 2_600, trigger: 'manual' });

    const step = makeStep({
      id: 'step-1',
      index: 1,
      ts: 2_000,
      beforeEvidenceEventId: before.id,
      afterEvidenceEventId: after.id,
      qaNotes: [{ id: 'note-1', text: 'Observed spinner', pin: { target: 'after', x: 42, y: 65 } }],
      bugs: [{ id: 'bug-1', description: 'Spinner never clears', pin: { target: 'after', x: 40, y: 62 } }],
      elementRect: {
        x: 100,
        y: 120,
        width: 200,
        height: 80,
        pageScrollX: 0,
        pageScrollY: 300,
        viewportWidth: 1440,
        viewportHeight: 900,
        devicePixelRatio: 2,
      },
    });

    const bundle = makeBundle({
      steps: [step],
      events: [before, after, manual],
      blobKeys: ['blob-before', 'blob-after', 'blob-manual'],
    });

    const model = buildTestCaseExportModel(bundle);

    expect(model.scope).toBe('test-case');
    expect(model.identity.sessionId).toBe('sess-1');
    expect(model.identity.testCaseName).toBe('Buy widget');
    expect(model.summary.steps).toBe(1);
    expect(model.summary.findings).toBeGreaterThan(0);
    expect(model.selectedEvidence.length).toBeGreaterThan(0);
    expect(model.canonical.sections[0]?.steps[0]?.annotations.length).toBeGreaterThan(0);
  });

  it('keeps negative-test semantics and does not invent verdict logic', () => {
    const session = makeSession({ negativeTest: 'yes', testResult: 'blocked', status: 'blocked', testType: 'Negative' });
    const model = buildTestCaseExportModel(makeBundle({ session }));

    expect(model.identity.negativeTest).toBe('yes');
    expect(model.verdict.testResult).toBe('blocked');
    expect(model.verdict.status).toBe('blocked');
  });

  it('marks missing evidence honestly when blob is unavailable', () => {
    const before = makeEvidenceStored({ id: 'ev-before', blobKey: 'blob-before', ts: 2_000, trigger: 'user_action' });
    const missingAfter = makeEvidenceStored({ id: 'ev-after', blobKey: 'blob-missing', ts: 2_400, trigger: 'user_action_after' });

    const step = makeStep({
      id: 'step-1',
      index: 1,
      ts: 2_000,
      beforeEvidenceEventId: before.id,
      afterEvidenceEventId: missingAfter.id,
    });

    const model = buildTestCaseExportModel(makeBundle({
      steps: [step],
      events: [before, missingAfter],
      blobKeys: ['blob-before'],
    }));

    expect(model.summary.missingEvidence).toBeGreaterThan(0);
    expect(model.selectedEvidence.some((item) => item.missing)).toBe(true);
  });

  it('supports empty executions without crashing', () => {
    const model = buildTestCaseExportModel(makeBundle());
    expect(model.summary.steps).toBe(0);
    expect(model.summary.findings).toBe(0);
    expect(model.selectedEvidence).toEqual([]);
  });
});

describe('scope-models — feature scope', () => {
  it('aggregates multiple test cases and status distribution', () => {
    const passRun = makeBundle({
      session: makeSession({ id: 'sess-pass', testCaseName: 'Login', testCaseId: 'TC-10', status: 'pass', testResult: 'pass', startedAt: 1_000 }),
    });
    const failRun = makeBundle({
      session: makeSession({ id: 'sess-fail', testCaseName: 'Checkout', testCaseId: 'TC-20', status: 'fail', testResult: 'fail', startedAt: 2_000 }),
    });
    const blockedRun = makeBundle({
      session: makeSession({ id: 'sess-blocked', testCaseName: 'Search', testCaseId: 'TC-30', status: 'blocked', testResult: 'blocked', startedAt: 3_000 }),
    });

    const model = buildFeatureExportModel({
      featureName: 'Storefront',
      bundles: [passRun, failRun, blockedRun],
      nowMs: 9_999,
    });

    expect(model.scope).toBe('feature');
    expect(model.runCount).toBe(3);
    expect(model.testCaseCount).toBe(3);
    expect(model.statusCounts.pass).toBe(1);
    expect(model.statusCounts.fail).toBe(1);
    expect(model.statusCounts.blocked).toBe(1);
    expect(model.resultCounts.pass).toBe(1);
    expect(model.resultCounts.fail).toBe(1);
    expect(model.resultCounts.blocked).toBe(1);
  });

  it('deduplicates repeated test-case names and tracks runCount per case', () => {
    const older = makeBundle({
      session: makeSession({ id: 'sess-old', testCaseName: 'Checkout', status: 'fail', testResult: 'fail', startedAt: 1_000 }),
    });
    const latest = makeBundle({
      session: makeSession({ id: 'sess-latest', testCaseName: 'Checkout', status: 'pass', testResult: 'pass', startedAt: 2_000 }),
    });

    const model = buildFeatureExportModel({ featureName: 'Storefront', bundles: [older, latest] });

    expect(model.runCount).toBe(2);
    expect(model.testCases).toHaveLength(1);
    expect(model.testCases[0]?.runCount).toBe(2);
    expect(model.testCases[0]?.latestSessionId).toBe('sess-latest');
  });

  it('aggregates findings and avoids exploding duplicates', () => {
    const ev1 = makeEvidenceStored({ id: 'ev-1', blobKey: 'blob-1', ts: 1_500, sessionId: 'sess-1' });
    const ev2 = makeEvidenceStored({ id: 'ev-2', blobKey: 'blob-2', ts: 2_500, sessionId: 'sess-2' });

    const run1 = makeBundle({
      session: makeSession({ id: 'sess-1', testCaseName: 'Checkout', testResult: 'fail', status: 'fail', startedAt: 1_000 }),
      events: [ev1],
      blobKeys: ['blob-1'],
    });
    const run2 = makeBundle({
      session: makeSession({ id: 'sess-2', testCaseName: 'Checkout', testResult: 'fail', status: 'fail', startedAt: 2_000 }),
      events: [ev2],
      blobKeys: ['blob-2'],
    });

    const model = buildFeatureExportModel({ featureName: 'Storefront', bundles: [run1, run2] });
    const totalRawFindings = model.renderModel.findings.length;

    expect(totalRawFindings).toBeGreaterThan(0);
    expect(model.aggregatedFindings.length).toBeLessThanOrEqual(totalRawFindings);
    expect(model.aggregatedFindings.every((item) => item.affectedTestCases.length > 0)).toBe(true);
  });

  it('selects supporting evidence without dumping every screenshot', () => {
    const runs: SessionExportBundle[] = [];
    for (let i = 0; i < 30; i += 1) {
      const event = makeEvidenceStored({
        id: `ev-${i}`,
        blobKey: `blob-${i}`,
        ts: 1_000 + i,
        sessionId: `sess-${i}`,
      });
      runs.push(makeBundle({
        session: makeSession({
          id: `sess-${i}`,
          testCaseName: `Case ${i}`,
          status: i % 3 === 0 ? 'fail' : 'pass',
          testResult: i % 3 === 0 ? 'fail' : 'pass',
          startedAt: 1_000 + i,
        }),
        events: [event],
        blobKeys: [`blob-${i}`],
      }));
    }

    const model = buildFeatureExportModel({ featureName: 'Storefront', bundles: runs });

    expect(model.selectedEvidence.length).toBeGreaterThan(0);
    expect(model.selectedEvidence.length).toBeLessThanOrEqual(24);
  });

  it('preserves negative-test flag at test-case summary level', () => {
    const negativeRun = makeBundle({
      session: makeSession({
        id: 'sess-neg',
        testCaseName: 'Invalid card flow',
        negativeTest: 'yes',
        testType: 'Negative',
        status: 'pass',
        testResult: 'pass',
      }),
    });

    const model = buildFeatureExportModel({ featureName: 'Payments', bundles: [negativeRun] });

    expect(model.testCases[0]?.latestNegativeTest).toBe('yes');
  });

  it('preserves per-test-case section boundaries in feature canonical render model', () => {
    const stepA1 = makeStep({ id: 'a-step-1', index: 1, ts: 1_100, sessionId: 'sess-a' as never });
    const stepA2 = makeStep({ id: 'a-step-2', index: 2, ts: 1_200, sessionId: 'sess-a' as never });
    const stepB1 = makeStep({ id: 'b-step-1', index: 1, ts: 2_100, sessionId: 'sess-b' as never });

    const caseA = makeBundle({
      session: makeSession({ id: 'sess-a', testCaseName: 'Checkout happy path', status: 'pass', testResult: 'pass', startedAt: 1_000 }),
      steps: [stepA1, stepA2],
    });
    const caseB = makeBundle({
      session: makeSession({ id: 'sess-b', testCaseName: 'Checkout declined card', status: 'fail', testResult: 'fail', startedAt: 2_000 }),
      steps: [stepB1],
    });

    const model = buildFeatureExportModel({ featureName: 'Checkout', bundles: [caseA, caseB] });

    expect(model.renderModel.sections).toHaveLength(2);
    expect(model.renderModel.sections[0]?.title).toBe('Checkout happy path');
    expect(model.renderModel.sections[1]?.title).toBe('Checkout declined card');
    expect(model.renderModel.sections[0]?.steps).toHaveLength(2);
    expect(model.renderModel.sections[1]?.steps).toHaveLength(1);
    expect(model.renderModel.sections[0]?.steps[0]?.action.label).toBe('Step 1');
  });

  it('throws a clear error when feature has no runs', () => {
    expect(() => buildFeatureExportModel({ featureName: 'Empty', bundles: [] })).toThrowError(
      'Feature export failed: no runs were available for export.',
    );
  });

  it('does not degrade into N full test-case reports', () => {
    const duplicateRuns = [
      makeBundle({ session: makeSession({ id: 'sess-a', testCaseName: 'Checkout', startedAt: 1_000 }) }),
      makeBundle({ session: makeSession({ id: 'sess-b', testCaseName: 'Checkout', startedAt: 2_000 }) }),
      makeBundle({ session: makeSession({ id: 'sess-c', testCaseName: 'Search', startedAt: 3_000 }) }),
    ];

    const model = buildFeatureExportModel({ featureName: 'Storefront', bundles: duplicateRuns });

    expect(model.runCount).toBe(3);
    expect(model.testCaseCount).toBe(2);
    expect(model.testCases.map((item) => item.testCaseName)).toEqual(['Checkout', 'Search']);
  });
});
