import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import type { Session, Step, NetworkLog, TestEvent } from '../../../core/types.js';
import { sanitizeFilenameSegment } from '../../../core/security.js';
import type { DocModel } from '../../../core/doc-model.js';
import {
  getAllDocModels,
  getEventsForSession,
  getFeatureExportData,
  importArchiveBundleAtomic,
} from '../../../storage/db.js';
import type { BlobRecord, ImportArchiveBundle } from '../../../storage/db.js';

const BFLOW_MAGIC = 'businessflow-archive';
const BFLOW_FORMAT_VERSION = 2;
const SUPPORTED_MIN_VERSION = 1;
const SUPPORTED_MAX_VERSION = 2;

const REQUIRED_V2_JSON_PATHS = [
  'payload/sessions.json',
  'payload/events.json',
  'payload/steps.json',
  'payload/network-logs.json',
  'payload/documents.json',
  'payload/blob-index.json',
] as const;

const DEFAULT_LIMITS = {
  maxArchiveBytes: 256 * 1024 * 1024,
  maxUnzippedBytes: 512 * 1024 * 1024,
  maxEntries: 100_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxJsonBytes: 64 * 1024 * 1024,
  maxRecordsPerCollection: 1_000_000,
} as const;

interface V1DataFile {
  version: 1;
  featureName: string;
  exportedAt: number;
  sessions: Session[];
  steps: Step[];
  networkLogs: NetworkLog[];
  blobs: Array<Pick<BlobRecord, 'key' | 'mimeType' | 'storedAt' | 'sessionId'>>;
}

interface BflowSchemaVersions {
  sessions: number;
  events: number;
  steps: number;
  networkLogs: number;
  documents: number;
  blobIndex: number;
}

interface BflowManifestEntry {
  path: string;
  kind: 'sessions' | 'events' | 'steps' | 'network-logs' | 'documents' | 'blob-index' | 'blob';
  count?: number;
  size: number;
  sha256: string;
}

interface BflowManifestV2 {
  magic: typeof BFLOW_MAGIC;
  formatVersion: number;
  createdAt: number;
  featureName: string;
  producer: {
    product: 'BusinessFlow';
    version: string;
  };
  schemaVersions: BflowSchemaVersions;
  entries: BflowManifestEntry[];
  integrity: {
    algorithm: 'sha256';
    payloadDigest: string;
  };
}

interface BflowBlobIndexRow {
  key: string;
  sessionId: string;
  mimeType: BlobRecord['mimeType'];
  storedAt: number;
  path: string;
  size: number;
  sha256: string;
}

interface ParseOptions {
  readonly maxArchiveBytes?: number;
  readonly maxUnzippedBytes?: number;
  readonly maxEntries?: number;
  readonly maxEntryBytes?: number;
  readonly maxJsonBytes?: number;
  readonly maxRecordsPerCollection?: number;
}

interface ParsedArchive {
  formatVersion: 1 | 2;
  featureName: string;
  exportedAt: number;
  bundle: ImportArchiveBundle;
}

class BflowArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BflowArchiveError';
  }
}

