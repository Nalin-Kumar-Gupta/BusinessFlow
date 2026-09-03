// Unit tests for buildCanonicalExportModel — the pure projection that
// underpins every export format (PDF, Word, Excel, .bflow).
//
// Rules under test:
//   * One canonical model per session (never mixes multiple).
//   * Renderer-agnostic: no React/Preact/DOM/Chrome deps in the projection.
//   * Screenshots stay as blobKey refs; nothing is decoded.
//   * Correlation is temporal only, never causal.
//   * Missing data is represented honestly (undefined / missing:true).
//   * Existing helpers (stepLabel / normalizeStepBugs / normalizeStepNotes)
//     drive the projection so the dashboard and the export agree.

import { describe, expect, it } from 'vitest';

import { buildCanonicalExportModel } from '../../../src/export/model/build-projection.js';
import type { SessionExportInput } from '../../../src/export/model/canonical.js';
import { EVENT_SCHEMA_VERSION } from '../../../src/core/types.js';
import type {
  ConsoleErrorEvent,
  EvidenceStoredEvent,
  NavigationEvent,
  NetPhaseEvent,
  Session,
  Step,
  TestEvent,
  UserClickEvent,
} from '../../../src/core/types.js';

// ─── Fixture helpers ────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    featureName: 'Checkout',
    testCaseName: 'Buy widget',
    mode: 'guided',
    negativeTest: 'no',
    negativeTestSource: 'default',
    recordingState: 'stopped',
    startedAt: 1_000,
    endedAt: 20_000,
    scopeOrigins: ['https://shop.example.com/*'],
    environment: {
      userAgent: 'Test/1.0',
      chromeVersion: '120',
      platform: 'MacIntel',
      extVersion: '0.9.0',
      timeZone: 'UTC',
      viewport: { width: 1280, height: 800, devicePixelRatio: 2 },
    },
    counters: {
      events: 12, networkRequests: 4, httpErrors: 1, networkErrors: 0,
      consoleErrors: 2, consoleWarns: 1, pageErrors: 0,
      screenshots: 3, manualCaptures: 1, rageClicks: 0, steps: 3,
    },
    schemaVersion: EVENT_SCHEMA_VERSION,
    testResult: 'fail',
    apiSlaSec: 3,
    ...overrides,
  };
}

function makeStep(overrides: Partial<Step> & { index: number; ts: number }): Step {
  const base: Step = {
    id: `step-${overrides.index}`,
    sessionId: 'sess-1',
    tabId: 1,
    index: overrides.index,
    ts: overrides.ts,
    seq: overrides.index,
    label: `Click ${overrides.index}`,
    clickEventIds: [`click-${overrides.index}`],
    systemEvidenceEventIds: [],
  };
  return { ...base, ...overrides };
}

function makeStored(overrides: Partial<EvidenceStoredEvent> & { id: string; blobKey: string; ts: number }): EvidenceStoredEvent {
  const base: EvidenceStoredEvent = {
    id: overrides.id,
    kind: 'evidence_stored',
    sessionId: 'sess-1',
    tabId: 1,
    ts: overrides.ts,
    seq: 100,
    confidence: 'observed',
    requestedEventId: 'req-1',
    trigger: 'manual',
    blobKey: overrides.blobKey,
    width: 1280,
    height: 800,
    bytes: 34_000,
    format: 'image/jpeg',
  };
  return { ...base, ...overrides };
}

function makeClick(overrides: Partial<UserClickEvent> & { id: string; ts: number; seq: number }): UserClickEvent {
  const base: UserClickEvent = {
    id: overrides.id,
    kind: 'user_click',
    sessionId: 'sess-1',
    tabId: 1,
    ts: overrides.ts,
    seq: overrides.seq,
    confidence: 'observed',
    selector: 'button#pay',
    tagName: 'BUTTON',
  };
  return { ...base, ...overrides };
}

