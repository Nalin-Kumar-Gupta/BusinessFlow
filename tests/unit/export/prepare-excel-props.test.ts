import { describe, expect, it } from 'vitest';

import type { CanonicalExportModel } from '../../../src/export/model/canonical.js';
import { prepareExcelProps } from '../../../src/ui/export/excel/prepare-excel-props.js';

function fixture(): CanonicalExportModel {
  return {
    schemaVersion: 1,
    meta: {
      generatedAt: 50_000,
      generatedBy: { product: 'BusinessFlow', version: '1.0.0' },
      sessionId: 'sess-x',
      correlationVersion: 1,
    },
    overview: {
      featureName: 'Checkout',
      testCaseName: 'Payment decline',
      testCaseId: 'TC-9',
      testType: 'Negative',
      negativeTest: 'yes',
      status: 'fail',
      testResult: 'fail',
      verdictSummary: 'Fail — 1 bug, 1 failed request',
    },
    environment: {
      startedAt: 1_000,
      endedAt: 5_000,
      durationMs: 4_000,
      userAgent: 'UA',
      scopeOrigins: ['https://shop.example.com'],
    },
    stats: {
      steps: 1,
      stepsWithBugs: 1,
      stepsNoStateChange: 0,
      bugs: 1,
      findings: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
      network: { total: 2, failed: 1, slowOverSla: 1, thirdParty: 1 },
      console: { errors: 1, warnings: 1, pageErrors: 0 },
      userSignals: { clicks: 1, rageClicks: 0, manualCaptures: 0, screenshots: 2 },
      performance: { lcpMs: 2100, fcpMs: 950, inpMs: 140, ttfbMs: 240 },
    },
    sections: [
      {
        id: 'default',
        steps: [
          {
            id: 'step-1',
            sourceStepId: 'step-1',
            index: 1,
            timestamp: 1_200,
            durationToNextMs: 800,
            action: { label: 'Click Submit', clickCount: 1, pageUrl: 'https://shop.example.com/checkout' },
            beforeEvidence: {
              blobKey: 'blob-before',
              mimeType: 'image/jpeg',
              capturedAt: 1_100,
              triggerConfidence: 'observed',
              sourceEventId: 'ev-before',
              missing: false,
            },
            afterEvidence: {
              blobKey: 'blob-after',
              mimeType: 'image/jpeg',
              capturedAt: 1_300,
              triggerConfidence: 'observed',
              sourceEventId: 'ev-after',
              missing: true,
            },
            systemEvidence: [],
            annotations: [],
            noVisibleChange: false,
            testerNotes: [{ id: 'n1', text: 'UI copy is unclear', hasPin: false }],
            bugs: [{ id: 'b1', description: 'Wrong error messaging', hasPin: false }],
            correlated: {
              failedRequests: [{
                requestId: 'req-1',
                method: 'POST',
                url: 'https://shop.example.com/api/pay',
                origin: 'https://shop.example.com',
                path: '/api/pay',
                statusCode: 401,
                outcome: 'http_error',
                durationMs: 220,
                startedAt: 1_240,
                resourceType: 'fetch',
              }],
              slowRequests: [],
              consoleErrors: [{ eventId: 'ce-1', kind: 'console_error', message: 'Auth fail', timestamp: 1_250 }],
              pageErrors: [],
              rageClicks: 0,
            },
          },
        ],
      },
    ],
    findings: [
      {
        id: 'f-1',
        severity: 'critical',
        type: 'HTTP_ERROR',
        disposition: 'observed-failure',
        status: 'open',
        summary: 'HTTP 401 POST /api/pay',
        timestamp: 1_240,
        seq: 8,
        stepIndex: 1,
        relatedEvidence: [],
        relatedEventIds: ['ev-http'],
        temporalDeltaFromClickMs: 40,
        correlationClaim: 'observed_around_same_time',
      },
    ],
    appendix: {
      network: [
        {
          requestId: 'req-1',
          method: 'POST',
          url: 'https://shop.example.com/api/pay',
          origin: 'https://shop.example.com',
          path: '/api/pay',
          statusCode: 401,
          outcome: 'http_error',
          durationMs: 220,
          startedAt: 1_240,
          resourceType: 'fetch',
          isThirdParty: false,
        },
        {
          requestId: 'req-2',
          method: 'GET',
          url: 'https://cdn.example.net/sdk.js',
          origin: 'https://cdn.example.net',
          path: '/sdk.js',
          statusCode: 200,
          outcome: 'success',
          durationMs: 3500,
          startedAt: 1_260,
          resourceType: 'script',
          isOverSla: true,
          isThirdParty: true,
        },
      ],
      consoleWarnings: [{ eventId: 'cw1', kind: 'console_warn', message: 'deprecated', timestamp: 1_230 }],
      performance: {
        webVitals: [{ eventId: 'wv1', name: 'LCP', value: 2100, rating: 'needs-improvement', timestamp: 1_280 }],
        pageTimings: [{ eventId: 'pt1', ttfbMs: 240, domContentLoadedMs: 980, loadEventMs: 1520, redirectCount: 0, timestamp: 1_290 }],
        longTasks: [{ eventId: 'lt1', durationMs: 180, startTime: 40, timestamp: 1_300 }],
        memorySnapshots: [],
      },
      domMetrics: [],
      cspViolations: [],
      checkpoints: [{ id: 'cp1', name: 'Submit', source: 'manual', timestamp: 1_210 }],
      navigationHistory: [{ eventId: 'nav1', url: 'https://shop.example.com/checkout', isSpaRouteChange: false, timestamp: 1_150 }],
      captureTimeline: { pausedAt: [], resumedAt: [] },
    },
  };
}

