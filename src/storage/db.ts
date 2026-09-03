import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type { Session, TestEvent, Step, NetworkLog } from '../core/types.js';

import type { DocModel } from '../core/doc-model.js';

const DB_NAME = 'testtrace';
const DB_VERSION = 4; // bumped: added network-logs store


export interface BlobRecord {
  key: string;
  data: Uint8Array;
  mimeType: 'image/webp' | 'image/jpeg' | 'image/png';
  storedAt: number;
  sessionId: string;
}

interface TTSchema extends DBSchema {
  sessions: { key: string; value: Session };
  events: {
    key: string;
    value: TestEvent;
    indexes: { 'by-session': string; 'by-session-ts': [string, number] };
  };
  blobs: {
    key: string;
    value: BlobRecord;
    indexes: { 'by-session': string };
  };
  steps: {
    key: string;
    value: Step;
    indexes: { 'by-session': string; 'by-session-seq': [string, number] };
  };
  'network-logs': {
    key: string;
    value: NetworkLog;
    indexes: { sessionId: string };
  };
  documents: { key: string; value: DocModel };
}

let _db: IDBPDatabase<TTSchema> | null = null;

const FEATURE_CATALOG_KEY = 'tt:featureCatalog';

async function getFeatureCatalog(): Promise<string[]> {
  const stored = await chrome.storage.local.get(FEATURE_CATALOG_KEY);
  const raw = stored[FEATURE_CATALOG_KEY];
  if (!Array.isArray(raw)) return [];
  const normalized = Array.from(new Set(
    raw
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean),
  ));
  return normalized.sort((a, b) => a.localeCompare(b));
}

async function putFeatureCatalog(features: readonly string[]): Promise<void> {
  const next = Array.from(new Set(features.map((name) => name.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  await chrome.storage.local.set({ [FEATURE_CATALOG_KEY]: next });
}

export async function getDb(): Promise<IDBPDatabase<TTSchema>> {
  if (_db) return _db;
  _db = await openDB<TTSchema>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('sessions', { keyPath: 'id' });
        const ev = db.createObjectStore('events', { keyPath: 'id' });
        ev.createIndex('by-session', 'sessionId');
        ev.createIndex('by-session-ts', ['sessionId', 'ts']);
        const bl = db.createObjectStore('blobs', { keyPath: 'key' });
        bl.createIndex('by-session', 'sessionId');
      }
      if (oldVersion < 2) {
        // Add canonical document model store
        db.createObjectStore('documents', { keyPath: 'id' });
      }
      if (oldVersion < 3) {
        const st = db.createObjectStore('steps', { keyPath: 'id' });
        st.createIndex('by-session', 'sessionId');
        st.createIndex('by-session-seq', ['sessionId', 'seq']);
      }
      if (oldVersion < 4) {
        const store = db.createObjectStore('network-logs', { keyPath: 'id' });
        store.createIndex('sessionId', 'sessionId');
      }
    },
    blocked() { console.warn('[TestTrace:db] upgrade blocked'); },
    blocking() { _db?.close(); _db = null; },
    terminated() { _db = null; },
  });
  return _db;
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

export async function putSession(session: Session): Promise<void> {
  const db = await getDb();
  await db.put('sessions', session);
}

export async function getSession(id: string): Promise<Session | undefined> {
  return (await getDb()).get('sessions', id);
}

export async function updateSession(sessionId: string, updates: Partial<Session>): Promise<Session | undefined> {
  const existing = await getSession(sessionId);
  if (!existing) return undefined;
  const merged: Session = { ...existing, ...updates, id: existing.id };
  await putSession(merged);
  return merged;
}

export async function getAllSessions(): Promise<Session[]> {
  const sessions = await (await getDb()).getAll('sessions');
  return sessions.sort((a, b) => b.startedAt - a.startedAt);
}

export async function createFeatureStub(featureName: string): Promise<boolean> {
  const next = featureName.trim();
  if (!next) return false;
  const catalog = await getFeatureCatalog();
  if (catalog.some((name) => name.toLowerCase() === next.toLowerCase())) return false;
  await putFeatureCatalog([...catalog, next]);
  return true;
}