export async function buildBflowArchive(featureName: string): Promise<{ blob: Blob; filename: string }> {
  const exportData = await getFeatureExportData(featureName);
  const sessionIds = new Set(exportData.sessions.map((session) => session.id));

  const eventsNested = await Promise.all(exportData.sessions.map((session) => getEventsForSession(session.id)));
  const events = eventsNested.flat();

  const allDocs = await getAllDocModels();
  const documents = allDocs.filter((doc) => {
    const ids = doc.id.split(':').filter(Boolean);
    return ids.length > 0 && ids.every((id) => sessionIds.has(id));
  });

  const blobIndex: BflowBlobIndexRow[] = await Promise.all(exportData.blobs.map(async (blob) => ({
    key: blob.key,
    sessionId: blob.sessionId,
    mimeType: blob.mimeType,
    storedAt: blob.storedAt,
    path: blobArchivePath(blob.key),
    size: blob.data.byteLength,
    sha256: await sha256Hex(blob.data),
  })));

  const payloadFiles: Array<{ path: string; bytes: Uint8Array; kind: BflowManifestEntry['kind']; count?: number }> = [
    jsonPayload('payload/sessions.json', exportData.sessions, 'sessions'),
    jsonPayload('payload/events.json', events, 'events'),
    jsonPayload('payload/steps.json', exportData.steps, 'steps'),
    jsonPayload('payload/network-logs.json', exportData.networkLogs, 'network-logs'),
    jsonPayload('payload/documents.json', documents, 'documents'),
    jsonPayload('payload/blob-index.json', blobIndex, 'blob-index'),
  ];

  const payloadEntries: BflowManifestEntry[] = [];
  for (const file of payloadFiles) {
    payloadEntries.push({
      path: file.path,
      kind: file.kind,
      count: file.count,
      size: file.bytes.byteLength,
      sha256: await sha256Hex(file.bytes),
    });
  }

  const blobEntries: BflowManifestEntry[] = blobIndex.map((row) => ({
    path: row.path,
    kind: 'blob',
    size: row.size,
    sha256: row.sha256,
  }));

  const manifest: BflowManifestV2 = {
    magic: BFLOW_MAGIC,
    formatVersion: BFLOW_FORMAT_VERSION,
    createdAt: Date.now(),
    featureName: exportData.featureName,
    producer: {
      product: 'BusinessFlow',
      version: String(chrome.runtime.getManifest().version ?? 'unknown'),
    },
    schemaVersions: {
      sessions: 1,
      events: 1,
      steps: 1,
      networkLogs: 1,
      documents: 1,
      blobIndex: 1,
    },
    entries: [...payloadEntries, ...blobEntries],
    integrity: {
      algorithm: 'sha256',
      payloadDigest: await sha256Hex(strToU8(JSON.stringify([...payloadEntries, ...blobEntries].map((entry) => ({
        path: entry.path,
        size: entry.size,
        sha256: entry.sha256,
      })).sort((a, b) => a.path.localeCompare(b.path))))),
    },
  };

  const archiveInput: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(manifest)),
  };
  for (const file of payloadFiles) {
    archiveInput[file.path] = file.bytes;
  }
  for (const blob of exportData.blobs) {
    archiveInput[blobArchivePath(blob.key)] = blob.data;
  }

  const zipped = zipSync(archiveInput, { level: 6 });
  return {
    blob: new Blob([zipped], { type: 'application/octet-stream' }),
    filename: `${sanitizeFilenameSegment(exportData.featureName, 'BusinessFlow-Export')}.bflow`,
  };
}

export async function importBflowArchiveAtomic(file: File): Promise<{ formatVersion: 1 | 2; imported: number }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parsed = await parseBflowArchive(bytes, { fileName: file.name });
  await importArchiveBundleAtomic(parsed.bundle);

  const imported =
    parsed.bundle.sessions.length +
    parsed.bundle.events.length +
    parsed.bundle.steps.length +
    parsed.bundle.networkLogs.length +
    parsed.bundle.documents.length +
    parsed.bundle.blobs.length;

  return { formatVersion: parsed.formatVersion, imported };
}

export async function parseBflowArchive(
  bytes: Uint8Array,
  context: { fileName?: string; limits?: ParseOptions } = {},
): Promise<ParsedArchive> {
  const limits: Required<ParseOptions> = { ...DEFAULT_LIMITS, ...(context.limits ?? {}) };

  if (bytes.byteLength === 0) throw new BflowArchiveError('Import failed: archive is empty.');
  if (bytes.byteLength > limits.maxArchiveBytes) {
    throw new BflowArchiveError(`Import failed: archive exceeds size limit (${limits.maxArchiveBytes} bytes).`);
  }

  let rawUnzipped: Record<string, Uint8Array>;
  try {
    rawUnzipped = unzipSync(bytes);
  } catch {
    throw new BflowArchiveError('Import failed: archive is not a valid .bflow zip.');
  }

  const unzipped: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  for (const [path, entryBytes] of Object.entries(rawUnzipped)) {
    if (isDangerousObjectKey(path)) {
      throw new BflowArchiveError(`Import failed: archive contains unsafe key (${path}).`);
    }
    unzipped[path] = entryBytes;
  }

  const paths = Object.keys(unzipped);
  if (paths.length === 0) throw new BflowArchiveError('Import failed: archive has no files.');
  if (paths.length > limits.maxEntries) throw new BflowArchiveError('Import failed: archive contains too many files.');

  let totalUnzippedBytes = 0;
  for (const path of paths) {
    assertSafePath(path);
    const entryBytes = unzipped[path];
    if (!entryBytes) throw new BflowArchiveError(`Import failed: archive entry is missing bytes (${path}).`);
    if (entryBytes.byteLength > limits.maxEntryBytes) {
      throw new BflowArchiveError(`Import failed: archive entry exceeds per-file size limit (${path}).`);
    }
    totalUnzippedBytes += entryBytes.byteLength;
    if (totalUnzippedBytes > limits.maxUnzippedBytes) {
      throw new BflowArchiveError('Import failed: archive expands beyond allowed size.');
    }
  }

  const manifestBytes = unzipped['manifest.json'];
  if (manifestBytes) {
    return parseV2Archive(unzipped, manifestBytes, limits);
  }

  const legacyData = unzipped['data.json'];
  if (legacyData) {
    return parseV1Archive(unzipped, legacyData, limits);
  }

  throw new BflowArchiveError('Import failed: unsupported .bflow structure (missing manifest.json/data.json).');
}