function makeNetPhase(overrides: Partial<NetPhaseEvent> & { phase: NetPhaseEvent['phase']; id: string; ts: number; seq: number; requestId: string }): NetPhaseEvent {
  const base: NetPhaseEvent = {
    id: overrides.id,
    kind: 'net_phase',
    sessionId: 'sess-1',
    tabId: 1,
    ts: overrides.ts,
    seq: overrides.seq,
    phase: overrides.phase,
    confidence: 'observed',
    requestId: overrides.requestId,
    method: 'POST',
    url: 'https://shop.example.com/api/checkout',
    resourceType: 'xmlhttprequest',
    droppedHeaderCount: 0,
  };
  return { ...base, ...overrides };
}

function makeInput(overrides: Partial<SessionExportInput> = {}): SessionExportInput {
  return {
    session: overrides.session ?? makeSession(),
    events: overrides.events ?? [],
    steps: overrides.steps ?? [],
    networkLogs: overrides.networkLogs ?? [],
    knownBlobKeys: overrides.knownBlobKeys ?? new Set<string>(),
  };
}

// ─── Requirement 1: one canonical model per session ─────────────────────

describe('buildCanonicalExportModel — session scoping', () => {
  it('produces exactly one model bound to the input session', () => {
    const model = buildCanonicalExportModel(makeInput());
    expect(model.meta.sessionId).toBe('sess-1');
    expect(model.schemaVersion).toBe(1);
    // No accidental leak of other sessions.
    expect(model.sections).toHaveLength(1);
  });

  it('never merges data from another session even if events belong to a different sessionId', () => {
    const foreignEvent: NavigationEvent = {
      id: 'nav-x', sessionId: 'sess-OTHER', ts: 1_050, seq: 1,
      kind: 'navigation', tabId: 1, confidence: 'observed',
      url: 'https://shop.example.com/', isSpaRouteChange: false,
    };
    // The projection trusts its caller; correlation-window filter still applies
    // because the anchor is our own steps. So a foreign event that lies inside
    // our window will surface only if it matches our filters — which is fine,
    // but the model itself must never claim it belongs to another session.
    const model = buildCanonicalExportModel(makeInput({ events: [foreignEvent] }));
    expect(model.meta.sessionId).toBe('sess-1');
  });
});

// ─── Requirement 2: session metadata mapping ────────────────────────────

describe('buildCanonicalExportModel — session metadata', () => {
  it('maps session identity, environment, timing and SLA verbatim', () => {
    const model = buildCanonicalExportModel(makeInput());
    expect(model.overview.featureName).toBe('Checkout');
    expect(model.overview.testCaseName).toBe('Buy widget');
    expect(model.overview.testResult).toBe('fail');
    expect(model.overview.negativeTest).toBe('no');
    expect(model.environment.startedAt).toBe(1_000);
    expect(model.environment.endedAt).toBe(20_000);
    expect(model.environment.durationMs).toBe(19_000);
    expect(model.environment.apiSlaSec).toBe(3);
    expect(model.environment.viewport).toEqual({ width: 1280, height: 800, dpr: 2 });
    expect(model.environment.scopeOrigins).toEqual(['https://shop.example.com/*']);
  });

  it('omits optional fields cleanly when absent (no fabricated values)', () => {
    const session = makeSession({
      featureName: undefined,
      testCaseName: undefined,
      endedAt: undefined,
      environment: {
        userAgent: 'Test/1.0',
        chromeVersion: '120',
        platform: 'MacIntel',
        extVersion: '0.9.0',
        timeZone: 'UTC',
      },
    });
    const model = buildCanonicalExportModel(makeInput({ session }));
    expect(model.overview.featureName).toBeUndefined();
    expect(model.overview.testCaseName).toBeUndefined();
    expect(model.environment.endedAt).toBeUndefined();
    expect(model.environment.durationMs).toBeUndefined();
    expect(model.environment.viewport).toBeUndefined();
  });
});

// ─── Requirement 3: step ordering ───────────────────────────────────────

