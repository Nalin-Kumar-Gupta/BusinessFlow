import { describe, expect, it } from 'vitest';

import type { CanonicalExportModel } from '../../../src/export/model/canonical.js';
import { buildClipboardEvidenceView } from '../../../src/ui/export/clipboard/clipboard-view-model.js';
import { renderClipboardEvidence } from '../../../src/ui/export/clipboard/render-clipboard.js';

function canonicalFixture(): CanonicalExportModel {
  return {
    schemaVersion: 1,
    meta: {
      generatedAt: 1,
      generatedBy: { product: 'BusinessFlow', version: '1.0.0' },
      sessionId: 'sess-1',
      correlationVersion: 1,
    },
    overview: {
      featureName: 'Checkout',
      testCaseName: 'Payment decline',
      negativeTest: 'yes',
      status: 'fail',
      testResult: 'fail',
      verdictSummary: 'Fail — checkout shows server error after submit.',
      testerNotes: 'Using sandbox card to reproduce.',
    },
    environment: {
      startedAt: 1000,
      endedAt: 2000,
      durationMs: 1000,
      userAgent: 'UA',
      chromeVersion: '128',
      platform: 'mac',
      extVersion: '0.1.0',
      timeZone: 'UTC',
      viewport: { width: 1280, height: 720, dpr: 2 },
      scopeOrigins: ['https://example.com'],
      apiSlaSec: 3,
    },
    stats: {
      steps: 1,
      stepsWithBugs: 1,
      stepsNoStateChange: 0,
      bugs: 1,
      findings: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
      network: { total: 1, failed: 1, slowOverSla: 0, thirdParty: 0 },
      console: { errors: 1, warnings: 0, pageErrors: 0 },
      userSignals: { clicks: 1, rageClicks: 0, manualCaptures: 1, screenshots: 2 },
      performance: undefined,
    },
    sections: [
      {
        id: 'default',
        steps: [
          {
            id: 'step-1',
            sourceStepId: 'step-1',
            index: 1,
            timestamp: 1100,
            action: { label: 'Submit payment', clickCount: 1 },
            beforeEvidence: {
              blobKey: 'blob-1',
              mimeType: 'image/jpeg',
              capturedAt: 1101,
              width: 1200,
              height: 800,
              triggerConfidence: 'observed',
              sourceEventId: 'ev-1',
              missing: false,
            },
            systemEvidence: [],
            annotations: [
              { kind: 'pin', target: 'before', note: 'Error banner appears here', sourceKind: 'note', sourceId: 'note-1' },
            ],
            noVisibleChange: false,
            testerNotes: [{ id: 'note-1', text: 'Error banner says try later', hasPin: true }],
            bugs: [{ id: 'bug-1', description: 'Submission fails unexpectedly', hasPin: false }],
            correlated: {
              failedRequests: [{
                requestId: 'r1',
                method: 'POST',
                url: 'https://example.com/api/checkout?token=secret',
                origin: 'https://example.com',
                path: '/api/checkout',
                statusCode: 500,
                outcome: 'http_error',
                startedAt: 1120,
                resourceType: 'fetch',
                temporalDeltaMs: 320,
              }],
              slowRequests: [],
              consoleErrors: [{ eventId: 'ce-1', kind: 'console_error', message: 'Unhandled rejection', timestamp: 1130 }],
              pageErrors: [],
              rageClicks: 0,
            },
          },
        ],
      },
    ],
    findings: [
      {
        id: 'f1',
        severity: 'high',
        type: 'HTTP_ERROR',
        disposition: 'observed-failure',
        status: 'open',
        summary: 'POST /api/checkout returned HTTP 500',
        timestamp: 1130,
        seq: 1,
        stepIndex: 1,
        relatedEvidence: [],
        relatedEventIds: ['r1'],
        temporalDeltaFromClickMs: 320,
        correlationClaim: 'observed_around_same_time',
      },
    ],
    appendix: {
      network: [],
      consoleWarnings: [],
      performance: { webVitals: [], pageTimings: [], longTasks: [], memorySnapshots: [] },
      domMetrics: [],
      cspViolations: [],
      checkpoints: [],
      navigationHistory: [],
      captureTimeline: { pausedAt: [], resumedAt: [] },
    },
  };
}

