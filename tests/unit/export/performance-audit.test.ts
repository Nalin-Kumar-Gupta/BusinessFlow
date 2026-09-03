import { describe, expect, it, vi } from 'vitest';

interface ChromeRuntimeShim {
  runtime: {
    getManifest: () => { version: string };
  };
}
(globalThis as unknown as { chrome: ChromeRuntimeShim }).chrome = {
  runtime: {
    getManifest: () => ({ version: '0.1.0-test' }),
  },
};

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
import type { DocModel } from '../../../src/core/doc-model.js';
import type { BlobRecord, FeatureExportData, SessionExportBundle } from '../../../src/storage/db.js';
import { buildCanonicalExportModel } from '../../../src/export/model/build-projection.js';
import { buildSessionPdf } from '../../../src/ui/export/pdf/export-session-pdf.js';
import { buildSessionWord } from '../../../src/ui/export/word/export-session-word.js';
import { buildSessionExcel } from '../../../src/ui/export/excel/export-session-excel.js';
import { buildBflowArchive, parseBflowArchive } from '../../../src/ui/export/bflow/archive.js';

const PNG_1X1 = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Zx5kAAAAASUVORK5CYII=', 'base64'));
const STEP_COUNTS = [12, 60, 120] as const;

let currentFeatureData: FeatureExportData;
let currentEventsBySession = new Map<string, TestEvent[]>();
let currentDocs: DocModel[] = [];
let blobStore = new Map<string, BlobRecord>();

vi.mock('../../../src/storage/db.js', () => ({
  getBlob: async (key: string) => blobStore.get(key),
  getFeatureExportData: async () => currentFeatureData,
  getEventsForSession: async (sessionId: string) => currentEventsBySession.get(sessionId) ?? [],
  getAllDocModels: async () => currentDocs,
  importArchiveBundleAtomic: async () => undefined,
}));

function nowMs(): number {
  return Number(performance.now().toFixed(1));
}

function time<T>(fn: () => Promise<T> | T): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  return Promise.resolve(fn()).then((value) => ({ value, ms: Number((performance.now() - start).toFixed(1)) }));
}

function mib(bytes: number): number {
  return Number((bytes / (1024 * 1024)).toFixed(2));
}

function makeFixture(stepCount: number): {
  bundle: SessionExportBundle;
  featureData: FeatureExportData;
  docs: DocModel[];
  blobRecords: BlobRecord[];
} {
  const session: Session = {
    id: `perf-${stepCount}`,
    featureName: 'Checkout Perf',
    testCaseName: `Perf ${stepCount}`,
    testCaseId: `TC-PERF-${stepCount}`,
    mode: 'guided',
    negativeTest: 'no',
    negativeTestSource: 'default',
    recordingState: 'stopped',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_000_000 + stepCount * 4_000,
    scopeOrigins: ['https://shop.example.com/*'],
    environment: {
      userAgent: 'Mozilla/5.0',
      chromeVersion: '128.0.0.0',
      platform: 'MacIntel',
      extVersion: '0.1.0',
      timeZone: 'UTC',
      viewport: { width: 1920, height: 1080, devicePixelRatio: 2 },
    },
    counters: {
      events: stepCount * 9,
      networkRequests: stepCount * 3,
      httpErrors: Math.floor(stepCount / 4),
      networkErrors: Math.floor(stepCount / 6),
      consoleErrors: Math.floor(stepCount / 3),
      consoleWarns: Math.floor(stepCount / 4),
      pageErrors: Math.floor(stepCount / 9),
      screenshots: stepCount * 2,
      manualCaptures: Math.floor(stepCount / 8),
      rageClicks: Math.floor(stepCount / 10),
      steps: stepCount,
    },
    schemaVersion: EVENT_SCHEMA_VERSION,
    testResult: 'fail',
    apiSlaSec: 3,
  };

  const steps: Step[] = [];
  const events: TestEvent[] = [];
  const networkLogs: NetworkLog[] = [];
  const blobs: BlobRecord[] = [];

  let seq = 1;
  for (let i = 1; i <= stepCount; i += 1) {
    const ts = session.startedAt + i * 3_500;
    const clickId = `click-${i}`;
    const beforeEventId = `ev-before-${i}`;
    const afterEventId = `ev-after-${i}`;
    const beforeBlobKey = `blob-before-${i}`;
    const afterBlobKey = `blob-after-${i}`;

    const click: UserClickEvent = {
      id: clickId,
      kind: 'user_click',
      sessionId: session.id,
      tabId: 1,
      ts,
      seq: seq++,
      selector: '[data-testid="checkout"]',
      tagName: 'BUTTON',
      pageUrl: `https://shop.example.com/cart?step=${i}`,
      confidence: 'observed',
      elementRect: {
        x: 20 + i,
        y: 40 + i,
        width: 160,
        height: 44,
        pageScrollX: 0,
        pageScrollY: i * 120,
        viewportWidth: 1920,
        viewportHeight: 1080,
        devicePixelRatio: 2,
      },
    };
    events.push(click);

    const before: EvidenceStoredEvent = {
      id: beforeEventId,
      kind: 'evidence_stored',
      sessionId: session.id,
      tabId: 1,
      ts: ts + 20,
      seq: seq++,
      requestedEventId: `req-before-${i}`,
      trigger: 'user_action',
      blobKey: beforeBlobKey,
      width: 1920,
      height: 1080,
      bytes: PNG_1X1.byteLength,
      format: 'image/png',
      pageUrl: click.pageUrl,
      stepId: `step-${i}`,
      stepFrame: 'before',
      confidence: 'observed',
    };

    const after: EvidenceStoredEvent = {
      id: afterEventId,
      kind: 'evidence_stored',
      sessionId: session.id,
      tabId: 1,
      ts: ts + 220,
      seq: seq++,
      requestedEventId: `req-after-${i}`,
      trigger: 'user_action_after',
      blobKey: afterBlobKey,
      width: 1920,
      height: 1080,
      bytes: PNG_1X1.byteLength,
      format: 'image/png',
      pageUrl: click.pageUrl,
      stepId: `step-${i}`,
      stepFrame: 'after',
      confidence: 'observed',
    };

    events.push(before, after);

    if (i % 3 === 0) {
      const consoleError: ConsoleErrorEvent = {
        id: `console-${i}`,
        kind: 'console_error',
        sessionId: session.id,
        tabId: 1,
        ts: ts + 260,
        seq: seq++,
        message: `Checkout failure ${i}`,
        stack: 'Error: checkout',
        pageUrl: click.pageUrl,
        confidence: 'observed',
      };
      events.push(consoleError);
    }

    steps.push({
      id: `step-${i}`,
      sessionId: session.id,
      tabId: 1,
      index: i,
      ts,
      seq: i,
      label: `Checkout step ${i}`,
      pageUrl: click.pageUrl,
      clickEventIds: [clickId],
      beforeEvidenceEventId: beforeEventId,
      afterEvidenceEventId: afterEventId,
      systemEvidenceEventIds: [],
      qaNotes: i % 5 === 0 ? [{ id: `note-${i}`, text: `Observed lag on step ${i}` }] : [],
      bugs: i % 7 === 0 ? [{ id: `bug-${i}`, description: `Failure on step ${i}` }] : [],
    });

    networkLogs.push({
      id: `net-${i}`,
      sessionId: session.id,
      url: `https://shop.example.com/api/checkout/${i}`,
      method: i % 2 === 0 ? 'POST' : 'GET',
      status: i % 4 === 0 ? 500 : 200,
      timestamp: ts + 300,
      durationMs: i % 4 === 0 ? 1300 : 480,
      requestBody: i % 4 === 0 ? '{"error":true}' : undefined,
      responseBody: i % 4 === 0 ? '{"message":"failed"}' : undefined,
    });

    blobs.push(
      { key: beforeBlobKey, sessionId: session.id, mimeType: 'image/png', storedAt: ts, data: PNG_1X1 },
      { key: afterBlobKey, sessionId: session.id, mimeType: 'image/png', storedAt: ts + 200, data: PNG_1X1 },
    );
  }

  return {
    bundle: {
      session,
      events,
      steps,
      networkLogs,
      blobs: blobs.map(({ key, mimeType, storedAt, sessionId }) => ({ key, mimeType, storedAt, sessionId })),
    },
    featureData: { featureName: session.featureName ?? 'Checkout Perf', sessions: [session], steps, networkLogs, blobs },
    docs: [{ id: session.id, fields: { 'doc.title': `Perf ${stepCount}` }, pageContents: {}, savedAt: session.startedAt + 1000 }],
    blobRecords: blobs,
  };
}

