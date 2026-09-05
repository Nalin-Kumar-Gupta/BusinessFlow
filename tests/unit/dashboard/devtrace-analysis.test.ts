import { describe, expect, it } from 'vitest';

import type { NetworkLog, TestEvent } from '../../../src/core/types.js';
import {
  buildDiagnosticIssues,
  inferRootCauseSummary,
  type ConsoleDiagnosticEvent,
} from '../../../src/ui/dashboard/devtrace-analysis.js';

function networkLogFixture(overrides: Partial<NetworkLog>): NetworkLog {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    sessionId: overrides.sessionId ?? 's1',
    method: overrides.method ?? 'GET',
    url: overrides.url ?? 'https://example.com/api/items',
    status: overrides.status ?? 200,
    timestamp: overrides.timestamp ?? Date.now(),
    durationMs: overrides.durationMs ?? 120,
    requestBody: overrides.requestBody,
    responseBody: overrides.responseBody,
  };
}

function pageErrorEvent(id: string): TestEvent {
  return {
    id,
    sessionId: 's1',
    ts: Date.now(),
    seq: 1,
    tabId: 1,
    kind: 'page_error',
    confidence: 'observed',
    type: 'uncaught',
    message: 'TypeError: Cannot read properties of undefined',
  };
}

function webVitalEvent(id: string, rating: 'good' | 'needs-improvement' | 'poor'): TestEvent {
  return {
    id,
    sessionId: 's1',
    ts: Date.now(),
    seq: 1,
    tabId: 1,
    kind: 'web_vital',
    confidence: 'observed',
    name: 'LCP',
    value: 4300,
    rating,
  };
}

function longTaskEvent(id: string, duration = 250): TestEvent {
  return {
    id,
    sessionId: 's1',
    ts: Date.now(),
    seq: 1,
    tabId: 1,
    kind: 'long_task',
    confidence: 'observed',
    duration,
    startTime: 100,
  };
}

describe('devtrace-analysis', () => {
  it('prioritizes repeated critical network failures', () => {
    const logs: NetworkLog[] = [
      networkLogFixture({ id: 'n1', method: 'POST', url: 'https://example.com/api/orders', status: 500 }),
      networkLogFixture({ id: 'n2', method: 'POST', url: 'https://example.com/api/orders', status: 502 }),
      networkLogFixture({ id: 'n3', method: 'POST', url: 'https://example.com/api/orders', status: 500 }),
      networkLogFixture({ id: 'n4', method: 'GET', url: 'https://example.com/api/profile', status: 404 }),
    ];
    const issues = buildDiagnosticIssues(logs, [], []);

    expect(issues[0]?.id).toBe('network-critical');
    expect(issues[0]?.count).toBe(3);
    expect(issues[0]?.detail).toContain('repeated 3x');
  });

  it('dedupes repeated console errors with dynamic values', () => {
    const consoleEvents: ConsoleDiagnosticEvent[] = [
      { id: 'c1', ts: 1, level: 'error', message: 'Failed to load user 12345' },
      { id: 'c2', ts: 2, level: 'error', message: 'Failed to load user 67890' },
      { id: 'c3', ts: 3, level: 'warn', message: 'Minor warning' },
    ];

    const issues = buildDiagnosticIssues([], consoleEvents, []);
    const consoleIssue = issues.find((issue) => issue.id === 'console-errors');

    expect(consoleIssue?.count).toBe(2);
    expect(consoleIssue?.detail).toContain('repeated 2x');
  });

  it('infers backend-likely root cause for transport-heavy failures', () => {
    const logs: NetworkLog[] = [
      networkLogFixture({ status: 500 }),
      networkLogFixture({ status: 503 }),
      networkLogFixture({ status: 0 }),
    ];

    const summary = inferRootCauseSummary(logs, [], []);
    expect(summary.verdict).toBe('backend-likely');
    expect(['high', 'medium']).toContain(summary.confidence);
  });

  it('infers frontend-likely root cause without critical network failures', () => {
    const summary = inferRootCauseSummary(
      [networkLogFixture({ status: 200 })],
      [{ id: 'c1', ts: 1, level: 'error', message: 'Hydration mismatch' }],
      [pageErrorEvent('p1')],
    );

    expect(summary.verdict).toBe('frontend-likely');
  });

  it('infers performance-likely when vitals and long tasks are poor', () => {
    const summary = inferRootCauseSummary(
      [networkLogFixture({ status: 200 })],
      [],
      [
        webVitalEvent('v1', 'poor'),
        webVitalEvent('v2', 'poor'),
        longTaskEvent('l1', 320),
      ],
    );

    expect(summary.verdict).toBe('performance-likely');
  });
});