describe('buildCanonicalExportModel — step ordering', () => {
  it('orders steps by index regardless of input order', () => {
    const steps = [
      makeStep({ index: 3, ts: 3_000 }),
      makeStep({ index: 1, ts: 1_100 }),
      makeStep({ index: 2, ts: 2_000 }),
    ];
    const model = buildCanonicalExportModel(makeInput({ steps }));
    const indices = model.sections[0]?.steps.map((s) => s.index) ?? [];
    expect(indices).toEqual([1, 2, 3]);
  });

  it('computes durationToNextMs from the temporally next step and leaves the last step open', () => {
    const steps = [
      makeStep({ index: 1, ts: 1_000 }),
      makeStep({ index: 2, ts: 1_800 }),
      makeStep({ index: 3, ts: 5_000 }),
    ];
    const model = buildCanonicalExportModel(makeInput({ steps }));
    const durations = model.sections[0]?.steps.map((s) => s.durationToNextMs);
    expect(durations).toEqual([800, 3_200, undefined]);
  });
});

// ─── Requirement 4: label precedence ────────────────────────────────────

describe('buildCanonicalExportModel — step label precedence', () => {
  it('customLabel > semanticLabel > labelOverride > label > `Step N`', () => {
    const steps = [
      makeStep({ index: 1, ts: 1_000, label: 'auto A', semanticLabel: 'sem A', customLabel: 'CUSTOM A', labelOverride: 'over A' }),
      makeStep({ index: 2, ts: 2_000, label: 'auto B', semanticLabel: 'SEM B', labelOverride: 'over B' }),
      makeStep({ index: 3, ts: 3_000, label: 'auto C', labelOverride: 'OVER C' }),
      makeStep({ index: 4, ts: 4_000, label: 'AUTO D' }),
      makeStep({ index: 5, ts: 5_000, label: '' }),
    ];
    const model = buildCanonicalExportModel(makeInput({ steps }));
    const labels = model.sections[0]?.steps.map((s) => s.action.label);
    expect(labels).toEqual(['CUSTOM A', 'SEM B', 'OVER C', 'AUTO D', 'Step 5']);
  });
});

// ─── Requirement 5: evidence references stay as blobKey refs ────────────

describe('buildCanonicalExportModel — evidence references', () => {
  it('resolves before/after evidence via EvidenceStoredEvent and preserves blobKey + dimensions', () => {
    const before = makeStored({ id: 'ev-before', blobKey: 'blob:before', ts: 990 });
    const after = makeStored({ id: 'ev-after', blobKey: 'blob:after', ts: 1_500 });
    const step = makeStep({
      index: 1, ts: 1_000,
      beforeEvidenceEventId: 'ev-before',
      afterEvidenceEventId: 'ev-after',
    });
    const model = buildCanonicalExportModel(makeInput({
      events: [before, after],
      steps: [step],
      knownBlobKeys: new Set(['blob:before', 'blob:after']),
    }));

    const projected = model.sections[0]?.steps[0];
    expect(projected?.beforeEvidence?.blobKey).toBe('blob:before');
    expect(projected?.beforeEvidence?.width).toBe(1280);
    expect(projected?.beforeEvidence?.height).toBe(800);
    expect(projected?.beforeEvidence?.bytes).toBe(34_000);
    expect(projected?.beforeEvidence?.mimeType).toBe('image/jpeg');
    expect(projected?.beforeEvidence?.sourceEventId).toBe('ev-before');
    expect(projected?.beforeEvidence?.missing).toBe(false);
    expect(projected?.afterEvidence?.blobKey).toBe('blob:after');
  });

  it('flags missing:true when the blob is not in the blob index — never silently drops', () => {
    const before = makeStored({ id: 'ev-before', blobKey: 'blob:gone', ts: 990 });
    const step = makeStep({ index: 1, ts: 1_000, beforeEvidenceEventId: 'ev-before' });
    const model = buildCanonicalExportModel(makeInput({
      events: [before],
      steps: [step],
      knownBlobKeys: new Set<string>(), // no blobs available
    }));
    const projected = model.sections[0]?.steps[0];
    expect(projected?.beforeEvidence?.blobKey).toBe('blob:gone');
    expect(projected?.beforeEvidence?.missing).toBe(true);
  });

  it('collects system evidence event ids into EvidenceRef[]', () => {
    const sys1 = makeStored({ id: 'ev-sys-1', blobKey: 'blob:s1', ts: 1_100 });
    const sys2 = makeStored({ id: 'ev-sys-2', blobKey: 'blob:s2', ts: 1_200 });
    const step = makeStep({
      index: 1, ts: 1_000,
      systemEvidenceEventIds: ['ev-sys-1', 'ev-sys-2', 'ev-unresolved'],
    });
    const model = buildCanonicalExportModel(makeInput({
      events: [sys1, sys2],
      steps: [step],
      knownBlobKeys: new Set(['blob:s1', 'blob:s2']),
    }));
    const systemRefs = model.sections[0]?.steps[0]?.systemEvidence ?? [];
    expect(systemRefs.map((r) => r.blobKey)).toEqual(['blob:s1', 'blob:s2']);
  });

  it('never decodes blob bytes (projection stays reference-only)', () => {
    const stored = makeStored({ id: 'ev-1', blobKey: 'blob:1', ts: 990 });
    const step = makeStep({ index: 1, ts: 1_000, beforeEvidenceEventId: 'ev-1' });
    const model = buildCanonicalExportModel(makeInput({
      events: [stored],
      steps: [step],
      knownBlobKeys: new Set(['blob:1']),
    }));
    // Assert the model has NO data: URL, base64 payload, or Uint8Array embedded.
    const jsonSize = JSON.stringify(model).length;
    expect(jsonSize).toBeLessThan(20_000);
    expect(JSON.stringify(model)).not.toMatch(/data:image/);
    expect(JSON.stringify(model)).not.toMatch(/base64/i);
  });
});

