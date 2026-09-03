import { describe, expect, it } from 'vitest';

import type { Session } from '../../../src/core/types.js';
import type { SessionExportBundle } from '../../../src/storage/db.js';
import {
  buildExportPreflightSummary,
  defaultExportFormat,
  exportEligibilityIssue,
  isExportModalContextValid,
  isFormatSessionScoped,
  resolveSessionForExport,
} from '../../../src/ui/dashboard/export-ux.js';

function sessionFixture(id: string, startedAt = 1000): Session {
  return {
    id,
    featureName: 'Checkout',
    testCaseName: 'Payment failure',
    mode: 'guided',
    negativeTest: 'yes',
    negativeTestSource: 'user',
    recordingState: 'stopped',
    startedAt,
    endedAt: startedAt + 5000,
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
      networkRequests: 2,
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

function bundleFixture(session: Session): SessionExportBundle {
  return {
    session,
    events: [
      {
        id: 'ev-1',
        sessionId: session.id,
        ts: 1200,
        seq: 1,
        kind: 'evidence_stored',
        tabId: 1,
        confidence: 'observed',
        requestedEventId: 'req-1',
        trigger: 'manual',
        blobKey: 'blob-1',
        width: 100,
        height: 100,
        bytes: 10,
        format: 'image/jpeg',
      },
      {
        id: 'ev-2',
        sessionId: session.id,
        ts: 1300,
        seq: 2,
        kind: 'evidence_stored',
        tabId: 1,
        confidence: 'observed',
        requestedEventId: 'req-2',
        trigger: 'manual',
        blobKey: 'blob-missing',
        width: 100,
        height: 100,
        bytes: 10,
        format: 'image/jpeg',
      },
    ],
    steps: [
      {
        id: 'step-1',
        sessionId: session.id,
        tabId: 1,
        index: 1,
        ts: 1100,
        seq: 1,
        label: 'Click submit',
        clickEventIds: ['click-1'],
        openedAt: 1100,
        stabilityWindowMs: 1200,
        noAfterNeeded: false,
        state: 'done',
        timingMode: 'auto',
        timingSource: 'timeout',
        bugs: [{ id: 'bug-1', description: 'Wrong message' }],
      } as unknown as SessionExportBundle['steps'][number],
    ],
    networkLogs: [
      {
        id: 'net-1',
        sessionId: session.id,
        method: 'POST',
        url: 'https://example.com/api',
        status: 500,
        timestamp: 1400,
        durationMs: 200,
      },
    ],
    blobs: [{ key: 'blob-1', mimeType: 'image/jpeg', storedAt: 1300, sessionId: session.id }],
  };
}

describe('dashboard export UX helpers', () => {
  it('defaults to PDF for quickest share path', () => {
    expect(defaultExportFormat()).toBe('pdf');
  });

  it('resolves selected vs latest run correctly', () => {
    const selected = sessionFixture('selected', 1000);
    const latest = sessionFixture('latest', 2000);

    expect(resolveSessionForExport('selected', selected, [latest])).toEqual(selected);
    expect(resolveSessionForExport('latest', selected, [latest])).toEqual(latest);
    expect(resolveSessionForExport('all', selected, [latest])).toBeNull();
    expect(resolveSessionForExport('selected', null, [latest])).toBeNull();
  });

  it('builds preflight summary and detects missing evidence', () => {
    const session = sessionFixture('sess-1');
    const summary = buildExportPreflightSummary(session, bundleFixture(session));

    expect(summary.stepCount).toBe(1);
    expect(summary.findingCount).toBe(1);
    expect(summary.requestCount).toBe(1);
    expect(summary.evidenceCount).toBe(1);
    expect(summary.missingEvidenceCount).toBe(1);
  });

  it('blocks session exports while run is still recording', () => {
    const activeSession = { ...sessionFixture('live'), recordingState: 'active' as const };

    expect(exportEligibilityIssue('pdf', activeSession)).toBe('Stop recording before exporting this run.');
    expect(exportEligibilityIssue('word', activeSession)).toBe('Stop recording before exporting this run.');
    expect(exportEligibilityIssue('excel', activeSession)).toBe('Stop recording before exporting this run.');
    expect(exportEligibilityIssue('bflow', activeSession)).toBeNull();
  });

  it('requires a run for session-scoped exports', () => {
    expect(exportEligibilityIssue('pdf', null)).toBe('No run selected for export.');
    expect(exportEligibilityIssue('bflow', null)).toBeNull();
  });

  it('allows stopped runs for session-scoped exports', () => {
    expect(exportEligibilityIssue('pdf', sessionFixture('ready'))).toBeNull();
  });

  it('marks .bflow as feature-scoped while others are run-scoped', () => {
    expect(isFormatSessionScoped('pdf')).toBe(true);
    expect(isFormatSessionScoped('word')).toBe(true);
    expect(isFormatSessionScoped('excel')).toBe(true);
    expect(isFormatSessionScoped('bflow')).toBe(false);
  });

  it('validates modal context ownership for feature vs test-case pages', () => {
    expect(isExportModalContextValid('feature', true, false)).toBe(true);
    expect(isExportModalContextValid('feature', true, true)).toBe(false);
    expect(isExportModalContextValid('test-case', true, true)).toBe(true);
    expect(isExportModalContextValid('test-case', true, false)).toBe(false);
    expect(isExportModalContextValid('feature', false, false)).toBe(false);
  });
});