async function parseV2Archive(
  unzipped: Record<string, Uint8Array>,
  manifestBytes: Uint8Array,
  limits: Required<ParseOptions>,
): Promise<ParsedArchive> {
  const manifest = parseJson<BflowManifestV2>(manifestBytes, 'manifest.json', limits.maxJsonBytes);

  if (manifest.magic !== BFLOW_MAGIC) throw new BflowArchiveError('Import failed: invalid archive manifest magic.');
  if (typeof manifest.formatVersion !== 'number') throw new BflowArchiveError('Import failed: manifest missing formatVersion.');
  if (manifest.formatVersion > SUPPORTED_MAX_VERSION) {
    throw new BflowArchiveError(`Import failed: .bflow format v${manifest.formatVersion} is newer than this app supports.`);
  }
  if (manifest.formatVersion < SUPPORTED_MIN_VERSION) {
    throw new BflowArchiveError(`Import failed: .bflow format v${manifest.formatVersion} is too old.`);
  }
  if (manifest.formatVersion !== 2) {
    throw new BflowArchiveError(`Import failed: manifest version v${manifest.formatVersion} is not handled by v2 parser.`);
  }

  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new BflowArchiveError('Import failed: manifest entries are missing.');
  }

  const entryByPath = new Map<string, BflowManifestEntry>();
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.path !== 'string') throw new BflowArchiveError('Import failed: manifest entry path is invalid.');
    assertSafePath(entry.path);
    if (entryByPath.has(entry.path)) throw new BflowArchiveError(`Import failed: duplicate manifest entry path ${entry.path}.`);
    if (typeof entry.size !== 'number' || entry.size < 0) throw new BflowArchiveError(`Import failed: manifest size invalid for ${entry.path}.`);
    if (typeof entry.sha256 !== 'string' || entry.sha256.length !== 64) {
      throw new BflowArchiveError(`Import failed: manifest checksum invalid for ${entry.path}.`);
    }
    entryByPath.set(entry.path, entry);
  }

  for (const path of REQUIRED_V2_JSON_PATHS) {
    if (!entryByPath.has(path)) throw new BflowArchiveError(`Import failed: manifest missing required entry ${path}.`);
    if (!unzipped[path]) throw new BflowArchiveError(`Import failed: archive missing required file ${path}.`);
  }

  for (const [path, entry] of entryByPath) {
    const bytes = unzipped[path];
    if (!bytes) throw new BflowArchiveError(`Import failed: file declared in manifest is missing: ${path}.`);
    if (bytes.byteLength !== entry.size) throw new BflowArchiveError(`Import failed: size mismatch for ${path}.`);
    const digest = await sha256Hex(bytes);
    if (digest !== entry.sha256) throw new BflowArchiveError(`Import failed: checksum mismatch for ${path}.`);
  }

  const sessions = parseJsonArray<Session>(requiredBytes(unzipped, 'payload/sessions.json'), 'payload/sessions.json', limits);
  const events = parseJsonArray<TestEvent>(requiredBytes(unzipped, 'payload/events.json'), 'payload/events.json', limits);
  const steps = parseJsonArray<Step>(requiredBytes(unzipped, 'payload/steps.json'), 'payload/steps.json', limits);
  const networkLogs = parseJsonArray<NetworkLog>(requiredBytes(unzipped, 'payload/network-logs.json'), 'payload/network-logs.json', limits);
  const documents = parseJsonArray<DocModel>(requiredBytes(unzipped, 'payload/documents.json'), 'payload/documents.json', limits);
  const blobIndex = parseJsonArray<BflowBlobIndexRow>(requiredBytes(unzipped, 'payload/blob-index.json'), 'payload/blob-index.json', limits);

  validateCollectionLimit('sessions', sessions, limits);
  validateCollectionLimit('events', events, limits);
  validateCollectionLimit('steps', steps, limits);
  validateCollectionLimit('network logs', networkLogs, limits);
  validateCollectionLimit('documents', documents, limits);
  validateCollectionLimit('blob index', blobIndex, limits);

  assertUnique('session id', sessions.map((session) => session.id));
  assertUnique('event id', events.map((event) => event.id));
  assertUnique('step id', steps.map((step) => step.id));
  assertUnique('network log id', networkLogs.map((log) => log.id));
  assertUnique('document id', documents.map((doc) => doc.id));
  assertUnique('blob key', blobIndex.map((blob) => blob.key));

  const sessionIds = new Set(sessions.map((session) => session.id));
  for (const event of events) {
    if (!sessionIds.has(event.sessionId)) {
      throw new BflowArchiveError(`Import failed: event ${event.id} references missing session ${event.sessionId}.`);
    }
  }
  for (const step of steps) {
    if (!sessionIds.has(step.sessionId)) {
      throw new BflowArchiveError(`Import failed: step ${step.id} references missing session ${step.sessionId}.`);
    }
  }
  for (const log of networkLogs) {
    if (!sessionIds.has(log.sessionId)) {
      throw new BflowArchiveError(`Import failed: network log ${log.id} references missing session ${log.sessionId}.`);
    }
  }

  const eventIds = new Set(events.map((event) => event.id));
  const blobKeys = new Set(blobIndex.map((blob) => blob.key));

  for (const step of steps) {
    if (step.beforeEvidenceEventId && !eventIds.has(step.beforeEvidenceEventId)) {
      throw new BflowArchiveError(`Import failed: step ${step.id} beforeEvidenceEventId is missing (${step.beforeEvidenceEventId}).`);
    }
    if (step.afterEvidenceEventId && !eventIds.has(step.afterEvidenceEventId)) {
      throw new BflowArchiveError(`Import failed: step ${step.id} afterEvidenceEventId is missing (${step.afterEvidenceEventId}).`);
    }
  }

  for (const event of events) {
    if (event.kind === 'evidence_stored' && !blobKeys.has(event.blobKey)) {
      throw new BflowArchiveError(`Import failed: evidence event ${event.id} references missing blob ${event.blobKey}.`);
    }
  }

  const blobs: BlobRecord[] = [];
  for (const row of blobIndex) {
    if (!sessionIds.has(row.sessionId)) {
      throw new BflowArchiveError(`Import failed: blob ${row.key} references missing session ${row.sessionId}.`);
    }

    assertSafePath(row.path);
    const bytes = unzipped[row.path];
    if (!bytes) throw new BflowArchiveError(`Import failed: blob bytes missing for ${row.key}.`);
    if (bytes.byteLength !== row.size) throw new BflowArchiveError(`Import failed: blob size mismatch for ${row.key}.`);

    const digest = await sha256Hex(bytes);
    if (digest !== row.sha256) throw new BflowArchiveError(`Import failed: blob checksum mismatch for ${row.key}.`);

    blobs.push({
      key: row.key,
      sessionId: row.sessionId,
      mimeType: row.mimeType,
      storedAt: row.storedAt,
      data: bytes,
    });
  }

  const computedDigest = await sha256Hex(strToU8(JSON.stringify(manifest.entries
    .map((entry) => ({ path: entry.path, size: entry.size, sha256: entry.sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path)))));
  if (computedDigest !== manifest.integrity.payloadDigest) {
    throw new BflowArchiveError('Import failed: manifest payload digest mismatch.');
  }

  return {
    formatVersion: 2,
    featureName: manifest.featureName,
    exportedAt: manifest.createdAt,
    bundle: {
      sessions,
      events,
      steps,
      networkLogs,
      documents,
      blobs,
    },
  };
}

