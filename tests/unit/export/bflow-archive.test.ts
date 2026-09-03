import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { parseBflowArchive } from '../../../src/ui/export/bflow/archive.js';
import {
  createInvalidZipFixture,
  createLegacyV1ArchiveFixture,
  createValidV2ArchiveFixture,
} from '../../fixtures/bflow-archives.js';

describe('bflow archive integrity parser', () => {
  it('parses valid v2 archive with manifest + integrity checks', async () => {
    const fixture = await createValidV2ArchiveFixture();

    const parsed = await parseBflowArchive(fixture.bytes, { fileName: 'valid.bflow' });

    expect(parsed.formatVersion).toBe(2);
    expect(parsed.bundle.sessions).toHaveLength(1);
    expect(parsed.bundle.events).toHaveLength(1);
    expect(parsed.bundle.steps).toHaveLength(1);
    expect(parsed.bundle.networkLogs).toHaveLength(1);
    expect(parsed.bundle.documents).toHaveLength(1);
    expect(parsed.bundle.blobs).toHaveLength(1);
  });

  it('supports legacy v1 archive shape for backward compatibility', async () => {
    const parsed = await parseBflowArchive(createLegacyV1ArchiveFixture(), { fileName: 'legacy.bflow' });
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.bundle.events).toHaveLength(0);
    expect(parsed.bundle.documents).toHaveLength(0);
    expect(parsed.bundle.blobs).toHaveLength(1);
  });

  it('fails on corrupted zip data', async () => {
    await expect(parseBflowArchive(createInvalidZipFixture())).rejects.toThrow(/not a valid .bflow zip/i);
  });

  it('fails on unknown future format version', async () => {
    const fixture = await createValidV2ArchiveFixture();
    const archive = unzipSync(fixture.bytes);
    const manifestBytes = archive['manifest.json'];
    if (!manifestBytes) throw new Error('missing manifest fixture');
    const manifest = JSON.parse(strFromU8(manifestBytes)) as Record<string, unknown>;
    manifest.formatVersion = 99;
    archive['manifest.json'] = strToU8(JSON.stringify(manifest));

    await expect(parseBflowArchive(zipSync(archive))).rejects.toThrow(/newer than this app supports/i);
  });

  it('fails when manifest is incomplete', async () => {
    const fixture = await createValidV2ArchiveFixture();
    const archive = unzipSync(fixture.bytes);
    const manifestBytes = archive['manifest.json'];
    if (!manifestBytes) throw new Error('missing manifest fixture');
    const manifest = JSON.parse(strFromU8(manifestBytes)) as { entries: Array<{ path: string }> };
    manifest.entries = manifest.entries.filter((entry) => entry.path !== 'payload/events.json');
    archive['manifest.json'] = strToU8(JSON.stringify(manifest));

    await expect(parseBflowArchive(zipSync(archive))).rejects.toThrow(/manifest missing required entry payload\/events.json/i);
  });

  it('fails when blob bytes are missing', async () => {
    const fixture = await createValidV2ArchiveFixture();
    const archive = unzipSync(fixture.bytes);
    delete archive['blobs/blob-1.bin'];

    await expect(parseBflowArchive(zipSync(archive))).rejects.toThrow(/missing: blobs\/blob-1.bin|blob bytes missing/i);
  });

  it('fails when blob checksum is corrupted', async () => {
    const fixture = await createValidV2ArchiveFixture();
    const archive = unzipSync(fixture.bytes);
    archive['blobs/blob-1.bin'] = strToU8('evil-image');

    await expect(parseBflowArchive(zipSync(archive))).rejects.toThrow(/checksum mismatch/i);
  });

  it('fails on duplicate IDs', async () => {
    const fixture = await createValidV2ArchiveFixture();
    const archive = unzipSync(fixture.bytes);
    const sessionsBytes = archive['payload/sessions.json'];
    if (!sessionsBytes) throw new Error('missing sessions fixture');
    const sessions = JSON.parse(strFromU8(sessionsBytes)) as unknown[];
    sessions.push(sessions[0]);
    archive['payload/sessions.json'] = strToU8(JSON.stringify(sessions));

    const manifestBytes = archive['manifest.json'];
    if (!manifestBytes) throw new Error('missing manifest fixture');
    const manifest = JSON.parse(strFromU8(manifestBytes)) as {
      entries: Array<{ path: string; size: number; sha256: string }>;
      integrity: { algorithm: 'sha256'; payloadDigest: string };
    };
    const sessionEntry = manifest.entries.find((entry) => entry.path === 'payload/sessions.json');
    if (sessionEntry) {
      sessionEntry.size = archive['payload/sessions.json'].byteLength;
      sessionEntry.sha256 = await sha256Hex(archive['payload/sessions.json']);
    }
    manifest.integrity = {
      algorithm: 'sha256',
      payloadDigest: await payloadDigest(manifest.entries),
    };
    archive['manifest.json'] = strToU8(JSON.stringify(manifest));

    await expect(parseBflowArchive(zipSync(archive))).rejects.toThrow(/duplicate session id/i);
  });

  it('fails on invalid references', async () => {
    const fixture = await createValidV2ArchiveFixture();
    const archive = unzipSync(fixture.bytes);
    const stepsBytes = archive['payload/steps.json'];
    if (!stepsBytes) throw new Error('missing steps fixture');
    const steps = JSON.parse(strFromU8(stepsBytes)) as Array<{ sessionId: string }>;
    if (!steps[0]) throw new Error('missing step fixture');
    steps[0].sessionId = 'missing-session';
    archive['payload/steps.json'] = strToU8(JSON.stringify(steps));

    const manifestBytes = archive['manifest.json'];
    if (!manifestBytes) throw new Error('missing manifest fixture');
    const manifest = JSON.parse(strFromU8(manifestBytes)) as {
      entries: Array<{ path: string; size: number; sha256: string }>;
      integrity: { algorithm: 'sha256'; payloadDigest: string };
    };
    const stepEntry = manifest.entries.find((entry) => entry.path === 'payload/steps.json');
    if (stepEntry) {
      stepEntry.size = archive['payload/steps.json'].byteLength;
      stepEntry.sha256 = await sha256Hex(archive['payload/steps.json']);
    }
    manifest.integrity = {
      algorithm: 'sha256',
      payloadDigest: await payloadDigest(manifest.entries),
    };
    archive['manifest.json'] = strToU8(JSON.stringify(manifest));

    await expect(parseBflowArchive(zipSync(archive))).rejects.toThrow(/references missing session/i);
  });

  it('fails on malicious path traversal in manifest', async () => {
    const fixture = await createValidV2ArchiveFixture();
    const archive = unzipSync(fixture.bytes);
    const manifestBytes = archive['manifest.json'];
    if (!manifestBytes) throw new Error('missing manifest fixture');
    const manifest = JSON.parse(strFromU8(manifestBytes)) as { entries: Array<{ path: string }> };
    if (!manifest.entries[0]) throw new Error('missing manifest entries fixture');
    manifest.entries[0].path = '../payload/sessions.json';
    archive['manifest.json'] = strToU8(JSON.stringify(manifest));

    await expect(parseBflowArchive(zipSync(archive))).rejects.toThrow(/path is unsafe/i);
  });

  it('fails when any single archive entry exceeds configured entry size limit', async () => {
    const fixture = await createValidV2ArchiveFixture();
    await expect(parseBflowArchive(fixture.bytes, { limits: { maxEntryBytes: 10 } })).rejects.toThrow(/per-file size limit/i);
  });

  it('fails when archive exceeds configured size limits', async () => {
    const fixture = await createValidV2ArchiveFixture();
    await expect(parseBflowArchive(fixture.bytes, { limits: { maxArchiveBytes: 1 } })).rejects.toThrow(/exceeds size limit/i);
  });
});

async function sha256Hex(data: Uint8Array): Promise<string> {
  const normalized = new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', normalized);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function payloadDigest(entries: Array<{ path: string; size: number; sha256: string }>): Promise<string> {
  const canonical = JSON.stringify(entries
    .map((entry) => ({ path: entry.path, size: entry.size, sha256: entry.sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path)));
  return sha256Hex(strToU8(canonical));
}