export async function getDistinctFeatureNames(): Promise<string[]> {
  const sessions = await getAllSessions();
  const names = new Set(await getFeatureCatalog());
  for (const session of sessions) {
    const feature = session.featureName?.trim();
    if (feature) names.add(feature);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export async function getFeatureSummaries(): Promise<Array<{
  featureName: string;
  count: number;
  passed: number;
  failed: number;
  blocked: number;
  testCaseCount: number;
  openBugCount: number;
}>> {
  const sessions = await getAllSessions();
  const byFeature = new Map<string, {
    featureName: string;
    count: number;
    passed: number;
    failed: number;
    blocked: number;
    testCaseNames: Set<string>;
    openBugCount: number;
  }>();
  const featureBySessionId = new Map<string, string>();

  for (const session of sessions) {
    const featureName = session.featureName?.trim();
    if (!featureName) continue;

    featureBySessionId.set(session.id, featureName);

    const row = byFeature.get(featureName) ?? {
      featureName,
      count: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      testCaseNames: new Set<string>(),
      openBugCount: 0,
    };

    row.count += 1;
    if (session.status === 'pass') row.passed += 1;
    if (session.status === 'fail') row.failed += 1;
    if (session.status === 'blocked') row.blocked += 1;

    const testCaseName = session.testCaseName?.trim();
    if (testCaseName) row.testCaseNames.add(testCaseName);

    byFeature.set(featureName, row);
  }

  for (const featureName of await getFeatureCatalog()) {
    if (byFeature.has(featureName)) continue;
    byFeature.set(featureName, {
      featureName,
      count: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      testCaseNames: new Set<string>(),
      openBugCount: 0,
    });
  }

  const steps = await (await getDb()).getAll('steps');
  for (const step of steps) {
    const featureName = featureBySessionId.get(step.sessionId);
    if (!featureName) continue;
    const row = byFeature.get(featureName);
    if (!row) continue;

    if (Array.isArray(step.bugs) && step.bugs.length > 0) {
      row.openBugCount += step.bugs.length;
      continue;
    }

    if (step.isBug) row.openBugCount += 1;
  }

  return [...byFeature.values()]
    .map((row) => ({
      featureName: row.featureName,
      count: row.count,
      passed: row.passed,
      failed: row.failed,
      blocked: row.blocked,
      testCaseCount: row.testCaseNames.size,
      openBugCount: row.openBugCount,
    }))
    .sort((a, b) => b.count - a.count || a.featureName.localeCompare(b.featureName));
}

export async function getFeatureNetworkStats(featureName: string): Promise<{
  totalRequests: number;
  successCount: number;
  warnCount: number;
  errorCount: number;
  fastRequests: number;
  avgRequests: number;
  slowRequests: number;
  avgLatency: number;
  topSlowest: NetworkLog[];
}> {
  const normalizedFeature = featureName.trim().toLowerCase();
  if (!normalizedFeature) {
    return {
      totalRequests: 0,
      successCount: 0,
      warnCount: 0,
      errorCount: 0,
      fastRequests: 0,
      avgRequests: 0,
      slowRequests: 0,
      avgLatency: 0,
      topSlowest: [],
    };
  }

  const sessions = await getAllSessions();
  const sessionIds = new Set(
    sessions
      .filter((session) => session.featureName?.trim().toLowerCase() === normalizedFeature)
      .map((session) => session.id),
  );

  if (!sessionIds.size) {
    return {
      totalRequests: 0,
      successCount: 0,
      warnCount: 0,
      errorCount: 0,
      fastRequests: 0,
      avgRequests: 0,
      slowRequests: 0,
      avgLatency: 0,
      topSlowest: [],
    };
  }

  const db = await getDb();
  const allLogs = await db.getAll('network-logs');
  const logs = allLogs.filter((log) => sessionIds.has(log.sessionId));

  const totalRequests = logs.length;
  const successCount = logs.filter((log) => log.status >= 200 && log.status < 400).length;
  const warnCount = logs.filter((log) => log.status >= 400 && log.status < 500).length;
  const errorCount = logs.filter((log) => log.status === 0 || log.status >= 500).length;

  const logsWithDuration = logs.filter((log) => typeof log.durationMs === 'number' && Number.isFinite(log.durationMs));
  const fastRequests = logsWithDuration.filter((log) => (log.durationMs ?? 0) < 100).length;
  const avgRequests = logsWithDuration.filter((log) => (log.durationMs ?? 0) >= 100 && (log.durationMs ?? 0) < 500).length;
  const slowRequests = logsWithDuration.filter((log) => (log.durationMs ?? 0) >= 500).length;

  const totalLatency = logsWithDuration.reduce((sum, log) => sum + (log.durationMs ?? 0), 0);
  const avgLatency = logsWithDuration.length ? totalLatency / logsWithDuration.length : 0;

  const endpointBuckets = new Map<string, {
    method: string;
    path: string;
    count: number;
    totalDuration: number;
    maxStatus: number;
    latestTs: number;
    sessionId: string;
  }>();

  for (const log of logsWithDuration) {
    const path = (() => {
      try {
        return new URL(log.url).pathname;
      } catch {
        return log.url.split('?')[0] ?? log.url;
      }
    })();

    const key = `${log.method} ${path}`;
    const bucket = endpointBuckets.get(key) ?? {
      method: log.method,
      path,
      count: 0,
      totalDuration: 0,
      maxStatus: log.status,
      latestTs: log.timestamp,
      sessionId: log.sessionId,
    };

    bucket.count += 1;
    bucket.totalDuration += log.durationMs ?? 0;
    if (log.status > bucket.maxStatus) bucket.maxStatus = log.status;
    if (log.timestamp > bucket.latestTs) bucket.latestTs = log.timestamp;
    endpointBuckets.set(key, bucket);
  }

  const topSlowest = [...endpointBuckets.values()]
    .map((bucket, index) => ({
      id: `agg-${index}-${bucket.method}-${bucket.path}`,
      sessionId: bucket.sessionId,
      method: bucket.method,
      url: bucket.path,
      status: bucket.maxStatus,
      timestamp: bucket.latestTs,
      durationMs: bucket.totalDuration / Math.max(bucket.count, 1),
    }))
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .slice(0, 5);

  return {
    totalRequests,
    successCount,
    warnCount,
    errorCount,
    fastRequests,
    avgRequests,
    slowRequests,
    avgLatency,
    topSlowest,
  };
}

export async function getDistinctTestCases(featureName: string): Promise<string[]> {
  const feature = featureName.trim().toLowerCase();
  if (!feature) return [];

  const sessions = await getAllSessions();
  const names = new Set<string>();
  for (const session of sessions) {
    const sessionFeature = session.featureName?.trim().toLowerCase();
    const testCase = session.testCaseName?.trim();
    if (sessionFeature === feature && testCase) names.add(testCase);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export interface FeatureExportData {
  featureName: string;
  sessions: Session[];
  steps: Step[];
  networkLogs: NetworkLog[];
  blobs: BlobRecord[];
}

/**
 * Session-scoped read path for the export projection.
 *
 * Returns everything a single BusinessFlow session/run needs to be projected
 * into a CanonicalExportModel — session, events, steps, network logs, and
 * blob-metadata (bytes are streamed later by renderers via `getBlob`).
 */
export interface SessionExportBundle {
  session: Session;
  events: TestEvent[];
  steps: Step[];
  networkLogs: NetworkLog[];
  blobs: Array<Pick<BlobRecord, 'key' | 'mimeType' | 'storedAt' | 'sessionId'>>;
}

export interface ImportArchiveBundle {
  sessions: Session[];
  events: TestEvent[];
  steps: Step[];
  networkLogs: NetworkLog[];
  documents: DocModel[];
  blobs: BlobRecord[];
}

export async function getSessionExportData(sessionId: string): Promise<SessionExportBundle | undefined> {
  const session = await getSession(sessionId);
  if (!session) return undefined;
  const [events, steps, networkLogs, blobRecords] = await Promise.all([
    getEventsForSession(sessionId),
    getStepsForSession(sessionId),
    getNetworkLogs(sessionId),
    getBlobsForSession(sessionId),
  ]);
  return {
    session,
    events,
    steps,
    networkLogs,
    blobs: blobRecords.map(({ key, mimeType, storedAt, sessionId: sid }) => ({
      key,
      mimeType,
      storedAt,
      sessionId: sid,
    })),
  };
}

export async function getFeatureExportData(featureName: string): Promise<FeatureExportData> {
  const normalizedFeature = featureName.trim().toLowerCase();
  if (!normalizedFeature) {
    return {
      featureName: featureName.trim(),
      sessions: [],
      steps: [],
      networkLogs: [],
      blobs: [],
    };
  }

  const allSessions = await getAllSessions();
  const sessions = allSessions.filter((session) => (session.featureName ?? '').trim().toLowerCase() === normalizedFeature);

  const nested = await Promise.all(
    sessions.map(async (session) => ({
      steps: await getStepsForSession(session.id),
      networkLogs: await getNetworkLogs(session.id),
      blobs: await getBlobsForSession(session.id),
    })),
  );

  const steps = nested.flatMap((item) => item.steps);
  const networkLogs = nested.flatMap((item) => item.networkLogs);
  const blobMap = new Map<string, BlobRecord>();
  for (const blob of nested.flatMap((item) => item.blobs)) {
    blobMap.set(blob.key, blob);
  }

  return {
    featureName: featureName.trim(),
    sessions,
    steps,
    networkLogs,
    blobs: [...blobMap.values()],
  };
}

export async function deleteSession(sessionId: string): Promise<void> {
  const db = await getDb();
  const eventKeys = await db.getAllKeysFromIndex('events', 'by-session', sessionId);
  const blobKeys = await db.getAllKeysFromIndex('blobs', 'by-session', sessionId);
  const stepKeys = await db.getAllKeysFromIndex('steps', 'by-session', sessionId);
  const networkLogKeys = await db.getAllKeysFromIndex('network-logs', 'sessionId', sessionId);
  const tx = db.transaction(['sessions', 'events', 'blobs', 'steps', 'network-logs'], 'readwrite');
  tx.objectStore('sessions').delete(sessionId);
  for (const k of eventKeys) tx.objectStore('events').delete(k);
  for (const k of blobKeys) tx.objectStore('blobs').delete(k);
  for (const k of stepKeys) tx.objectStore('steps').delete(k);
  for (const k of networkLogKeys) tx.objectStore('network-logs').delete(k);
  await tx.done;
}

export async function deleteFeature(featureName: string): Promise<number> {
  const normalized = featureName.trim().toLowerCase();
  if (!normalized) return 0;

  const sessions = await getAllSessions();
  const targets = sessions.filter((session) => (session.featureName ?? '').trim().toLowerCase() === normalized);
  for (const session of targets) {
    await deleteSession(session.id);
  }

  const catalog = await getFeatureCatalog();
  await putFeatureCatalog(catalog.filter((name) => name.trim().toLowerCase() !== normalized));

  return targets.length;
}

export async function renameFeature(oldName: string, newName: string): Promise<number> {
  const source = oldName.trim().toLowerCase();
  const target = newName.trim();
  if (!source || !target) return 0;

  const sessions = await getAllSessions();
  const targets = sessions.filter((session) => (session.featureName ?? '').trim().toLowerCase() === source);
  for (const session of targets) {
    await putSession({ ...session, featureName: target });
  }

  const catalog = await getFeatureCatalog();
  const renamed = catalog.map((name) => (name.trim().toLowerCase() === source ? target : name));
  await putFeatureCatalog(renamed);

  return targets.length;
}

export async function renameTestCase(
  featureName: string,
  oldTestCaseName: string,
  newTestCaseName: string,
): Promise<number> {
  const feature = featureName.trim().toLowerCase();
  const source = oldTestCaseName.trim().toLowerCase();
  const target = newTestCaseName.trim();
  if (!feature || !source || !target) return 0;

  const sessions = await getAllSessions();
  const targets = sessions.filter((session) => {
    const currentFeature = (session.featureName ?? '').trim().toLowerCase();
    const currentTestCase = (session.testCaseName ?? '').trim().toLowerCase();
    return currentFeature === feature && currentTestCase === source;
  });

  for (const session of targets) {
    await putSession({ ...session, testCaseName: target });
  }

  return targets.length;
}

export async function moveTestCase(oldFeature: string, newFeature: string, testCaseName: string): Promise<number> {
  const sourceFeature = oldFeature.trim().toLowerCase();
  const targetFeature = newFeature.trim();
  const targetTestCase = testCaseName.trim().toLowerCase();
  if (!sourceFeature || !targetFeature || !targetTestCase) return 0;

  const sessions = await getAllSessions();
  const targets = sessions.filter((session) => {
    const currentFeature = (session.featureName ?? '').trim().toLowerCase();
    const currentTestCase = (session.testCaseName ?? '').trim().toLowerCase();
    return currentFeature === sourceFeature && currentTestCase === targetTestCase;
  });

  for (const session of targets) {
    await putSession({ ...session, featureName: targetFeature });
  }

  return targets.length;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export async function appendEvent(event: TestEvent): Promise<void> {
  await (await getDb()).add('events', event);
}

export async function appendEvents(events: readonly TestEvent[]): Promise<void> {
  if (!events.length) return;
  const db = await getDb();
  const tx = db.transaction('events', 'readwrite');
  for (const ev of events) tx.store.add(ev);
  await tx.done;
}

export async function getEventsForSession(sessionId: string): Promise<TestEvent[]> {
  const db = await getDb();
  const range = IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]);
  return db.getAllFromIndex('events', 'by-session-ts', range);
}

export async function updateEvent(event: TestEvent): Promise<void> {
  await (await getDb()).put('events', event);
}

// ─── Blobs ────────────────────────────────────────────────────────────────────

export async function putBlob(record: BlobRecord): Promise<void> {
  await (await getDb()).put('blobs', record);
}

export async function getBlob(key: string): Promise<BlobRecord | undefined> {
  return (await getDb()).get('blobs', key);
}

export async function getBlobsForSession(sessionId: string): Promise<BlobRecord[]> {
  return (await getDb()).getAllFromIndex('blobs', 'by-session', sessionId);
}

export async function dbStats(): Promise<{ sessions: number; events: number; blobs: number }> {
  const db = await getDb();
  return {
    sessions: await db.count('sessions'),
    events: await db.count('events'),
    blobs: await db.count('blobs'),
  };
}

// ─── Steps ──────────────────────────────────────────────────────────────

export async function putStep(step: Step): Promise<void> {
  await (await getDb()).put('steps', step);
}

export async function getStep(id: string): Promise<Step | undefined> {
  return (await getDb()).get('steps', id);
}

export async function updateStep(stepId: string, updates: Partial<Step>): Promise<Step | undefined> {
  const existing = await getStep(stepId);
  if (!existing) return undefined;
  const merged: Step = { ...existing, ...updates, id: existing.id, sessionId: existing.sessionId };
  await putStep(merged);
  return merged;
}

export async function getStepsForSession(sessionId: string): Promise<Step[]> {
  const db = await getDb();
  const range = IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]);
  return db.getAllFromIndex('steps', 'by-session-seq', range);
}

export async function addNetworkLog(log: NetworkLog): Promise<void> {
  const db = await getDb();
  await db.put('network-logs', log);

  const logs = await db.getAllFromIndex('network-logs', 'sessionId', log.sessionId);
  if (logs.length <= 500) return;

  const overflow = logs
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, logs.length - 500);

  const tx = db.transaction('network-logs', 'readwrite');
  for (const item of overflow) tx.store.delete(item.id);
  await tx.done;
}

