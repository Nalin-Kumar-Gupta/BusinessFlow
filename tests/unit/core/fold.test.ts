import { describe, it, expect } from 'vitest';
import { foldRequest, groupByRequest } from '../../../src/core/fold.js';
import { buildReport } from '../../../src/core/correlation.js';
import type { NetPhaseEvent, Session, TestEvent } from '../../../src/core/types.js';
import { EVENT_SCHEMA_VERSION } from '../../../src/core/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePhase(
  overrides: Partial<NetPhaseEvent> & { phase: NetPhaseEvent['phase'] },
): NetPhaseEvent {
  return {
    id: `ev-${Math.random().toString(36).slice(2)}`,
    sessionId: 'sess-1',
    ts: 1000,
    seq: 1,
    kind: 'net_phase',
    tabId: 1,
    confidence: 'observed',
    requestId: 'req-1',
    method: 'GET',
    url: 'https://example.com/api',
    resourceType: 'xmlhttprequest',
    droppedHeaderCount: 0,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    testCaseName: 'Smoke test',
    mode: 'guided',
    negativeTest: 'no',
    negativeTestSource: 'default',
    recordingState: 'stopped',
    startedAt: 900,
    scopeOrigins: ['https://example.com/*'],
    environment: {
      userAgent: 'Test/1.0',
      chromeVersion: '120',
      platform: 'MacIntel',
      extVersion: '0.1.0',
      timeZone: 'UTC',
    },
    counters: {
      events: 0, networkRequests: 0, httpErrors: 0, networkErrors: 0,
      consoleErrors: 0, consoleWarns: 0, pageErrors: 0,
      screenshots: 0, manualCaptures: 0, rageClicks: 0,
    },
    schemaVersion: EVENT_SCHEMA_VERSION,
    testResult: 'in_progress',
    apiSlaSec: 3,
    ...overrides,
  };
}

// ─── groupByRequest ──────────────────────────────────────────────────────────

describe('groupByRequest', () => {
  it('groups net_phase events by requestId', () => {
    const start = makePhase({ phase: 'start', requestId: 'req-A', seq: 1 });
    const complete = makePhase({ phase: 'complete', requestId: 'req-A', seq: 3 });
    const other = makePhase({ phase: 'start', requestId: 'req-B', seq: 2 });

    const map = groupByRequest([start, other, complete]);

    expect(map.size).toBe(2);
    expect(map.get('req-A')).toHaveLength(2);
    expect(map.get('req-B')).toHaveLength(1);
  });

  it('sorts phases within a group by seq', () => {
    const p1 = makePhase({ phase: 'complete', seq: 5 });
    const p2 = makePhase({ phase: 'start', seq: 1 });
    const [first, second] = groupByRequest([p1, p2]).get('req-1') ?? [];
    expect(first?.seq).toBe(1);
    expect(second?.seq).toBe(5);
  });

  it('ignores non-net_phase events', () => {
    const nav: TestEvent = {
      kind: 'navigation', id: 'n1', sessionId: 'sess-1', ts: 1, seq: 1,
      tabId: 1, confidence: 'observed', url: '/', isSpaRouteChange: false,
    };
    expect(groupByRequest([nav]).size).toBe(0);
  });
});

// ─── foldRequest ─────────────────────────────────────────────────────────────

describe('foldRequest', () => {
  it('folds a successful request (start -> complete)', () => {
    const start = makePhase({ phase: 'start', ts: 1000, seq: 1 });
    const complete = makePhase({
      phase: 'complete', ts: 1250, seq: 3,
      statusCode: 200, statusLine: 'HTTP/1.1 200 OK',
    });

    const view = foldRequest([start, complete]);

    expect(view.outcome).toBe('success');
    expect(view.statusCode).toBe(200);
    expect(view.durationMs).toBe(250);
    expect(view.origin).toBe('https://example.com');
    expect(view.path).toBe('/api');
  });

  it('marks outcome as http_error for 4xx/5xx', () => {
    const start = makePhase({ phase: 'start', seq: 1 });
    const complete = makePhase({ phase: 'complete', seq: 2, statusCode: 404 });
    expect(foldRequest([start, complete]).outcome).toBe('http_error');
  });

  it('marks outcome as network_error for error phase', () => {
    const start = makePhase({ phase: 'start', seq: 1 });
    const error = makePhase({ phase: 'error', seq: 2, errorText: 'net::ERR_CONNECTION_REFUSED' });
    expect(foldRequest([start, error]).outcome).toBe('network_error');
  });

  it('marks outcome as pending when only the start phase exists', () => {
    // A service-worker death between phases must degrade to 'pending',
    // never to a false 'success'.
    const start = makePhase({ phase: 'start', seq: 1 });
    expect(foldRequest([start]).outcome).toBe('pending');
  });

  it('throws on empty phases array', () => {
    expect(() => foldRequest([])).toThrow();
  });
});

// ─── buildReport: findings ───────────────────────────────────────────────────

