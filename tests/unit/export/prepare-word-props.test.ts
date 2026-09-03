import { describe, expect, it } from 'vitest';

import type { CanonicalExportModel } from '../../../src/export/model/canonical.js';
import { prepareWordProps } from '../../../src/ui/export/word/prepare-word-props.js';

function fixture(overrides: Partial<CanonicalExportModel> = {}): CanonicalExportModel {
  const base: CanonicalExportModel = {
    schemaVersion: 1,
    meta: {
      generatedAt: 60_000,
      generatedBy: { product: 'BusinessFlow', version: '1.0.0' },
      sessionId: 'sess-42',
      correlationVersion: 1,
    },
    overview: {
      featureName: 'Checkout',
      testCaseName: 'Declined card path',
      testCaseId: 'TC-401',
      testType: 'Negative',
      negativeTest: 'yes',
      status: 'fail',
      testResult: 'fail',
      verdictSummary: 'Fail — 1 bug, 1 failed request',
      testerNotes: 'Customer receives generic error copy.',
      negativeAssertions: [
        { channel: 'http', expected: 'HTTP 401', observed: 'HTTP 401', verdict: 'pass' },
      ],
    },
    environment: {
      startedAt: 1_000,
      endedAt: 3_000,
      durationMs: 2_000,
      userAgent: 'UA',
      chromeVersion: '127',
      platform: 'MacIntel',
      extVersion: '1.0.0',
      timeZone: 'UTC',
      viewport: { width: 1440, height: 900, dpr: 2 },
      scopeOrigins: ['https://shop.example.com'],
      apiSlaSec: 3,
    },
    stats: {
      steps: 1,
      stepsWithBugs: 1,
      stepsNoStateChange: 0,
      bugs: 1,
      findings: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
      network: { total: 2, failed: 1, slowOverSla: 0, thirdParty: 0 },
      console: { errors: 1, warnings: 0, pageErrors: 0 },
      userSignals: { clicks: 1, rageClicks: 0, manualCaptures: 0, screenshots: 2 },
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
            action: {
              label: 'Click Submit payment',
              pageUrl: 'https://shop.example.com/checkout',
              clickCount: 1,
            },
            beforeEvidence: {
              blobKey: 'blob-before',
              mimeType: 'image/jpeg',
              capturedAt: 1_150,
              triggerConfidence: 'observed',
              sourceEventId: 'ev-before',
              missing: false,
            },
            afterEvidence: {
              blobKey: 'blob-after',
              mimeType: 'image/jpeg',
              capturedAt: 1_260,
              triggerConfidence: 'observed',
              sourceEventId: 'ev-after',
              missing: true,
            },
            systemEvidence: [],
            annotations: [
              {
                kind: 'pin',
                target: 'after',
                xPercent: 33,
                yPercent: 44,
                sourceKind: 'bug',
                sourceId: 'bug-1',
                note: 'Error toast overlaps footer',
              },
            ],
            noVisibleChange: false,
            testerNotes: [{ id: 'note-1', text: 'Validation is too generic.', hasPin: false }],
            bugs: [{ id: 'bug-1', description: 'Server error copy shown to user.', hasPin: true }],
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
                temporalDeltaMs: 40,
              }],
              slowRequests: [],
              consoleErrors: [{
                eventId: 'ce-1',
                kind: 'console_error',
                message: 'Auth failed',
                timestamp: 1_245,
              }],
              pageErrors: [],
              rageClicks: 0,
            },
          },
        ],
      },
    ],
    findings: [
      {
        id: 'finding-1',
        severity: 'critical',
        type: 'HTTP_ERROR',
        disposition: 'observed-failure',
        status: 'open',
        summary: 'HTTP 401 POST /api/pay',
        timestamp: 1_240,
        seq: 10,
        stepIndex: 1,
        relatedEvidence: [],
        relatedEventIds: ['ev-http'],
        correlationClaim: 'observed_around_same_time',
      },
    ],
    appendix: {
      network: [{
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
      consoleWarnings: [],
      performance: {
        webVitals: [],
        pageTimings: [],
        longTasks: [],
        memorySnapshots: [],
      },
      domMetrics: [],
      cspViolations: [],
      checkpoints: [],
      navigationHistory: [],
      captureTimeline: { pausedAt: [], resumedAt: [] },
    },
  };

  return { ...base, ...overrides };
}