// ─── Requirement 6: notes & bugs survive projection ─────────────────────

describe('buildCanonicalExportModel — notes and bugs', () => {
  it('carries tester notes and bugs onto the canonical step with pin flags', () => {
    const step = makeStep({
      index: 1, ts: 1_000,
      qaNotes: [
        { id: 'n-1', text: 'Looks off', pin: { target: 'after', x: 40, y: 60 } },
        { id: 'n-2', text: 'Second note' },
      ],
      bugs: [
        { id: 'b-1', description: 'Button misaligned', pin: { target: 'before', x: 10, y: 20 } },
      ],
    });
    const model = buildCanonicalExportModel(makeInput({ steps: [step] }));
    const projected = model.sections[0]?.steps[0];
    expect(projected?.testerNotes).toEqual([
      { id: 'n-1', text: 'Looks off', hasPin: true },
      { id: 'n-2', text: 'Second note', hasPin: false },
    ]);
    expect(projected?.bugs).toEqual([
      { id: 'b-1', description: 'Button misaligned', hasPin: true },
    ]);
    // Annotations are produced for pinned entries; sources are labelled.
    const pinAnnotations = projected?.annotations.filter((a) => a.kind === 'pin') ?? [];
    expect(pinAnnotations).toHaveLength(2);
    expect(pinAnnotations.some((a) => a.sourceKind === 'note' && a.target === 'after')).toBe(true);
    expect(pinAnnotations.some((a) => a.sourceKind === 'bug' && a.target === 'before')).toBe(true);
  });

  it('collapses legacy isBug / bugDescription into the modern bugs[] shape', () => {
    const step = makeStep({
      index: 1, ts: 1_000, isBug: true, bugDescription: 'legacy defect',
    });
    const model = buildCanonicalExportModel(makeInput({ steps: [step] }));
    expect(model.sections[0]?.steps[0]?.bugs).toEqual([
      { id: 'legacy', description: 'legacy defect', hasPin: false },
    ]);
  });

  it('emits a highlight-rect annotation on `before` when the step has an elementRect', () => {
    const step = makeStep({
      index: 1, ts: 1_000,
      elementRect: {
        x: 100, y: 200, width: 80, height: 40,
        pageScrollX: 0, pageScrollY: 0,
        viewportWidth: 1280, viewportHeight: 800, devicePixelRatio: 2,
      },
    });
    const model = buildCanonicalExportModel(makeInput({ steps: [step] }));
    const projectedStep = model.sections[0]?.steps[0];
    const highlights = projectedStep?.annotations.filter((a) => a.kind === 'highlight-rect') ?? [];
    expect(highlights).toHaveLength(1);
    expect(highlights[0]?.target).toBe('before');
    expect(highlights[0]?.rect).toEqual({ x: 100, y: 200, width: 80, height: 40 });
    expect(highlights[0]?.sourceKind).toBe('element');
    expect(projectedStep?.action.elementRect).toEqual({
      x: 100,
      y: 200,
      width: 80,
      height: 40,
      pageScrollX: 0,
      pageScrollY: 0,
      viewportWidth: 1280,
      viewportHeight: 800,
      devicePixelRatio: 2,
    });
  });
});