describe('clipboard evidence projection', () => {
  it('builds a concise story-first view model', () => {
    const view = buildClipboardEvidenceView(canonicalFixture());

    expect(view.verdict).toBe('FAIL');
    expect(view.isFeatureScope).toBe(false);
    expect(view.isNegativeTest).toBe(true);
    expect(view.steps).toHaveLength(1);
    expect(view.evidence[0]?.label).toBe('Step 1');
    expect(view.findings[0]?.temporalNote).toContain('after the action');
    expect(view.technicalEvidence.join('\n')).toContain('/api/checkout');
  });

  it('keeps chronological context for failed runs instead of only bug step', () => {
    const original = canonicalFixture();
    const baseStep = original.sections[0]!.steps[0]!;
    const fixture: CanonicalExportModel = {
      ...original,
      sections: [{
        id: 'default',
        steps: [
          {
            ...baseStep,
            id: 'step-1',
            sourceStepId: 'step-1',
            index: 1,
            action: { label: 'Open checkout page', clickCount: 1 },
            bugs: [],
            testerNotes: [],
            correlated: { ...baseStep.correlated, failedRequests: [], consoleErrors: [], pageErrors: [] },
          },
          {
            ...baseStep,
            id: 'step-2',
            sourceStepId: 'step-2',
            index: 2,
            action: { label: 'Enter card details', clickCount: 1 },
            bugs: [],
            testerNotes: [],
            correlated: { ...baseStep.correlated, failedRequests: [], consoleErrors: [], pageErrors: [] },
          },
          {
            ...baseStep,
            id: 'step-3',
            sourceStepId: 'step-3',
            index: 3,
            action: { label: 'Submit payment', clickCount: 1 },
            bugs: [{ id: 'bug-3', description: 'Payment failed', hasPin: false }],
          },
        ],
      }],
    };

    const view = buildClipboardEvidenceView(fixture);
    expect(view.steps.map((step) => step.index)).toEqual([1, 2, 3]);
  });

  it('for long failed runs includes a full context window not only the anchor step', () => {
    const original = canonicalFixture();
    const baseStep = original.sections[0]!.steps[0]!;
    const longSteps = Array.from({ length: 20 }, (_, index) => ({
      ...baseStep,
      id: `step-${index + 1}`,
      sourceStepId: `step-${index + 1}`,
      index: index + 1,
      action: { label: `Step action ${index + 1}`, clickCount: 1 },
      bugs: index === 0 ? [{ id: 'bug-early', description: 'Early failure', hasPin: false }] : [],
      testerNotes: [],
      correlated: {
        ...baseStep.correlated,
        failedRequests: index === 0 ? baseStep.correlated.failedRequests : [],
        consoleErrors: [],
        pageErrors: [],
      },
    }));

    const fixture: CanonicalExportModel = {
      ...original,
      sections: [{ id: 'default', steps: longSteps }],
    };

    const view = buildClipboardEvidenceView(fixture);
    expect(view.steps.length).toBe(12);
    expect(view.steps[0]?.index).toBe(1);
    expect(view.steps[11]?.index).toBe(12);
  });

  it('for feature scope includes a test-case result matrix instead of a flattened step list', () => {
    const base = canonicalFixture();
    const featureModel: CanonicalExportModel = {
      ...base,
      meta: { ...base.meta, sessionId: 'feature:Checkout:1' },
      overview: { ...base.overview, featureName: 'Checkout', testCaseName: 'All test cases (2)' },
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
        base.findings[0]!,
        { ...base.findings[0]!, id: 'f2', stepIndex: 2, summary: 'checkout failed in case 2' },
      ],
    };

    const view = buildClipboardEvidenceView(featureModel);
    const rendered = renderClipboardEvidence(view, () => 'data:image/jpeg;base64,abc');

    expect(view.isFeatureScope).toBe(true);
    expect(view.steps).toHaveLength(0);
    expect(view.testCaseResults).toHaveLength(2);
    expect(rendered.html).toContain('Test case results');
    expect(rendered.text).toContain('Checkout happy path');
    expect(rendered.text).toContain('Checkout declined card');
  });

  it('renders html + plain-text output with screenshot references', () => {
    const view = buildClipboardEvidenceView(canonicalFixture());
    const rendered = renderClipboardEvidence(view, (blobKey) => (blobKey === 'blob-1' ? 'data:image/jpeg;base64,abc' : undefined));

    expect(rendered.html).toContain('<h3>Execution steps</h3>');
    expect(rendered.html).toContain('<img src="data:image/jpeg;base64,abc"');
    expect(rendered.html).toContain('width="450"');
    expect(rendered.html).toContain('height="300"');
    expect(rendered.html).toContain('<strong>Step 1</strong>');
    expect(rendered.html).not.toContain('>BEFORE<');
    expect(rendered.text).toContain('Findings:');
    expect(rendered.text).toContain('image attached in rich paste when supported');
  });

  it('uses bounded width with auto height when intrinsic screenshot size is unavailable', () => {
    const fixture = canonicalFixture();
    const step = fixture.sections[0]?.steps[0];
    if (!step?.beforeEvidence) throw new Error('Fixture missing beforeEvidence');

    delete (step.beforeEvidence as { width?: number }).width;
    delete (step.beforeEvidence as { height?: number }).height;

    const view = buildClipboardEvidenceView(fixture);
    const rendered = renderClipboardEvidence(view, () => 'data:image/jpeg;base64,abc');

    expect(rendered.html).toContain('width: 450px; height: 396px;');
    expect(rendered.html).toContain('max-height: 396px;');
  });
});