describe('prepareWordProps', () => {
  it('maps canonical hierarchy into review-oriented sections', () => {
    const view = prepareWordProps(fixture(), {
      resolve(blobKey: string): string | undefined {
        return blobKey === 'blob-before' ? 'data:image/jpeg;base64,abc' : undefined;
      },
    });

    expect(view.cover.reportTitle).toBe('QA Test Report');
    expect(view.testIdentity.some((row) => row.key === 'Test Case' && row.value === 'Declined card path')).toBe(true);
    expect(view.verdict.statusLabel).toBe('FAIL');
    expect(view.executionStory).toHaveLength(1);
    expect(view.findings[0]?.summary).toContain('HTTP 401');
  });

  it('keeps screenshots optional and counts missing screenshots for graceful export', () => {
    const view = prepareWordProps(fixture(), {
      resolve(blobKey: string): string | undefined {
        return blobKey === 'blob-before' ? 'data:image/jpeg;base64,abc' : undefined;
      },
    });

    const step = view.executionStory[0];
    expect(step?.before.dataUrl).toContain('data:image/jpeg;base64,abc');
    expect(step?.before.widthPx).toBeUndefined();
    expect(step?.after?.dataUrl).toBeUndefined();
    expect(step?.after?.annotations[0]).toContain('bug pin');
    expect(step?.linkedFindings[0]).toContain('CRITICAL');
    expect(view.missingScreenshotCount).toBe(1);
  });

  it('omits after screenshot panel when a step has no after evidence', () => {
    const base = fixture();
    const model = fixture({
      sections: [{
        ...base.sections[0]!,
        steps: [{
          ...base.sections[0]!.steps[0]!,
          afterEvidence: undefined,
        }],
      }],
    });

    const view = prepareWordProps(model, { resolve: () => undefined });
    expect(view.executionStory[0]?.after).toBeUndefined();
  });

  it('keeps technical evidence compact (failed/slow requests only)', () => {
    const model = fixture({
      appendix: {
        ...fixture().appendix,
        network: [
          ...fixture().appendix.network,
          {
            requestId: 'req-ok',
            method: 'GET',
            url: 'https://shop.example.com/api/profile',
            origin: 'https://shop.example.com',
            path: '/api/profile',
            statusCode: 200,
            outcome: 'success',
            startedAt: 1_260,
            resourceType: 'fetch',
          },
        ],
      },
    });

    const view = prepareWordProps(model, { resolve: () => undefined });
    expect(view.technicalEvidence.failedOrSlowRequests).toHaveLength(1);
    expect(view.technicalEvidence.failedOrSlowRequests[0]?.request).toContain('/api/pay');
  });

  it('switches identity labels for feature-scope exports and keeps case sections separated', () => {
    const base = fixture();
    const model = fixture({
      meta: { ...base.meta, sessionId: 'feature:Checkout:1' },
      overview: {
        ...base.overview,
        testCaseName: 'All test cases (2)',
      },
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
    });

    const view = prepareWordProps(model, { resolve: () => undefined });
    expect(view.cover.reportTitle).toBe('QA Feature Report');
    expect(view.testIdentity.some((row) => row.key === 'Test Cases')).toBe(true);
    expect(view.featureSummary?.rows).toHaveLength(2);
    expect(view.testCaseSections).toHaveLength(2);
    expect(view.executionStory).toHaveLength(0);
    expect(view.appendix.some((row) => row.label === 'Feature Export ID')).toBe(true);
  });
});