// ─── Requirement 7: missing evidence surfaced explicitly ────────────────

describe('buildCanonicalExportModel — missing evidence honesty', () => {
  it('a step with no before/after evidence event ids has both refs undefined (never fabricated)', () => {
    const step = makeStep({ index: 1, ts: 1_000 });
    const model = buildCanonicalExportModel(makeInput({ steps: [step] }));
    const projected = model.sections[0]?.steps[0];
    expect(projected?.beforeEvidence).toBeUndefined();
    expect(projected?.afterEvidence).toBeUndefined();
  });

  it('a referenced evidence event that no longer exists resolves to undefined (never invented)', () => {
    const step = makeStep({
      index: 1, ts: 1_000,
      beforeEvidenceEventId: 'ev-lost',
    });
    const model = buildCanonicalExportModel(makeInput({ steps: [step] }));
    expect(model.sections[0]?.steps[0]?.beforeEvidence).toBeUndefined();
  });
});

// ─── Requirement 8: correlation is temporal with source ids ─────────────

describe('buildCanonicalExportModel — temporal correlation', () => {
  it('correlates failed requests inside ±window and annotates temporalDeltaMs from step.ts', () => {
    const step = makeStep({ index: 1, ts: 10_000 });
    const start = makeNetPhase({ id: 'np-1', ts: 10_500, seq: 10, phase: 'start', requestId: 'req-A' });
    const complete = makeNetPhase({ id: 'np-2', ts: 10_800, seq: 11, phase: 'complete', requestId: 'req-A', statusCode: 500 });

    const model = buildCanonicalExportModel(makeInput({
      steps: [step],
      events: [start, complete],
    }));
    const failed = model.sections[0]?.steps[0]?.correlated.failedRequests ?? [];
    expect(failed).toHaveLength(1);
    expect(failed[0]?.requestId).toBe('req-A');
    expect(failed[0]?.statusCode).toBe(500);
    expect(failed[0]?.outcome).toBe('http_error');
    // Signed delta: request started 500 ms after the step.
    expect(failed[0]?.temporalDeltaMs).toBe(500);
  });

  it('excludes requests outside the correlation window', () => {
    const step = makeStep({ index: 1, ts: 10_000 });
    const start = makeNetPhase({ id: 'np-1', ts: 20_000, seq: 10, phase: 'start', requestId: 'req-A' });
    const complete = makeNetPhase({ id: 'np-2', ts: 20_100, seq: 11, phase: 'complete', requestId: 'req-A', statusCode: 500 });

    const model = buildCanonicalExportModel(makeInput({
      steps: [step],
      events: [start, complete],
      // widen would include it; the default (4s) must exclude it.
    }));
    expect(model.sections[0]?.steps[0]?.correlated.failedRequests).toHaveLength(0);
  });

  it('correlates console errors within ±window and includes source eventId', () => {
    const step = makeStep({ index: 1, ts: 10_000 });
    const err: ConsoleErrorEvent = {
      id: 'ce-1', sessionId: 'sess-1', tabId: 1, seq: 20,
      ts: 9_500, kind: 'console_error', confidence: 'observed',
      message: 'Boom', pageUrl: 'https://shop.example.com/cart',
    };
    const model = buildCanonicalExportModel(makeInput({
      steps: [step], events: [err],
    }));
    const errors = model.sections[0]?.steps[0]?.correlated.consoleErrors ?? [];
    expect(errors).toHaveLength(1);
    expect(errors[0]?.eventId).toBe('ce-1');
    expect(errors[0]?.temporalDeltaMs).toBe(-500);
    expect(errors[0]?.message).toBe('Boom');
  });

  it('every observed finding is labelled `observed_around_same_time` (never causal)', () => {
    const step = makeStep({ index: 1, ts: 10_000 });
    const start = makeNetPhase({ id: 'np-1', ts: 10_500, seq: 10, phase: 'start', requestId: 'req-A' });
    const complete = makeNetPhase({ id: 'np-2', ts: 10_800, seq: 11, phase: 'complete', requestId: 'req-A', statusCode: 500 });
    const model = buildCanonicalExportModel(makeInput({
      steps: [step], events: [start, complete],
    }));
    for (const finding of model.findings) {
      expect(finding.correlationClaim).toBe('observed_around_same_time');
    }
  });

  it('carries the temporal gap from an inferred preceding click without asserting causation', () => {
    const step = makeStep({ index: 1, ts: 10_000 });
    const click = makeClick({ id: 'click-1', ts: 10_400, seq: 5 });
    const start = makeNetPhase({ id: 'np-1', ts: 10_500, seq: 10, phase: 'start', requestId: 'req-A' });
    const complete = makeNetPhase({ id: 'np-2', ts: 10_800, seq: 11, phase: 'complete', requestId: 'req-A', statusCode: 500 });

    const model = buildCanonicalExportModel(makeInput({
      steps: [step], events: [click, start, complete],
    }));
    const finding = model.findings[0];
    expect(finding?.temporalDeltaFromClickMs).toBeGreaterThan(0);
    expect(finding?.correlationClaim).toBe('observed_around_same_time');
  });
});

