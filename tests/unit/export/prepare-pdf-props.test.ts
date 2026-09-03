import { describe, expect, it } from 'vitest';

import type { CanonicalExportModel } from '../../../src/export/model/canonical.js';
import { preparePdfProps } from '../../../src/ui/export/pdf/prepare-pdf-props.js';

function modelFixture(overrides: Partial<CanonicalExportModel> = {}): CanonicalExportModel {
  const base: CanonicalExportModel = {
    schemaVersion: 1,
    meta: {
      generatedAt: 50_000,
      generatedBy: { product: 'BusinessFlow', version: '0.9.0' },
      sessionId: 'sess-1',
      correlationVersion: 1,
    },
    overview: {
      featureName: 'Checkout',
      testCaseName: 'Pay with card',
      testCaseId: 'TC-9',
      testType: 'Positive',
      negativeTest: 'no',
      status: 'fail',
      testResult: 'fail',
      verdictSummary: 'Fail — 1 bug, 1 failed request',
      testerNotes: 'Observed intermittent API 500.',
    },
    environment: {
      startedAt: 1_000,
      endedAt: 9_000,
      durationMs: 8_000,
      userAgent: 'UA',
      chromeVersion: '120',
      platform: 'MacIntel',
      extVersion: '0.9.0',
      timeZone: 'UTC',
      viewport: { width: 1280, height: 800, dpr: 2 },
      scopeOrigins: ['https://shop.example.com/*'],
      apiSlaSec: 3,
    },
    stats: {
      steps: 2,
      stepsWithBugs: 1,
      stepsNoStateChange: 1,
      bugs: 1,
      findings: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
      network: { total: 2, failed: 1, slowOverSla: 1, thirdParty: 0 },
      console: { errors: 1, warnings: 1, pageErrors: 1 },
      userSignals: { clicks: 2, rageClicks: 1, manualCaptures: 1, screenshots: 3 },
      performance: { lcpMs: 2500, fcpMs: 900, cls: 0.08, inpMs: 150, ttfbMs: 220 },
    },
    sections: [
      {
        id: 'default',
        steps: [
          {
            id: 'step-1',
            sourceStepId: 'step-1',
            index: 1,
            timestamp: 2_000,
            durationToNextMs: 1_000,
            action: { label: 'Click Add to Cart', clickCount: 1, pageUrl: 'https://shop.example.com/p/1' },
            beforeEvidence: {
              blobKey: 'blob:before',
              mimeType: 'image/jpeg',
              capturedAt: 1_900,
              triggerConfidence: 'observed',
              sourceEventId: 'ev-before',
              missing: false,
            },
            afterEvidence: {
              blobKey: 'blob:after',
              mimeType: 'image/jpeg',
              capturedAt: 2_200,
              triggerConfidence: 'observed',
              sourceEventId: 'ev-after',
              missing: true,
            },
            systemEvidence: [],
            annotations: [
              { kind: 'pin', target: 'after', xPercent: 40, yPercent: 60, sourceKind: 'note', sourceId: 'n1', note: 'spinner stuck' },
              { kind: 'pin', target: 'before', xPercent: 12, yPercent: 18, sourceKind: 'bug', sourceId: 'b1', note: 'wrong price' },
            ],
            noVisibleChange: true,
            testerNotes: [{ id: 'n1', text: 'spinner stuck', hasPin: true }],
            bugs: [{ id: 'b1', description: 'Price mismatch', hasPin: true }],
            correlated: {
              failedRequests: [{
                requestId: 'req-1', method: 'POST', url: 'https://shop.example.com/api/cart', origin: 'https://shop.example.com',
                path: '/api/cart', statusCode: 500, outcome: 'http_error', durationMs: 120, startedAt: 2_320,
                resourceType: 'xmlhttprequest', temporalDeltaMs: 320,
              }],
              slowRequests: [{
                requestId: 'req-2', method: 'GET', url: 'https://shop.example.com/api/catalog', origin: 'https://shop.example.com',
                path: '/api/catalog', statusCode: 200, outcome: 'success', durationMs: 5200, startedAt: 2_600,
                resourceType: 'fetch', temporalDeltaMs: 600,
              }],
              consoleErrors: [{ eventId: 'ce-1', kind: 'console_error', message: 'Boom', timestamp: 2_350, temporalDeltaMs: 350 }],
              pageErrors: [{ eventId: 'pe-1', kind: 'page_error', message: 'Script exploded', timestamp: 2_360, temporalDeltaMs: 360 }],
              navigation: { eventId: 'nav-1', url: 'https://shop.example.com/cart', isSpaRouteChange: true, timestamp: 2_400, temporalDeltaMs: 400 },
              rageClicks: 2,
            },
          },
          {
            id: 'step-2',
            sourceStepId: 'step-2',
            index: 2,
            timestamp: 3_000,
            action: { label: 'Click Checkout', clickCount: 1 },
            systemEvidence: [],
            annotations: [],
            noVisibleChange: false,
            testerNotes: [],
            bugs: [],
            correlated: { failedRequests: [], slowRequests: [], consoleErrors: [], pageErrors: [], rageClicks: 0 },
          },
        ],
      },
    ],
    findings: [
      {
        id: 'find-1',
        severity: 'critical',
        type: 'HTTP_ERROR',
        disposition: 'observed-failure',
        status: 'open',
        summary: 'HTTP 500 POST /api/cart',
        timestamp: 2_320,
        seq: 11,
        stepIndex: 1,
        relatedRequestId: 'req-1',
        relatedEvidence: [],
        relatedEventIds: ['ev-http'],
        temporalDeltaFromClickMs: 320,
        correlationClaim: 'observed_around_same_time',
      },
    ],
    appendix: {
      network: [
        {
          requestId: 'req-1', method: 'POST', url: 'https://shop.example.com/api/cart', origin: 'https://shop.example.com', path: '/api/cart',
          statusCode: 500, outcome: 'http_error', durationMs: 120, startedAt: 2_320, resourceType: 'xmlhttprequest',
        },
      ],
      consoleWarnings: [{ eventId: 'cw-1', kind: 'console_warn', message: 'slow ui', timestamp: 2_200 }],
      performance: {
        webVitals: [{ eventId: 'wv1', name: 'LCP', value: 2200, rating: 'needs-improvement', timestamp: 2_300 }],
        pageTimings: [{ eventId: 'pt1', ttfbMs: 200, domContentLoadedMs: 900, loadEventMs: 1400, redirectCount: 0, timestamp: 2_100 }],
        longTasks: [{ eventId: 'lt1', durationMs: 260, startTime: 88, timestamp: 2_400 }],
        memorySnapshots: [{ eventId: 'ms1', usedJSHeapSizeBytes: 100, totalJSHeapSizeBytes: 200, jsHeapSizeLimitBytes: 300, timestamp: 2_500 }],
      },
      domMetrics: [{ eventId: 'dm1', nodeCount: 1000, maxDepth: 20, ariaInvalidCount: 2, missingAltCount: 1, unlabelledInteractiveCount: 3, timestamp: 2_500 }],
      cspViolations: [{ eventId: 'csp1', violatedDirective: 'script-src', blockedURI: 'x', timestamp: 2_510 }],
      checkpoints: [{ id: 'cp-1', name: 'Cart Opened', source: 'manual', timestamp: 2_450 }],
      navigationHistory: [{ eventId: 'nav-1', url: 'https://shop.example.com/cart', isSpaRouteChange: true, timestamp: 2_400 }],
      captureTimeline: { pausedAt: [2_600], resumedAt: [2_700] },
      negativeInference: {
        confidence: 'inferred-low',
        signals: ['signal-a'],
        evidenceEventIds: ['ev1'],
        testerVerdict: 'confirmed',
      },
    },
  };
  return { ...base, ...overrides };
}

