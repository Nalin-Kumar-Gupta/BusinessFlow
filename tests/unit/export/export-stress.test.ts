import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { EVENT_SCHEMA_VERSION } from '../../../src/core/types.js';
import type {
  ConsoleErrorEvent,
  EvidenceStoredEvent,
  NetworkLog,
  Session,
  Step,
  TestEvent,
  UserClickEvent,
} from '../../../src/core/types.js';
import { buildCanonicalExportModel } from '../../../src/export/model/build-projection.js';
import { exportBusinessFlowReportHtml } from '../../../src/ui/export/html-export.js';
import { QaReportPdf } from '../../../src/ui/export/pdf/QaReportPdf.js';
import { loadEvidenceBlobs } from '../../../src/ui/export/pdf/blob-loader.js';
import { preparePdfProps } from '../../../src/ui/export/pdf/prepare-pdf-props.js';

const mockState = {
  blobs: new Map<string, { data: Uint8Array; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' }>(),
  eventsBySession: new Map<string, TestEvent[]>(),
  getBlobCalls: 0,
  getEventsCalls: 0,
  blobBytesRead: 0,
  currentBlobReads: 0,
  maxConcurrentBlobReads: 0,
  blobDelayMs: 0,
};

vi.mock('../../../src/storage/db.js', () => ({
  getBlob: async (key: string) => {
    mockState.getBlobCalls += 1;
    mockState.currentBlobReads += 1;
    mockState.maxConcurrentBlobReads = Math.max(mockState.maxConcurrentBlobReads, mockState.currentBlobReads);
    if (mockState.blobDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, mockState.blobDelayMs));
    }

    const hit = mockState.blobs.get(key);
    mockState.currentBlobReads -= 1;
    if (!hit) return undefined;

    mockState.blobBytesRead += hit.data.byteLength;
    return {
      key,
      data: hit.data,
      mimeType: hit.mimeType,
      storedAt: Date.now(),
      sessionId: 'sess-stress',
    };
  },
  getEventsForSession: async (sessionId: string) => {
    mockState.getEventsCalls += 1;
    return mockState.eventsBySession.get(sessionId) ?? [];
  },
}));

const STEP_COUNTS = [10, 25, 50, 100, 200] as const;
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Zx5kAAAAASUVORK5CYII=';
const VALID_IMAGE_BYTES = new Uint8Array(Buffer.from(PNG_1X1, 'base64'));

interface Fixture {
  readonly session: Session;
  readonly steps: Step[];
  readonly events: TestEvent[];
  readonly networkLogs: NetworkLog[];
  readonly knownBlobKeys: Set<string>;
  readonly stepDraft: Array<{
    stepId: string;
    stepIndex: number;
    label: string;
    note: string;
    issuePills: string[];
    networkFailures: Array<{ method: string; url: string; statusCode: number | 'error'; durationMs?: number }>;
    consoleErrors: string[];
    afterEvidenceEventId?: string;
    beforeEvidenceEventId?: string;
  }>;
}

function resetMockState(): void {
  mockState.blobs.clear();
  mockState.eventsBySession.clear();
  mockState.getBlobCalls = 0;
  mockState.getEventsCalls = 0;
  mockState.blobBytesRead = 0;
  mockState.currentBlobReads = 0;
  mockState.maxConcurrentBlobReads = 0;
  mockState.blobDelayMs = 0;
}

function makeSession(stepCount: number): Session {
  const startedAt = 1_700_000_000_000;
  return {
    id: `sess-${stepCount}`,
    featureName: 'Checkout',
    testCaseName: `Stress ${stepCount}`,
    testCaseId: `TC-STRESS-${stepCount}`,
    mode: 'guided',
    negativeTest: 'no',
    negativeTestSource: 'default',
    recordingState: 'stopped',
    startedAt,
    endedAt: startedAt + stepCount * 4_500,
    scopeOrigins: ['https://shop.example.com/*'],
    environment: {
      userAgent: 'Mozilla/5.0 (Macintosh)',
      chromeVersion: '128.0.0.0',
      platform: 'MacIntel',
      extVersion: '0.1.0',
      timeZone: 'UTC',
      viewport: { width: 1920, height: 1080, devicePixelRatio: 2 },
    },
    counters: {
      events: stepCount * 8,
      networkRequests: stepCount,
      httpErrors: Math.floor(stepCount / 8),
      networkErrors: Math.floor(stepCount / 13),
      consoleErrors: Math.floor(stepCount / 9),
      consoleWarns: Math.floor(stepCount / 6),
      pageErrors: Math.floor(stepCount / 20),
      screenshots: stepCount * 2,
      manualCaptures: 0,
      rageClicks: Math.floor(stepCount / 15),
      steps: stepCount,
    },
    schemaVersion: EVENT_SCHEMA_VERSION,
    testResult: 'fail',
    apiSlaSec: 3,
  };
}