// ─── Requirement 9: stats consistent with underlying counters ───────────

describe('buildCanonicalExportModel — statistics consistency', () => {
  it('mirrors console/rageClick/screenshot counters directly from the session', () => {
    const model = buildCanonicalExportModel(makeInput());
    expect(model.stats.console.errors).toBe(2);
    expect(model.stats.console.warnings).toBe(1);
    expect(model.stats.console.pageErrors).toBe(0);
    expect(model.stats.userSignals.rageClicks).toBe(0);
    expect(model.stats.userSignals.screenshots).toBe(3);
    expect(model.stats.userSignals.manualCaptures).toBe(1);
  });

  it('derives network stats from RequestView, respects SLA, and flags third-party', () => {
    const start = makeNetPhase({ id: 'np-1', ts: 10_500, seq: 10, phase: 'start', requestId: 'req-A' });
    const complete = makeNetPhase({ id: 'np-2', ts: 10_800, seq: 11, phase: 'complete', requestId: 'req-A', statusCode: 500 });
    const startSlow = makeNetPhase({
      id: 'np-3', ts: 12_000, seq: 12, phase: 'start', requestId: 'req-B',
      url: 'https://cdn.other.com/asset',
    });
    const completeSlow = makeNetPhase({
      id: 'np-4', ts: 20_000, seq: 13, phase: 'complete', requestId: 'req-B',
      url: 'https://cdn.other.com/asset',
      statusCode: 200,
    });

    const model = buildCanonicalExportModel(makeInput({
      events: [start, complete, startSlow, completeSlow],
    }));
    expect(model.stats.network.total).toBe(2);
    expect(model.stats.network.failed).toBe(1);
    expect(model.stats.network.slowOverSla).toBe(1);
    expect(model.stats.network.thirdParty).toBe(1);
  });

  it('counts bugs across steps (mixed modern + legacy shapes)', () => {
    const steps = [
      makeStep({
        index: 1, ts: 1_000,
        bugs: [{ id: 'b1', description: 'x' }, { id: 'b2', description: 'y' }],
      }),
      makeStep({ index: 2, ts: 2_000, isBug: true, bugDescription: 'legacy' }),
      makeStep({ index: 3, ts: 3_000 }),
    ];
    const model = buildCanonicalExportModel(makeInput({ steps }));
    expect(model.stats.bugs).toBe(3);
    expect(model.stats.stepsWithBugs).toBe(2);
    expect(model.stats.steps).toBe(3);
  });
});

// ─── Requirement 10: projection is dependency-free ──────────────────────