describe('P1 performance audit metrics', () => {
  it('measures export/import pipelines across small/medium/large sessions', async () => {
    const rows: Array<Record<string, number>> = [];

    for (const stepCount of STEP_COUNTS) {
      const fixture = makeFixture(stepCount);
      blobStore = new Map(fixture.blobRecords.map((blob) => [blob.key, blob]));
      currentEventsBySession = new Map([[fixture.bundle.session.id, fixture.bundle.events]]);
      currentFeatureData = fixture.featureData;
      currentDocs = fixture.docs;

      const heapStart = process.memoryUsage().heapUsed;

      const canonical = await time(() => buildCanonicalExportModel({
        session: fixture.bundle.session,
        events: fixture.bundle.events,
        steps: fixture.bundle.steps,
        networkLogs: fixture.bundle.networkLogs,
        knownBlobKeys: new Set(fixture.bundle.blobs.map((blob) => blob.key)),
      }));
      const pdfBuild = await time(() => buildSessionPdf(fixture.bundle));
      const wordBuild = await time(() => buildSessionWord(fixture.bundle));
      const excelBuild = await time(() => buildSessionExcel(fixture.bundle));
      const bflowBuild = await time(() => buildBflowArchive('Checkout Perf'));
      const bflowParse = await time(async () => {
        const bytes = new Uint8Array(await bflowBuild.value.blob.arrayBuffer());
        return parseBflowArchive(bytes);
      });

      const heapEnd = process.memoryUsage().heapUsed;

      rows.push({
        stepCount,
        screenshotCount: fixture.bundle.blobs.length,
        canonicalMs: canonical.ms,
        pdfMs: pdfBuild.ms,
        wordMs: wordBuild.ms,
        excelMs: excelBuild.ms,
        bflowBuildMs: bflowBuild.ms,
        bflowImportParseMs: bflowParse.ms,
        pdfSizeMiB: mib(pdfBuild.value.blob.size),
        wordSizeMiB: mib(wordBuild.value.blob.size),
        excelSizeMiB: mib(excelBuild.value.buffer.byteLength),
        bflowSizeMiB: mib(bflowBuild.value.blob.size),
        heapDeltaMiB: mib(Math.max(0, heapEnd - heapStart)),
      });

      const canonicalStepCount = canonical.value.sections.reduce((sum, section) => sum + section.steps.length, 0);
      expect(canonicalStepCount).toBe(stepCount);
      expect(pdfBuild.value.blob.size).toBeGreaterThan(0);
      expect(wordBuild.value.blob.size).toBeGreaterThan(0);
      expect(excelBuild.value.buffer.byteLength).toBeGreaterThan(0);
      expect(bflowParse.value.bundle.sessions).toHaveLength(1);
    }

    console.table(rows);
    console.log(`PERF_AUDIT_TS=${nowMs()}`);
  }, 180_000);
});