function makeFixture(stepCount: number): Fixture {
  const session = makeSession(stepCount);
  const events: TestEvent[] = [];
  const steps: Step[] = [];
  const networkLogs: NetworkLog[] = [];
  const knownBlobKeys = new Set<string>();
  const draftRows: Fixture['stepDraft'] = [];

  let seq = 1;
  const sharedBeforePool = Math.max(4, Math.floor(stepCount * 0.35));

  for (let i = 1; i <= stepCount; i += 1) {
    const ts = session.startedAt + i * 4_000;
    const clickId = `click-${i}`;
    const requestId = `req-${i}`;
    const beforeId = `ev-before-${i}`;
    const afterId = `ev-after-${i}`;

    const beforeBlobKey = `blob:before:${i % sharedBeforePool}`;
    const afterBlobKey = `blob:after:${i}`;
    const hasAfter = i % 11 !== 0;
    const hasConsoleError = i % 9 === 0;
    const hasBug = i % 7 === 0;
    const hasNetFailure = i % 8 === 0;

    knownBlobKeys.add(beforeBlobKey);
    knownBlobKeys.add(afterBlobKey);

    const click: UserClickEvent = {
      id: clickId,
      kind: 'user_click',
      sessionId: session.id,
      tabId: 1,
      ts,
      seq: seq++,
      selector: '[data-testid="cta-checkout"]',
      tagName: 'BUTTON',
      pageUrl: `https://shop.example.com/cart?step=${i}`,
      confidence: 'observed',
      elementRect: {
        x: 80 + (i % 10) * 8,
        y: 140 + (i % 7) * 6,
        width: 180,
        height: 44,
        pageScrollX: 0,
        pageScrollY: (i - 1) * 220,
        viewportWidth: 1920,
        viewportHeight: 1080,
        devicePixelRatio: 2,
      },
    };
    events.push(click);

    events.push({
      id: `net-start-${i}`,
      kind: 'net_phase',
      sessionId: session.id,
      tabId: 1,
      ts: ts + 120,
      seq: seq++,
      phase: 'start',
      requestId,
      method: i % 2 === 0 ? 'POST' : 'GET',
      url: `https://shop.example.com/api/checkout/${i}`,
      resourceType: 'fetch',
      droppedHeaderCount: 0,
      confidence: 'observed',
    });

    events.push({
      id: `net-complete-${i}`,
      kind: 'net_phase',
      sessionId: session.id,
      tabId: 1,
      ts: ts + (hasNetFailure ? 1_200 : 620),
      seq: seq++,
      phase: hasNetFailure ? 'error' : 'complete',
      requestId,
      method: i % 2 === 0 ? 'POST' : 'GET',
      url: `https://shop.example.com/api/checkout/${i}`,
      resourceType: 'fetch',
      droppedHeaderCount: 0,
      ...(hasNetFailure ? { errorText: 'Internal error' } : { statusCode: 200 }),
      confidence: 'observed',
    });

    const beforeEv: EvidenceStoredEvent = {
      id: beforeId,
      kind: 'evidence_stored',
      sessionId: session.id,
      tabId: 1,
      ts: ts + 20,
      seq: seq++,
      requestedEventId: `req-before-${i}`,
      trigger: 'user_action',
      blobKey: beforeBlobKey,
      width: [1366, 1536, 1920, 2560][i % 4]!,
      height: [768, 864, 1080, 1440][i % 4]!,
      bytes: 420_000 + (i % 5) * 90_000,
      format: 'image/png',
      pageUrl: click.pageUrl,
      stepId: `step-${i}`,
      stepFrame: 'before',
      confidence: 'observed',
    };
    events.push(beforeEv);

    if (hasAfter) {
      events.push({
        id: afterId,
        kind: 'evidence_stored',
        sessionId: session.id,
        tabId: 1,
        ts: ts + 540,
        seq: seq++,
        requestedEventId: `req-after-${i}`,
        trigger: 'user_action_after',
        blobKey: afterBlobKey,
        width: 1920,
        height: 1080,
        bytes: 530_000,
        format: 'image/png',
        pageUrl: click.pageUrl,
        stepId: `step-${i}`,
        stepFrame: 'after',
        confidence: 'observed',
      });
    }

    if (hasConsoleError) {
      const ce: ConsoleErrorEvent = {
        id: `console-${i}`,
        kind: 'console_error',
        sessionId: session.id,
        tabId: 1,
        ts: ts + 700,
        seq: seq++,
        message: `Unhandled promise rejection at step ${i}`,
        stack: 'Error: boom\n at checkout.ts:42:10',
        pageUrl: click.pageUrl,
        confidence: 'observed',
      };
      events.push(ce);
    }

    steps.push({
      id: `step-${i}`,
      sessionId: session.id,
      tabId: 1,
      index: i,
      ts,
      seq: i,
      label: `Click checkout CTA ${i}`,
      pageUrl: click.pageUrl,
      clickEventIds: [clickId],
      elementRect: click.elementRect,
      beforeEvidenceEventId: beforeId,
      ...(hasAfter ? { afterEvidenceEventId: afterId } : {}),
      systemEvidenceEventIds: [],
      noChangeDetected: !hasAfter,
      qaNotes: i % 5 === 0 ? [{ id: `note-${i}`, text: `Observed spinner delay on step ${i}`, pin: { target: 'after', x: 45, y: 35 } }] : [],
      bugs: hasBug ? [{ id: `bug-${i}`, description: `Price mismatch appears at step ${i}`, pin: { target: 'before', x: 24, y: 48 } }] : [],
      ...(hasBug ? { isBug: true, bugDescription: `Bug at step ${i}` } : {}),
    });

    networkLogs.push({
      id: `netlog-${i}`,
      sessionId: session.id,
      url: `https://shop.example.com/api/checkout/${i}`,
      method: i % 2 === 0 ? 'POST' : 'GET',
      status: hasNetFailure ? 500 : 200,
      timestamp: ts + 620,
      durationMs: hasNetFailure ? 1_200 : 620,
    });

    draftRows.push({
      stepId: `step-${i}`,
      stepIndex: i,
      label: `Click checkout CTA ${i}`,
      note: i % 5 === 0 ? `Observed spinner delay on step ${i}` : '',
      issuePills: [
        ...(hasNetFailure ? ['HTTP 500'] : []),
        ...(hasConsoleError ? ['Console error'] : []),
      ],
      networkFailures: hasNetFailure
        ? [{ method: 'POST', url: `https://shop.example.com/api/checkout/${i}`, statusCode: 500, durationMs: 1_200 }]
        : [],
      consoleErrors: hasConsoleError ? [`Unhandled promise rejection at step ${i}`] : [],
      beforeEvidenceEventId: beforeId,
      ...(hasAfter ? { afterEvidenceEventId: afterId } : {}),
    });
  }

  return {
    session,
    steps,
    events,
    networkLogs,
    knownBlobKeys,
    stepDraft: draftRows,
  };
}