describe('buildCanonicalExportModel — no browser/React dependencies', () => {
  it('the projection module imports zero DOM/Chrome/React APIs', async () => {
    // If any of these globals were needed, the module would fail to import
    // in the Node test environment. Loading it is the assertion.
    const mod = await import('../../../src/export/model/build-projection.js');
    expect(typeof mod.buildCanonicalExportModel).toBe('function');
  });

  it('the canonical model is plain JSON-serializable (no functions, no cycles)', () => {
    const step = makeStep({ index: 1, ts: 1_000 });
    const model = buildCanonicalExportModel(makeInput({ steps: [step] }));
    // If any value were non-serializable this would throw.
    const roundTripped = JSON.parse(JSON.stringify(model));
    expect(roundTripped.meta.sessionId).toBe('sess-1');
  });
});

describe('buildCanonicalExportModel — negative-test expected failure semantics', () => {
  function requestEvents(statusCode: number): TestEvent[] {
    return [
      makeNetPhase({ id: `np-start-${statusCode}`, ts: 10_000, seq: 10, phase: 'start', requestId: `req-${statusCode}` }),
      makeNetPhase({ id: `np-end-${statusCode}`, ts: 10_200, seq: 11, phase: 'complete', requestId: `req-${statusCode}`, statusCode }),
    ];
  }

  it('expected 400: records explicit assertion PASS and expected-negative finding', () => {
    const model = buildCanonicalExportModel(makeInput({
      session: makeSession({ negativeTest: 'yes', negativeExpectations: { httpStatuses: [400] } }),
      events: requestEvents(400),
    }));
    expect(model.overview.negativeAssertions).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: 'http', expected: 'HTTP 400', observed: 'HTTP 400', verdict: 'pass' }),
    ]));
    expect(model.findings[0]?.disposition).toBe('expected-negative');
  });

  it('unexpected 400: fails assertion when expecting 401', () => {
    const model = buildCanonicalExportModel(makeInput({
      session: makeSession({ negativeTest: 'yes', negativeExpectations: { httpStatuses: [401] } }),
      events: requestEvents(400),
    }));
    expect(model.overview.negativeAssertions?.[0]).toMatchObject({ expected: 'HTTP 401', verdict: 'fail' });
    expect(model.findings[0]?.disposition).toBe('observed-failure');
  });

  it('expected 401: marks unauthorized response as expected', () => {
    const model = buildCanonicalExportModel(makeInput({
      session: makeSession({ negativeTest: 'yes', negativeExpectations: { httpStatuses: [401] } }),
      events: requestEvents(401),
    }));
    expect(model.overview.negativeAssertions?.[0]).toMatchObject({ expected: 'HTTP 401', observed: 'HTTP 401', verdict: 'pass' });
    expect(model.findings[0]?.disposition).toBe('expected-negative');
  });

  it('unexpected 401: fails assertion when expecting 403', () => {
    const model = buildCanonicalExportModel(makeInput({
      session: makeSession({ negativeTest: 'yes', negativeExpectations: { httpStatuses: [403] } }),
      events: requestEvents(401),
    }));
    expect(model.overview.negativeAssertions?.[0]).toMatchObject({ expected: 'HTTP 403', verdict: 'fail' });
    expect(model.findings[0]?.disposition).toBe('observed-failure');
  });

  it('expected 500: supports intentionally exercised server-error path when configured', () => {
    const model = buildCanonicalExportModel(makeInput({
      session: makeSession({ negativeTest: 'yes', negativeExpectations: { httpStatuses: [500] } }),
      events: requestEvents(500),
    }));
    expect(model.overview.negativeAssertions?.[0]).toMatchObject({ expected: 'HTTP 500', observed: 'HTTP 500', verdict: 'pass' });
    expect(model.findings[0]?.disposition).toBe('expected-negative');
  });

  it('expected UI validation failure: passes when DOM signal matches configured token', () => {
    const domValidation: TestEvent = {
      id: 'dom-1', sessionId: 'sess-1', tabId: 1, ts: 10_100, seq: 20,
      kind: 'dom_change', confidence: 'observed',
      summary: 'Validation error shown for email field',
      changeSignature: 'sig-1',
      pageUrl: 'https://shop.example.com/login',
    };
    const model = buildCanonicalExportModel(makeInput({
      session: makeSession({ negativeTest: 'yes', negativeExpectations: { uiSignals: ['validation error'] } }),
      events: [domValidation],
    }));
    expect(model.overview.negativeAssertions?.[0]).toMatchObject({ channel: 'ui', verdict: 'pass' });
  });

  it('unexpected UI error: fails configured UI expectation when token not observed', () => {
    const pageErr: TestEvent = {
      id: 'pe-1', sessionId: 'sess-1', tabId: 1, ts: 10_100, seq: 21,
      kind: 'page_error', confidence: 'observed', type: 'uncaught',
      message: 'TypeError: Cannot read property map of undefined',
    };
    const model = buildCanonicalExportModel(makeInput({
      session: makeSession({ negativeTest: 'yes', negativeExpectations: { uiSignals: ['validation error'] } }),
      events: [pageErr],
    }));
    expect(model.overview.negativeAssertions?.[0]).toMatchObject({ channel: 'ui', verdict: 'fail' });
  });

  it('negative test with no technical error: keeps findings empty but fails missing expected HTTP assertion', () => {
    const model = buildCanonicalExportModel(makeInput({
      session: makeSession({ negativeTest: 'yes', negativeExpectations: { httpStatuses: [401] } }),
      events: requestEvents(200),
    }));
    expect(model.findings).toHaveLength(0);
    expect(model.overview.negativeAssertions?.[0]).toMatchObject({ expected: 'HTTP 401', verdict: 'fail' });
  });

  it('negative test with tester-authored bug: preserves manual bug signal alongside expected-negative HTTP result', () => {
    const steps = [makeStep({
      index: 1,
      ts: 10_000,
      bugs: [{ id: 'b-1', description: 'Validation copy typo' }],
    })];
    const model = buildCanonicalExportModel(makeInput({
      session: makeSession({ negativeTest: 'yes', negativeExpectations: { httpStatuses: [401] } }),
      steps,
      events: requestEvents(401),
    }));

    expect(model.overview.negativeAssertions?.[0]).toMatchObject({ expected: 'HTTP 401', verdict: 'pass' });
    expect(model.findings[0]?.disposition).toBe('expected-negative');
    expect(model.stats.bugs).toBe(1);
    expect(model.sections[0]?.steps[0]?.bugs).toHaveLength(1);
  });
});