describe('prepareExcelProps', () => {
  it('builds summary and workflow sheets from canonical model', () => {
    const view = prepareExcelProps(fixture());
    expect(view.summary.rows.some((row) => row.metric === 'Failed Requests' && row.value === 1)).toBe(true);
    expect(view.steps).toHaveLength(1);
    expect(view.findings).toHaveLength(1);
    expect(view.technicalSignals.some((row) => row.signalType === 'failed-request')).toBe(true);
    expect(view.sessionMeta.some((row) => row.category === 'Navigation')).toBe(true);
  });

  it('normalizes network outcome categories for filtering', () => {
    const view = prepareExcelProps(fixture());
    const outcomes = new Set(view.network.map((row) => row.outcome));
    expect(outcomes.has('failed')).toBe(true);
    expect(outcomes.has('slow')).toBe(true);
    expect(outcomes.has('third-party')).toBe(false);
  });

  it('tracks evidence metadata without exposing blob identifiers', () => {
    const view = prepareExcelProps(fixture());
    expect(view.evidence.some((row) => row.kind === 'before')).toBe(true);
    expect(view.evidence.some((row) => row.missing)).toBe(true);
  });

  it('uses feature labels, per-case rows, and deterministic finding ordering for feature exports', () => {
    const base = fixture();
    const model: CanonicalExportModel = {
      ...base,
      meta: { ...base.meta, sessionId: 'feature:Checkout:1' },
      overview: { ...base.overview, testCaseName: 'All test cases (2)' },
      sections: [
        {
          ...base.sections[0]!,
          id: 'case-1',
          title: 'Checkout happy path',
          status: 'pass',
          testResult: 'pass',
          sourceSessionId: 'sess-a',
        },
        {
          ...base.sections[0]!,
          id: 'case-2',
          title: 'Checkout declined card',
          status: 'fail',
          testResult: 'fail',
          sourceSessionId: 'sess-b',
          steps: [{ ...base.sections[0]!.steps[0]!, id: 'step-2', sourceStepId: 'step-2', index: 2 }],
        },
      ],
      findings: [
        {
          ...base.findings[0]!,
          id: 'f-2',
          stepIndex: 2,
          summary: 'HTTP 500 POST /api/pay',
          disposition: 'tester-marked',
        },
        base.findings[0]!,
      ],
    };

    const view = prepareExcelProps(model);
    expect(view.summary.reportTitle).toBe('QA Feature Analysis Workbook');
    expect(view.summary.rows.some((row) => row.metric === 'Test Cases')).toBe(true);
    expect(view.featureCases).toHaveLength(2);
    expect(view.steps[0]?.testCase).toBeDefined();
    expect(view.findings[0]?.disposition).toBe('Tester Marked');
    expect(view.sessionMeta.some((row) => row.key === 'Feature Export ID')).toBe(true);
  });
});