function bytesToMiB(bytes: number): number {
  return Number((bytes / (1024 * 1024)).toFixed(2));
}

describe('P0 stress — long session memory/export reliability', () => {
  it('exports deterministic 10/25/50/100/200 step sessions and reports resource metrics', async () => {
    const { pdf } = await import('@react-pdf/renderer');

    const rows: Array<Record<string, number | string>> = [];

    for (const stepCount of STEP_COUNTS) {
      resetMockState();
      const fixture = makeFixture(stepCount);

      // Seed mocked storage: valid tiny image bytes for all known keys,
      // then deliberately delete every 17th key to simulate unreadable blobs.
      for (const key of fixture.knownBlobKeys) {
        mockState.blobs.set(key, { data: VALID_IMAGE_BYTES, mimeType: 'image/png' });
      }
      let dropCursor = 0;
      for (const key of fixture.knownBlobKeys) {
        if (dropCursor % 17 === 0) mockState.blobs.delete(key);
        dropCursor += 1;
      }
      mockState.eventsBySession.set(fixture.session.id, fixture.events);
      mockState.eventsBySession.set('sess-foreign-heavy', new Array(10_000).fill(0).map((_, idx) => ({
        id: `foreign-${idx}`,
        kind: 'console_warn',
        sessionId: 'sess-foreign-heavy',
        tabId: 9,
        ts: 9_000_000 + idx,
        seq: idx + 1,
        message: 'foreign noise',
        confidence: 'observed',
      } as TestEvent)));

      const canonicalStart = performance.now();
      const model = buildCanonicalExportModel({
        session: fixture.session,
        events: fixture.events,
        steps: fixture.steps,
        networkLogs: fixture.networkLogs,
        knownBlobKeys: fixture.knownBlobKeys,
      });
      const canonicalMs = performance.now() - canonicalStart;

      const serialized = JSON.stringify(model);
      expect(serialized).not.toContain('data:image');
      expect(serialized).not.toContain('base64,');

      const blobKeys = new Set<string>();
      for (const section of model.sections) {
        for (const step of section.steps) {
          if (step.beforeEvidence) blobKeys.add(step.beforeEvidence.blobKey);
          if (step.afterEvidence) blobKeys.add(step.afterEvidence.blobKey);
        }
      }
      const evidenceRefs = model.sections[0]?.steps.reduce((sum, step) => sum + (step.beforeEvidence ? 1 : 0) + (step.afterEvidence ? 1 : 0), 0) ?? 0;
      const duplicateRatio = evidenceRefs === 0 ? 0 : Number((1 - blobKeys.size / evidenceRefs).toFixed(3));

      mockState.blobDelayMs = 2;
      const loadStart = performance.now();
      const blobLoad = await loadEvidenceBlobs(blobKeys);
      const loadMs = performance.now() - loadStart;
      const indexedDbReadsPdf = mockState.getBlobCalls;
      expect(mockState.maxConcurrentBlobReads).toBe(1);

      const prepStart = performance.now();
      const viewModel = preparePdfProps(model, blobLoad.resolver);
      const prepMs = performance.now() - prepStart;

      const beforePdfHeap = process.memoryUsage().heapUsed;
      const pdfStart = performance.now();
      let pdfBlob: Blob;
      try {
        pdfBlob = await pdf(createElement(QaReportPdf, { viewModel }) as unknown as Parameters<typeof pdf>[0]).toBlob();
      } catch (error) {
        throw new Error(`PDF render failed at stepCount=${stepCount}: ${String(error)}`);
      }
      const pdfMs = performance.now() - pdfStart;
      const afterPdfHeap = process.memoryUsage().heapUsed;

      const htmlStartCalls = mockState.getBlobCalls;
      const htmlStart = performance.now();
      const html = await exportBusinessFlowReportHtml(fixture.session, {
        sessionId: fixture.session.id,
        testStatus: 'fail',
        summary: {
          totalDuration: `${Math.round((fixture.session.endedAt! - fixture.session.startedAt) / 1000)}s`,
          totalCapturedSteps: fixture.steps.length,
          totalDetectedIssues: fixture.stepDraft.reduce((sum, row) => sum + row.issuePills.length, 0),
        },
        steps: fixture.stepDraft,
      });
      const htmlMs = performance.now() - htmlStart;
      const indexedDbReadsHtml = mockState.getBlobCalls - htmlStartCalls;

      expect(html).toContain('<h2>Test Evidence</h2>');
      expect(html).toContain(`Step ${stepCount}`);
      expect(pdfBlob.size).toBeGreaterThan(5_000);
      expect(viewModel.steps).toHaveLength(stepCount);

      rows.push({
        steps: stepCount,
        evidenceRefs,
        uniqueBlobKeys: blobKeys.size,
        duplicateRatio,
        indexedDbReadsPdf,
        indexedDbReadsHtml,
        blobReadMiB: bytesToMiB(mockState.blobBytesRead),
        canonicalMs: Number(canonicalMs.toFixed(1)),
        blobLoadMs: Number(loadMs.toFixed(1)),
        vmPrepMs: Number(prepMs.toFixed(1)),
        pdfMs: Number(pdfMs.toFixed(1)),
        pdfSizeMiB: bytesToMiB(pdfBlob.size),
        htmlMs: Number(htmlMs.toFixed(1)),
        htmlSizeMiB: bytesToMiB(Buffer.byteLength(html, 'utf8')),
        heapDeltaMiB: bytesToMiB(Math.max(0, afterPdfHeap - beforePdfHeap)),
        missingScreens: viewModel.missingScreenshotCount,
        blobLoadFailures: blobLoad.failedKeys.length,
        sessionEventReads: mockState.getEventsCalls,
      });

      // Multi-session guard: HTML export asked only for the selected session id.
      expect(mockState.getEventsCalls).toBe(1);
    }

    console.table(rows);
    for (const row of rows) {
      console.log('STRESS_ROW ' + JSON.stringify(row));
    }
  }, 120_000);

  it('handles large screenshot byte payloads without blowing stack in HTML base64 conversion', async () => {
    resetMockState();

    const fixture = makeFixture(10);
    mockState.eventsBySession.set(fixture.session.id, fixture.events);

    const heavyBytes = new Uint8Array(1_800_000);
    heavyBytes.fill(137);

    // Map all keys to a large payload to stress base64 conversion path.
    for (const key of fixture.knownBlobKeys) {
      mockState.blobs.set(key, { data: heavyBytes, mimeType: 'image/png' });
    }

    const html = await exportBusinessFlowReportHtml(fixture.session, {
      sessionId: fixture.session.id,
      testStatus: 'fail',
      summary: { totalDuration: '45s', totalCapturedSteps: fixture.steps.length, totalDetectedIssues: 3 },
      steps: fixture.stepDraft,
    });

    // If conversion stack-overflows, screenshotToBase64 returns '' and images vanish.
    expect(html).toContain('data:image/png;base64,');
    expect(mockState.getBlobCalls).toBeGreaterThan(0);
  }, 120_000);
});