function parseV1Archive(
  unzipped: Record<string, Uint8Array>,
  dataBytes: Uint8Array,
  limits: Required<ParseOptions>,
): ParsedArchive {
  const data = parseJson<V1DataFile>(dataBytes, 'data.json', limits.maxJsonBytes);
  if (data.version !== 1) {
    throw new BflowArchiveError(`Import failed: legacy data.json has unsupported version ${String((data as { version?: unknown }).version)}.`);
  }

  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const steps = Array.isArray(data.steps) ? data.steps : [];
  const networkLogs = Array.isArray(data.networkLogs) ? data.networkLogs : [];
  const blobMeta = Array.isArray(data.blobs) ? data.blobs : [];

  validateCollectionLimit('sessions', sessions, limits);
  validateCollectionLimit('steps', steps, limits);
  validateCollectionLimit('network logs', networkLogs, limits);
  validateCollectionLimit('blob metadata', blobMeta, limits);

  assertUnique('session id', sessions.map((session) => session.id));
  assertUnique('step id', steps.map((step) => step.id));
  assertUnique('network log id', networkLogs.map((log) => log.id));
  assertUnique('blob key', blobMeta.map((blob) => blob.key));

  const sessionIds = new Set(sessions.map((session) => session.id));
  for (const step of steps) {
    if (!sessionIds.has(step.sessionId)) {
      throw new BflowArchiveError(`Import failed: step ${step.id} references missing session ${step.sessionId}.`);
    }
  }
  for (const log of networkLogs) {
    if (!sessionIds.has(log.sessionId)) {
      throw new BflowArchiveError(`Import failed: network log ${log.id} references missing session ${log.sessionId}.`);
    }
  }

  const blobs: BlobRecord[] = [];
  for (const meta of blobMeta) {
    if (!sessionIds.has(meta.sessionId)) {
      throw new BflowArchiveError(`Import failed: blob ${meta.key} references missing session ${meta.sessionId}.`);
    }

    const path = blobArchivePath(meta.key, 'images');
    const imageBytes = unzipped[path];
    if (!imageBytes) {
      throw new BflowArchiveError(`Import failed: missing blob bytes for key ${meta.key} in legacy archive.`);
    }

    blobs.push({
      key: meta.key,
      data: imageBytes,
      mimeType: meta.mimeType,
      storedAt: meta.storedAt,
      sessionId: meta.sessionId,
    });
  }

  return {
    formatVersion: 1,
    featureName: typeof data.featureName === 'string' ? data.featureName : 'Imported Feature',
    exportedAt: typeof data.exportedAt === 'number' ? data.exportedAt : Date.now(),
    bundle: {
      sessions,
      events: [],
      steps,
      networkLogs,
      documents: [],
      blobs,
    },
  };
}