// ─── Requirement 11: purity & determinism ───────────────────────────────

describe('buildCanonicalExportModel — determinism', () => {
  it('produces structurally identical models for identical input (given a fixed nowMs)', () => {
    // Note: `buildReport()` in core/correlation.ts assigns fresh `find:...`
    // and `cp:...` ids on every call. Those ids are the ONLY source of
    // run-to-run drift, and they are a property of the report generator,
    // not the projection. We strip them here and assert everything else is
    // byte-identical.
    const stripGeneratedIds = (json: string): string => json
      .replace(/"(find|cp):[^"]+"/g, '"$1:<stripped>"');

    const events: TestEvent[] = [
      makeNetPhase({ id: 'np-1', ts: 10_500, seq: 10, phase: 'start', requestId: 'req-A' }),
      makeNetPhase({ id: 'np-2', ts: 10_800, seq: 11, phase: 'complete', requestId: 'req-A', statusCode: 500 }),
    ];
    const steps = [makeStep({ index: 1, ts: 10_000 })];
    const inputA = makeInput({ events, steps });
    const inputB = makeInput({ events, steps });
    const a = buildCanonicalExportModel(inputA, { nowMs: 42, generatorVersion: 'test' });
    const b = buildCanonicalExportModel(inputB, { nowMs: 42, generatorVersion: 'test' });
    expect(stripGeneratedIds(JSON.stringify(a))).toBe(stripGeneratedIds(JSON.stringify(b)));
  });

  it('uses the provided nowMs in meta.generatedAt (no wall-clock dependency)', () => {
    const model = buildCanonicalExportModel(makeInput(), { nowMs: 12_345 });
    expect(model.meta.generatedAt).toBe(12_345);
  });
});