export async function getNetworkLogs(sessionId: string): Promise<NetworkLog[]> {
  const logs = await (await getDb()).getAllFromIndex('network-logs', 'sessionId', sessionId);
  return logs.sort((a, b) => a.timestamp - b.timestamp);
}

// ─── Documents (canonical DocModel) ──────────────────────────────────────

export async function getDocModel(id: string): Promise<DocModel | undefined> {
  return (await getDb()).get('documents', id);
}

export async function getAllDocModels(): Promise<DocModel[]> {
  return (await getDb()).getAll('documents');
}

export async function putDocModel(doc: DocModel): Promise<void> {
  await (await getDb()).put('documents', doc);
}

export async function importArchiveBundleAtomic(bundle: ImportArchiveBundle): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['sessions', 'events', 'steps', 'network-logs', 'documents', 'blobs'], 'readwrite');

  for (const session of bundle.sessions) tx.objectStore('sessions').put(session);
  for (const event of bundle.events) tx.objectStore('events').put(event);
  for (const step of bundle.steps) tx.objectStore('steps').put(step);
  for (const log of bundle.networkLogs) tx.objectStore('network-logs').put(log);
  for (const doc of bundle.documents) tx.objectStore('documents').put(doc);
  for (const blob of bundle.blobs) tx.objectStore('blobs').put(blob);

  await tx.done;
}