describe('buildReport findings', () => {
  it('produces an HTTP_ERROR finding for a 500 response', () => {
    const start = makePhase({ phase: 'start', seq: 1, id: 'ev-start' });
    const complete = makePhase({ phase: 'complete', seq: 2, id: 'ev-complete', statusCode: 500 });

    const report = buildReport(makeSession(), [start, complete]);

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.type).toBe('HTTP_ERROR');
    expect(report.findings[0]?.disposition).toBe('observed-failure');
    expect(report.findings[0]?.severity).toBe('critical');
  });

  it('marks a 4xx as expected-negative when explicitly configured for negative tests', () => {
    const start = makePhase({ phase: 'start', seq: 1 });
    const complete = makePhase({ phase: 'complete', seq: 2, statusCode: 400 });

    const report = buildReport(makeSession({
      negativeTest: 'yes',
      negativeExpectations: { httpStatuses: [400] },
    }), [start, complete]);

    expect(report.findings[0]?.disposition).toBe('expected-negative');
    expect(report.findings[0]?.severity).toBe('info');
  });

  it('keeps 4xx as unexpected when not listed in negative-test expectations', () => {
    const start = makePhase({ phase: 'start', seq: 1 });
    const complete = makePhase({ phase: 'complete', seq: 2, statusCode: 400 });

    const report = buildReport(makeSession({
      negativeTest: 'yes',
      negativeExpectations: { httpStatuses: [401] },
    }), [start, complete]);

    expect(report.findings[0]?.disposition).toBe('observed-failure');
    expect(report.findings[0]?.severity).toBe('high');
  });

  it('supports expected 401 and expected 500 negative semantics explicitly', () => {
    const authStart = makePhase({ id: 'auth-start', requestId: 'req-auth', phase: 'start', seq: 1 });
    const authDone = makePhase({ id: 'auth-done', requestId: 'req-auth', phase: 'complete', seq: 2, statusCode: 401 });
    const crashStart = makePhase({ id: 'crash-start', requestId: 'req-crash', phase: 'start', seq: 3 });
    const crashDone = makePhase({ id: 'crash-done', requestId: 'req-crash', phase: 'complete', seq: 4, statusCode: 500 });

    const report = buildReport(makeSession({
      negativeTest: 'yes',
      negativeExpectations: { httpStatuses: [401, 500] },
    }), [authStart, authDone, crashStart, crashDone]);

    expect(report.findings.map((f) => f.disposition)).toEqual(['expected-negative', 'expected-negative']);
    expect(report.findings.map((f) => f.severity)).toEqual(['info', 'info']);
  });

  it('marks console/page errors as expected only when UI signal token matches', () => {
    const err: TestEvent = {
      id: 'ce-1', sessionId: 'sess-1', ts: 1200, seq: 1,
      kind: 'console_error', tabId: 1, confidence: 'observed',
      message: 'Validation error: invalid email format',
    };

    const expected = buildReport(makeSession({
      negativeTest: 'yes',
      negativeExpectations: { uiSignals: ['validation error'] },
    }), [err]);
    expect(expected.findings[0]?.disposition).toBe('expected-negative');

    const unexpected = buildReport(makeSession({
      negativeTest: 'yes',
      negativeExpectations: { uiSignals: ['permission denied'] },
    }), [err]);
    expect(unexpected.findings[0]?.disposition).toBe('observed-failure');
  });

  it('produces no findings for successful requests', () => {
    const start = makePhase({ phase: 'start', seq: 1 });
    const complete = makePhase({ phase: 'complete', seq: 2, statusCode: 200 });

    expect(buildReport(makeSession(), [start, complete]).findings).toHaveLength(0);
  });

  it('attaches a screenshot to the finding that triggered it', () => {
    // REGRESSION: triggerEventId exists only on evidence_requested. Correlation
    // must resolve stored -> requested -> trigger. When this indirection broke,
    // every finding silently rendered with zero screenshots.
    const start = makePhase({ phase: 'start', seq: 1, id: 'ev-start' });
    const complete = makePhase({ phase: 'complete', seq: 2, id: 'ev-complete', statusCode: 500 });

    const requested: TestEvent = {
      id: 'ev-req', sessionId: 'sess-1', ts: 1300, seq: 3,
      kind: 'evidence_requested', tabId: 1, confidence: 'observed',
      trigger: 'http_error', triggerEventId: 'ev-complete',
    };
    const stored: TestEvent = {
      id: 'ev-stored', sessionId: 'sess-1', ts: 1400, seq: 4,
      kind: 'evidence_stored', tabId: 1, confidence: 'observed',
      requestedEventId: 'ev-req', trigger: 'http_error',
      blobKey: 'blob:1', width: 800, height: 600, bytes: 1234,
      format: 'image/jpeg',
    };

    const report = buildReport(makeSession(), [start, complete, requested, stored]);

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.evidence).toHaveLength(1);
    expect(report.findings[0]?.evidence[0]?.blobKey).toBe('blob:1');
  });

  it('infers a preceding click without asserting causation', () => {
    const click: TestEvent = {
      id: 'ev-click', sessionId: 'sess-1', ts: 950, seq: 1,
      kind: 'user_click', tabId: 1, confidence: 'observed',
      selector: 'button#pay', tagName: 'BUTTON', text: 'Pay',
    };
    const start = makePhase({ phase: 'start', ts: 1000, seq: 2 });
    const complete = makePhase({ phase: 'complete', ts: 1200, seq: 3, statusCode: 500 });

    const report = buildReport(makeSession(), [click, start, complete]);
    const link = report.findings[0]?.likelyPrecededBy;

    expect(link?.eventId).toBe('ev-click');
    expect(link?.gapMs).toBe(50);
    // The relationship must be labelled inferred, never stated as causal.
    expect(link?.confidence).toMatch(/^inferred-/);
    expect(link?.rationale ?? '').not.toMatch(/caused|because|due to|triggered by/i);
  });
});