function jsonPayload(path: string, value: unknown, kind: BflowManifestEntry['kind']): {
  path: string;
  bytes: Uint8Array;
  kind: BflowManifestEntry['kind'];
  count?: number;
} {
  const bytes = strToU8(JSON.stringify(value));
  return {
    path,
    bytes,
    kind,
    ...(Array.isArray(value) ? { count: value.length } : {}),
  };
}

function blobArchivePath(key: string, folder: 'blobs' | 'images' = 'blobs'): string {
  return `${folder}/${key}.bin`;
}

function parseJson<T>(bytes: Uint8Array, filePath: string, maxJsonBytes: number): T {
  if (bytes.byteLength > maxJsonBytes) throw new BflowArchiveError(`Import failed: ${filePath} exceeds JSON size limit.`);
  try {
    return JSON.parse(strFromU8(bytes)) as T;
  } catch {
    throw new BflowArchiveError(`Import failed: ${filePath} is not valid JSON.`);
  }
}

function requiredBytes(unzipped: Record<string, Uint8Array>, path: string): Uint8Array {
  const bytes = unzipped[path];
  if (!bytes) throw new BflowArchiveError(`Import failed: archive missing required file ${path}.`);
  return bytes;
}

function parseJsonArray<T>(bytes: Uint8Array, filePath: string, limits: Required<ParseOptions>): T[] {
  const value = parseJson<unknown>(bytes, filePath, limits.maxJsonBytes);
  if (!Array.isArray(value)) throw new BflowArchiveError(`Import failed: ${filePath} must be an array.`);
  return value as T[];
}

function validateCollectionLimit(name: string, rows: unknown[], limits: Required<ParseOptions>): void {
  if (rows.length > limits.maxRecordsPerCollection) {
    throw new BflowArchiveError(`Import failed: ${name} exceeds record limit (${limits.maxRecordsPerCollection}).`);
  }
}

function assertUnique(label: string, ids: Array<string | undefined>): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || typeof id !== 'string') throw new BflowArchiveError(`Import failed: ${label} is missing or invalid.`);
    if (seen.has(id)) throw new BflowArchiveError(`Import failed: duplicate ${label} "${id}".`);
    seen.add(id);
  }
}

function assertSafePath(path: string): void {
  if (!path || path.startsWith('/') || path.startsWith('\\')) {
    throw new BflowArchiveError(`Import failed: archive path is unsafe (${path}).`);
  }
  if (path.includes('..') || path.includes('\0')) {
    throw new BflowArchiveError(`Import failed: archive path is unsafe (${path}).`);
  }
}

function isDangerousObjectKey(path: string): boolean {
  return path === '__proto__' || path === 'prototype' || path === 'constructor';
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const normalized = new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', normalized);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
