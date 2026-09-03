import { strToU8, zipSync } from 'fflate';

import type { DocModel } from '../../src/core/doc-model.js';
import type { NetworkLog, Session, Step, TestEvent } from '../../src/core/types.js';

interface FixtureArchive {
  bytes: Uint8Array;
  paths: Record<string, Uint8Array>;
}

export async function createValidV2ArchiveFixture(): Promise<FixtureArchive> {
  const session = fixtureSession();
  const events = fixtureEvents(session.id);
  const firstEventId = events[0]?.id ?? 'ev-stored-1';
  const steps = fixtureSteps(session.id, firstEventId);
  const networkLogs = fixtureNetworkLogs(session.id);
  const documents = fixtureDocuments(session.id);
  const blobBytes = strToU8('blob-image');

  const blobIndex = [
    {
      key: 'blob-1',
      sessionId: session.id,
      mimeType: 'image/jpeg' as const,
      storedAt: 1_000,
      path: 'blobs/blob-1.bin',
      size: blobBytes.byteLength,
      sha256: await sha256Hex(blobBytes),
    },
  ];

  const payloads: Record<string, Uint8Array> = {
    'payload/sessions.json': strToU8(JSON.stringify([session])),
    'payload/events.json': strToU8(JSON.stringify(events)),
    'payload/steps.json': strToU8(JSON.stringify(steps)),
    'payload/network-logs.json': strToU8(JSON.stringify(networkLogs)),
    'payload/documents.json': strToU8(JSON.stringify(documents)),
    'payload/blob-index.json': strToU8(JSON.stringify(blobIndex)),
    'blobs/blob-1.bin': blobBytes,
  };

  const entries = await Promise.all(Object.entries(payloads).map(async ([path, bytes]) => ({
    path,
    kind: path.startsWith('blobs/') ? 'blob' : pathKind(path),
    ...(path.startsWith('payload/') && path.endsWith('.json') ? { count: JSON.parse(new TextDecoder().decode(bytes)).length } : {}),
    size: bytes.byteLength,
    sha256: await sha256Hex(bytes),
  })));

  const digest = await sha256Hex(strToU8(JSON.stringify(entries
    .map((entry) => ({ path: entry.path, size: entry.size, sha256: entry.sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path)))));

  const manifest = {
    magic: 'businessflow-archive',
    formatVersion: 2,
    createdAt: Date.now(),
    featureName: 'Checkout',
    producer: { product: 'BusinessFlow', version: 'test' },
    schemaVersions: {
      sessions: 1,
      events: 1,
      steps: 1,
      networkLogs: 1,
      documents: 1,
      blobIndex: 1,
    },
    entries,
    integrity: {
      algorithm: 'sha256',
      payloadDigest: digest,
    },
  };

  const allPaths: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(manifest)),
    ...payloads,
  };

  return { bytes: zipSync(allPaths), paths: allPaths };
}

export function createInvalidZipFixture(): Uint8Array {
  return strToU8('this is not zip');
}

export function createLegacyV1ArchiveFixture(): Uint8Array {
  const session = fixtureSession();
  const steps = fixtureSteps(session.id, 'ev-stored-1');
  const networkLogs = fixtureNetworkLogs(session.id);

  const data = {
    version: 1,
    featureName: 'Checkout',
    exportedAt: Date.now(),
    sessions: [session],
    steps,
    networkLogs,
    blobs: [
      {
        key: 'blob-1',
        sessionId: session.id,
        mimeType: 'image/jpeg',
        storedAt: 1_000,
      },
    ],
  };

  return zipSync({
    'data.json': strToU8(JSON.stringify(data)),
    'images/blob-1.bin': strToU8('blob-image'),
  });
}

function fixtureSession(): Session {
  return {
    id: 'sess-1',
    testCaseName: 'TC 1',
    featureName: 'Checkout',
    status: 'fail',
    testType: 'Negative',
    mode: 'guided',
    negativeTest: 'yes',
    negativeTestSource: 'user',
    recordingState: 'stopped',
    startedAt: 1_000,
    endedAt: 2_000,
    scopeOrigins: ['https://example.com'],
    environment: {
      userAgent: 'UA',
      chromeVersion: '1',
      platform: 'mac',
      extVersion: '1',
      timeZone: 'UTC',
    },
    counters: {
      events: 2,
      networkRequests: 1,
      httpErrors: 1,
      networkErrors: 0,
      consoleErrors: 0,
      consoleWarns: 0,
      pageErrors: 0,
      screenshots: 1,
      manualCaptures: 0,
      rageClicks: 0,
      steps: 1,
    },
    schemaVersion: 1,
    testResult: 'fail',
    apiSlaSec: 3,
  };
}

function fixtureEvents(sessionId: string): TestEvent[] {
  return [
    {
      id: 'ev-stored-1',
      sessionId,
      ts: 1_200,
      seq: 2,
      kind: 'evidence_stored',
      tabId: 1,
      confidence: 'observed',
      requestedEventId: 'ev-request-1',
      trigger: 'manual',
      blobKey: 'blob-1',
      width: 100,
      height: 100,
      bytes: 10,
      format: 'image/jpeg',
    },
  ] as TestEvent[];
}

function fixtureSteps(sessionId: string, evidenceEventId: string): Step[] {
  return [
    {
      id: 'step-1',
      sessionId,
      tabId: 1,
      index: 1,
      ts: 1_100,
      seq: 1,
      label: 'Click submit',
      clickEventIds: ['click-1'],
      beforeEvidenceEventId: evidenceEventId,
      afterEvidenceEventId: evidenceEventId,
      systemEvidenceEventIds: [],
      apiRequestIds: [],
      openedAt: 1_100,
      stabilityWindowMs: 1200,
      noAfterNeeded: false,
      state: 'done',
      timingMode: 'auto',
      timingSource: 'timeout',
    } as unknown as Step,
  ];
}

function fixtureNetworkLogs(sessionId: string): NetworkLog[] {
  return [
    {
      id: 'net-1',
      sessionId,
      method: 'POST',
      url: 'https://example.com/api',
      status: 500,
      timestamp: 1_300,
      durationMs: 300,
    },
  ];
}

function fixtureDocuments(sessionId: string): DocModel[] {
  return [
    {
      id: sessionId,
      fields: { 'doc.title': 'QA report' },
      pageContents: { 0: '<p>hello</p>' },
      savedAt: 1_500,
    },
  ];
}

function pathKind(path: string): 'sessions' | 'events' | 'steps' | 'network-logs' | 'documents' | 'blob-index' {
  if (path.endsWith('sessions.json')) return 'sessions';
  if (path.endsWith('events.json')) return 'events';
  if (path.endsWith('steps.json')) return 'steps';
  if (path.endsWith('network-logs.json')) return 'network-logs';
  if (path.endsWith('documents.json')) return 'documents';
  return 'blob-index';
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const normalized = new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', normalized);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