function resolver(map: Record<string, string>) {
  return { resolve: (blobKey: string) => map[blobKey] };
}

describe('preparePdfProps', () => {
  it('maps FAIL verdict to cover with high-visibility label/color', () => {
    const view = preparePdfProps(modelFixture(), resolver({ 'blob:before': 'data:image/jpeg;base64,abc' }));
    expect(view.cover.verdictLabel).toBe('FAIL');
    expect(view.cover.verdictColor).toBe('#c5221f');
    expect(view.cover.testCaseName).toBe('Pay with card');
  });

  it('keeps tester notes and negative-test banner when negativeTest=yes', () => {
    const model = modelFixture({
      overview: {
        ...modelFixture().overview,
        negativeTest: 'yes',
      },
    });
    const view = preparePdfProps(model, resolver({ 'blob:before': 'data:image/jpeg;base64,abc' }));
    expect(view.cover.testerNotes).toContain('intermittent API 500');
    expect(view.cover.negativeTestBanner).toContain('Negative test');
  });

  it('builds cover at-a-glance stats and top critical/high risks for leadership triage', () => {
    const view = preparePdfProps(modelFixture(), resolver({ 'blob:before': 'data:image/jpeg;base64,abc' }));
    expect(view.cover.atGlance).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Steps Tested', value: '2' }),
      expect.objectContaining({ label: 'Bugs', value: '1', emphasized: true }),
      expect.objectContaining({ label: 'Critical/High', value: '1', emphasized: true }),
      expect.objectContaining({ label: 'Failed Requests', value: '1', emphasized: true }),
    ]));
    expect(view.cover.topRisks[0]?.severityLabel).toBe('CRITICAL');
    expect(view.cover.topRisks[0]?.summary).toContain('HTTP 500');
    expect(view.cover.topRisks[0]?.stepReference).toContain('Step 1');
  });

  it('renders negative assertion matrix with expected/observed/verdict lines', () => {
    const model = modelFixture({
      overview: {
        ...modelFixture().overview,
        negativeTest: 'yes',
        negativeAssertions: [{
          channel: 'http',
          expected: 'HTTP 401',
          observed: 'HTTP 401',
          verdict: 'pass',
        }],
      },
    });
    const view = preparePdfProps(model, resolver({ 'blob:before': 'data:image/jpeg;base64,abc' }));
    expect(view.cover.negativeAssertions).toEqual([expect.objectContaining({
      channelLabel: 'HTTP',
      expected: 'HTTP 401',
      observed: 'HTTP 401',
      verdictLabel: 'PASS',
    })]);
  });


  it('adds status context banner for blocked or incomplete runs', () => {
    const blocked = preparePdfProps(modelFixture({
      overview: {
        ...modelFixture().overview,
        status: 'blocked',
      },
    }), resolver({ 'blob:before': 'data:image/jpeg;base64,abc' }));
    expect(blocked.cover.statusContextBanner).toContain('Blocked run');

    const incomplete = preparePdfProps(modelFixture({
      overview: {
        ...modelFixture().overview,
        status: 'draft',
      },
      environment: {
        ...modelFixture().environment,
        endedAt: undefined,
      },
    }), resolver({ 'blob:before': 'data:image/jpeg;base64,abc' }));
    expect(incomplete.cover.statusContextBanner).toContain('Incomplete run');
  });

  it('builds environment key/value rows only for available values', () => {
    const model = modelFixture({
      environment: {
        ...modelFixture().environment,
        endedAt: undefined,
        durationMs: undefined,
        viewport: undefined,
      },
    });
    const view = preparePdfProps(model, resolver({ 'blob:before': 'data:image/jpeg;base64,abc' }));
    expect(view.environment.some((e) => e.label === 'Ended')).toBe(false);
    expect(view.environment.some((e) => e.label === 'Duration')).toBe(false);
    expect(view.environment.some((e) => e.label === 'Viewport')).toBe(false);
  });

  it('emits execution stats including no-visible-change and performance vitals', () => {
    const view = preparePdfProps(modelFixture(), resolver({ 'blob:before': 'data:image/jpeg;base64,abc' }));
    expect(view.executionStats.some((s) => s.label === 'No Visible Change' && s.value === '1')).toBe(true);
    expect(view.executionStats.some((s) => s.label === 'LCP')).toBe(true);
    expect(view.executionStats.some((s) => s.label === 'CLS')).toBe(true);
  });

  it('keeps all steps in order and marks bug presence per step', () => {
    const view = preparePdfProps(modelFixture(), resolver({ 'blob:before': 'data:image/jpeg;base64,abc' }));
    expect(view.steps.map((s) => s.indexLabel)).toEqual(['Step 1', 'Step 2']);
    expect(view.steps[0]?.hasBug).toBe(true);
    expect(view.steps[1]?.hasBug).toBe(false);
  });

  it('labels finding disposition so expected-negative evidence is not read as a bug', () => {
    const model = modelFixture({
      findings: [{
        ...modelFixture().findings[0]!,
        disposition: 'expected-negative',
      }],
    });
    const view = preparePdfProps(model, resolver({ 'blob:before': 'data:image/jpeg;base64,abc' }));
    expect(view.findings[0]?.dispositionLabel).toContain('EXPECTED');
  });

  it('maps before/after evidence and reports missing screenshot count', () => {
    const view = preparePdfProps(modelFixture(), resolver({ 'blob:before': 'data:image/jpeg;base64,abc' }));
    expect(view.steps[0]?.beforeEvidence?.dataUrl).toContain('data:image/jpeg;base64,abc');
    expect(view.steps[0]?.afterEvidence?.missingReason).toBe('blob-lost');
    expect(view.missingScreenshotCount).toBe(1);
  });

  it('projects before-frame highlight geometry from element rect metadata', () => {
    const base = modelFixture();
    const firstStep = base.sections[0]!.steps[0]!;
    const model = modelFixture({
      sections: [{
        ...base.sections[0]!,
        steps: [{
          ...firstStep,
          action: {
            ...firstStep.action,
            elementRect: {
              x: 64,
              y: 120,
              width: 192,
              height: 80,
              pageScrollX: 0,
              pageScrollY: 200,
              viewportWidth: 1280,
              viewportHeight: 800,
              devicePixelRatio: 2,
            },
          },
          beforeEvidence: {
            ...firstStep.beforeEvidence!,
            width: 2560,
            height: 1600,
          },
        }, ...base.sections[0]!.steps.slice(1)],
      }],
    });

    const view = preparePdfProps(model, resolver({ 'blob:before': 'data:image/jpeg;base64,abc' }));
    const before = view.steps[0]?.beforeEvidence;
    expect(before?.highlightRect).toEqual({
      xPercent: 5,
      yPercent: 15,
      widthPercent: 15,
      heightPercent: 10,
    });
    expect(before?.imageWidthPx).toBe(2560);
    expect(before?.imageHeightPx).toBe(1600);
  });

  it('renders pinned annotations as numbered pins + legend entries', () => {
    const view = preparePdfProps(modelFixture(), resolver({ 'blob:before': 'data:image/jpeg;base64,abc' }));
    const step = view.steps[0];
    expect(step?.annotationLegend).toHaveLength(2);
    expect(step?.beforeEvidence?.pins[0]?.number).toBe(2);
    expect(step?.afterEvidence?.pins[0]?.number).toBe(1);
  });

  it('preserves no-visible-change statement flag for step rendering', () => {
    const view = preparePdfProps(modelFixture(), resolver({ 'blob:before': 'data:image/jpeg;base64,abc' }));
    expect(view.steps[0]?.noVisibleChange).toBe(true);
  });

  it('keeps tester notes and bugs separate with optional pin references', () => {
    const view = preparePdfProps(modelFixture(), resolver({ 'blob:before': 'data:image/jpeg;base64,abc' }));
    const step = view.steps[0];
    expect(step?.notes[0]?.text).toBe('spinner stuck');
    expect(step?.bugs[0]?.description).toBe('Price mismatch');
    expect(step?.notes[0]?.pinNumber).toBeDefined();
    expect(step?.bugs[0]?.pinNumber).toBeDefined();
  });

  it('formats correlated failed request line with temporal-only wording', () => {
    const view = preparePdfProps(modelFixture(), resolver({ 'blob:before': 'data:image/jpeg;base64,abc' }));
    const lines = view.steps[0]?.correlated.map((c) => c.text).join(' ');
    expect(lines).toContain('approximately 320 ms after the action');
    expect(lines).not.toMatch(/caused|triggered|resulted in/i);
  });

  it('surfaces correlated console and page errors near the step', () => {
    const view = preparePdfProps(modelFixture(), resolver({ 'blob:before': 'data:image/jpeg;base64,abc' }));
    const lines = view.steps[0]?.correlated.map((c) => c.text) ?? [];
    expect(lines.some((line) => line.includes('Console error'))).toBe(true);
    expect(lines.some((line) => line.includes('Page error'))).toBe(true);
    expect(view.steps[0]?.stepFindings[0]?.summary).toContain('HTTP 500');
  });

  it('prioritizes findings by severity (critical first) and includes step reference', () => {
    const model = modelFixture({
      findings: [
        ...modelFixture().findings,
        {
          id: 'find-2', severity: 'critical', type: 'CONSOLE_WARN', disposition: 'observed-failure', status: 'open', summary: 'critical observed', timestamp: 2_331, seq: 13,
          relatedEvidence: [], relatedEventIds: ['ev'], correlationClaim: 'observed_around_same_time',
        },
        {
          id: 'find-3', severity: 'critical', type: 'CONSOLE_WARN', disposition: 'tester-marked', status: 'open', summary: 'critical tester marked', timestamp: 2_332, seq: 14,
          stepIndex: 1,
          relatedEvidence: [], relatedEventIds: ['ev'], correlationClaim: 'observed_around_same_time',
        },
      ],
    });
    const view = preparePdfProps(model, resolver({ 'blob:before': 'data:image/jpeg;base64,abc' }));
    expect(view.findings[0]?.severity).toBe('critical');
    expect(view.findings[0]?.summary).toContain('tester marked');
    expect(view.findings[0]?.stepReference).toContain('Step 1');
  });

  it('maps appendix network/console/navigation/vitals/checkpoints/capture timeline', () => {
    const view = preparePdfProps(modelFixture(), resolver({ 'blob:before': 'data:image/jpeg;base64,abc' }));
    expect(view.appendix.network).toHaveLength(1);
    expect(view.appendix.consoleWarnings).toHaveLength(1);
    expect(view.appendix.navigationHistory).toHaveLength(1);
    expect(view.appendix.webVitals).toHaveLength(1);
    expect(view.appendix.checkpoints).toHaveLength(1);
    expect(view.appendix.captureTimeline.pauses).toBe(1);
    expect(view.appendix.captureTimeline.resumes).toBe(1);
  });

  it('keeps negative inference details in appendix when present', () => {
    const view = preparePdfProps(modelFixture(), resolver({ 'blob:before': 'data:image/jpeg;base64,abc' }));
    expect(view.appendix.negativeInference?.confidenceLabel).toContain('inferred low');
    expect(view.appendix.negativeInference?.signals).toEqual(['signal-a']);
  });

  it('handles many-step sessions without dropping step sections', () => {
    const manyStepsModel = modelFixture({
      sections: [{
        id: 'default',
        steps: Array.from({ length: 50 }, (_, i) => ({
          id: `s-${i + 1}`,
          sourceStepId: `s-${i + 1}`,
          index: i + 1,
          timestamp: 2_000 + i * 50,
          action: { label: `Action ${i + 1}`, clickCount: 1 },
          systemEvidence: [],
          annotations: [],
          noVisibleChange: false,
          testerNotes: [],
          bugs: [],
          correlated: { failedRequests: [], slowRequests: [], consoleErrors: [], pageErrors: [], rageClicks: 0 },
        })),
      }],
    });
    const view = preparePdfProps(manyStepsModel, resolver({}));
    expect(view.steps).toHaveLength(50);
    expect(view.steps[49]?.indexLabel).toBe('Step 50');
  });

  it('remains deterministic for fixed formatter + resolver inputs', () => {
    const model = modelFixture();
    const fmt = (ts: number): string => `T${ts}`;
    const a = preparePdfProps(model, resolver({ 'blob:before': 'X' }), { formatDateTime: fmt, formatDuration: fmt });
    const b = preparePdfProps(model, resolver({ 'blob:before': 'X' }), { formatDateTime: fmt, formatDuration: fmt });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('uses feature terminology and keeps test-case boundaries for aggregated exports', () => {
    const base = modelFixture();
    const model = modelFixture({
      meta: { ...base.meta, sessionId: 'feature:Checkout:42' },
      overview: { ...base.overview, testCaseName: 'All test cases (2)' },
      sections: [
        {
          id: 'case-1',
          title: 'Checkout happy path',
          status: 'pass',
          testResult: 'pass',
          sourceSessionId: 'sess-a',
          startedAt: 1_000,
          steps: [base.sections[0]!.steps[0]!],
        },
        {
          id: 'case-2',
          title: 'Checkout declined card',
          status: 'fail',
          testResult: 'fail',
          sourceSessionId: 'sess-b',
          startedAt: 2_000,
          steps: [base.sections[0]!.steps[1]!],
        },
      ],
    });

    const view = preparePdfProps(model, resolver({ 'blob:before': 'data:image/jpeg;base64,abc' }));
    expect(view.cover.reportTitle).toBe('QA Feature Report');
    expect(view.cover.identity.some((entry) => entry.label === 'Feature Export ID')).toBe(true);
    expect(view.featureSummary?.matrix).toHaveLength(2);
    expect(view.testCaseSections).toHaveLength(2);
    expect(view.testCaseSections?.[0]?.title).toBe('Checkout happy path');
    expect(view.testCaseSections?.[1]?.title).toBe('Checkout declined card');
    expect(view.steps).toHaveLength(0);
  });
});
