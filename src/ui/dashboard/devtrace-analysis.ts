import type { NetworkLog, TestEvent } from '../../core/types.js';

export type DevTracePane = 'network' | 'console' | 'performance' | 'timeline' | 'issues';
export type IssueSeverity = 'critical' | 'warning' | 'info';

export interface ConsoleDiagnosticEvent {
  id: string;
  ts: number;
  level: 'error' | 'warn';
  message: string;
  pageUrl?: string;
}

export interface DiagnosticIssue {
  id: string;
  severity: IssueSeverity;
  score: number;
  title: string;
  count: number;
  detail: string;
  panel: Exclude<DevTracePane, 'issues'>;
  suggestedStatusFilter?: 'critical' | 'warning';
  suggestedConsoleFilter?: 'error' | 'warn';
}

export interface RootCauseSummary {
  verdict: 'backend-likely' | 'frontend-likely' | 'performance-likely' | 'mixed' | 'inconclusive';
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  recommendations: string[];
}

function endpointPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function normalizeMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '{uuid}')
    .replace(/\b\d+\b/g, '{n}')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyNetworkStatus(status: number): 'critical' | 'warning' | 'success' {
  if (status >= 500 || status === 0) return 'critical';
  if (status >= 400) return 'warning';
  return 'success';
}

function groupByCount<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const bucket = out.get(key) ?? [];
    bucket.push(item);
    out.set(key, bucket);
  }
  return out;
}

function topRepeatedNetworkFailure(logs: readonly NetworkLog[], severity: 'critical' | 'warning'): { key: string; count: number; sample: NetworkLog } | null {
  const filtered = logs.filter((log) => classifyNetworkStatus(log.status) === severity);
  if (filtered.length === 0) return null;
  const grouped = groupByCount(filtered, (log) => `${log.method} ${endpointPath(log.url)} ${severity}`);
  const ranked = [...grouped.entries()]
    .map(([key, group]) => ({ key, count: group.length, sample: group[0]! }))
    .sort((a, b) => b.count - a.count);
  return ranked[0] ?? null;
}

function topRepeatedConsoleError(events: readonly ConsoleDiagnosticEvent[]): { count: number; sample: ConsoleDiagnosticEvent } | null {
  const errors = events.filter((event) => event.level === 'error');
  if (errors.length === 0) return null;
  const grouped = groupByCount(errors, (event) => normalizeMessage(event.message));
  const ranked = [...grouped.values()]
    .map((group) => ({ count: group.length, sample: group[0]! }))
    .sort((a, b) => b.count - a.count);
  return ranked[0] ?? null;
}

function getWebVitalStats(events: readonly TestEvent[]): { poor: number; needsImprovement: number } {
  const vitals = events.filter((event): event is Extract<TestEvent, { kind: 'web_vital' }> => event.kind === 'web_vital');
  return {
    poor: vitals.filter((event) => event.rating === 'poor').length,
    needsImprovement: vitals.filter((event) => event.rating === 'needs-improvement').length,
  };
}

function getLongTaskStats(events: readonly TestEvent[]): { severe: number; total: number } {
  const longTasks = events.filter((event): event is Extract<TestEvent, { kind: 'long_task' }> => event.kind === 'long_task');
  return {
    severe: longTasks.filter((event) => event.duration >= 200).length,
    total: longTasks.length,
  };
}

function getPageErrorCount(events: readonly TestEvent[]): number {
  return events.filter((event): event is Extract<TestEvent, { kind: 'page_error' }> => event.kind === 'page_error').length;
}

function scoreFromCount(count: number, base: number): number {
  if (count <= 0) return 0;
  return base + Math.min(40, count * 4);
}

export function buildDiagnosticIssues(
  logs: readonly NetworkLog[],
  consoleEvents: readonly ConsoleDiagnosticEvent[],
  events: readonly TestEvent[],
): DiagnosticIssue[] {
  const criticalNetworkCount = logs.filter((log) => classifyNetworkStatus(log.status) === 'critical').length;
  const warningNetworkCount = logs.filter((log) => classifyNetworkStatus(log.status) === 'warning').length;
  const pageErrorCount = getPageErrorCount(events);
  const consoleErrorCount = consoleEvents.filter((event) => event.level === 'error').length;
  const webVitals = getWebVitalStats(events);
  const longTasks = getLongTaskStats(events);

  const topCriticalFailure = topRepeatedNetworkFailure(logs, 'critical');
  const topWarningFailure = topRepeatedNetworkFailure(logs, 'warning');
  const topConsoleError = topRepeatedConsoleError(consoleEvents);

  const issues: DiagnosticIssue[] = [
    {
      id: 'network-critical',
      severity: 'critical',
      score: scoreFromCount(criticalNetworkCount, 70),
      title: 'Critical network failures',
      count: criticalNetworkCount,
      detail: topCriticalFailure
        ? `${topCriticalFailure.key} repeated ${topCriticalFailure.count}x`
        : 'No 5xx / transport errors',
      panel: 'network',
      suggestedStatusFilter: 'critical',
    },
    {
      id: 'network-warning',
      severity: 'warning',
      score: scoreFromCount(warningNetworkCount, 50),
      title: 'Client/API warning responses',
      count: warningNetworkCount,
      detail: topWarningFailure
        ? `${topWarningFailure.key} repeated ${topWarningFailure.count}x`
        : 'No 4xx responses',
      panel: 'network',
      suggestedStatusFilter: 'warning',
    },
    {
      id: 'page-errors',
      severity: pageErrorCount > 0 ? 'critical' : 'info',
      score: scoreFromCount(pageErrorCount, 60),
      title: 'Runtime page errors',
      count: pageErrorCount,
      detail: pageErrorCount > 0 ? `${pageErrorCount} uncaught browser exception(s)` : 'No uncaught browser exceptions',
      panel: 'console',
      suggestedConsoleFilter: 'error',
    },
    {
      id: 'console-errors',
      severity: consoleErrorCount > 0 ? 'warning' : 'info',
      score: scoreFromCount(consoleErrorCount, 45),
      title: 'Console errors',
      count: consoleErrorCount,
      detail: topConsoleError
        ? `"${topConsoleError.sample.message.slice(0, 90)}" repeated ${topConsoleError.count}x`
        : 'No console.error entries',
      panel: 'console',
      suggestedConsoleFilter: 'error',
    },
    {
      id: 'poor-vitals',
      severity: webVitals.poor > 0 ? 'warning' : 'info',
      score: scoreFromCount(webVitals.poor, 35),
      title: 'Poor Web Vitals',
      count: webVitals.poor,
      detail: webVitals.poor > 0
        ? `${webVitals.poor} poor, ${webVitals.needsImprovement} needs improvement`
        : 'Vitals look healthy',
      panel: 'performance',
    },
    {
      id: 'long-tasks',
      severity: longTasks.severe > 0 ? 'warning' : 'info',
      score: scoreFromCount(longTasks.severe, 30),
      title: 'Long main-thread tasks (>200ms)',
      count: longTasks.severe,
      detail: longTasks.severe > 0
        ? `${longTasks.severe} severe long task(s), ${longTasks.total} total`
        : 'No severe long tasks',
      panel: 'performance',
    },
  ];

  return issues
    .sort((a, b) => b.score - a.score)
    .filter((issue, index, arr) => {
      if (issue.count > 0) return true;
      return index < 2 || arr.every((candidate) => candidate.count === 0);
    });
}

export function inferRootCauseSummary(
  logs: readonly NetworkLog[],
  consoleEvents: readonly ConsoleDiagnosticEvent[],
  events: readonly TestEvent[],
): RootCauseSummary {
  const criticalNetworkCount = logs.filter((log) => classifyNetworkStatus(log.status) === 'critical').length;
  const warningNetworkCount = logs.filter((log) => classifyNetworkStatus(log.status) === 'warning').length;
  const pageErrorCount = getPageErrorCount(events);
  const consoleErrorCount = consoleEvents.filter((event) => event.level === 'error').length;
  const webVitals = getWebVitalStats(events);
  const longTasks = getLongTaskStats(events);

  const frontendErrorCount = pageErrorCount + consoleErrorCount;
  const perfPressure = webVitals.poor + longTasks.severe;

  if (criticalNetworkCount >= 2 && frontendErrorCount <= 1) {
    return {
      verdict: 'backend-likely',
      confidence: criticalNetworkCount >= 4 ? 'high' : 'medium',
      summary: `${criticalNetworkCount} critical network failures with limited frontend exceptions suggest backend or edge instability.`,
      recommendations: [
        'Open Network panel and filter 5xx / ERR to inspect repeated endpoints.',
        'Use Correlation tab values (x-request-id, cf-ray) in backend logs.',
        'Check recent deploys for impacted endpoint families.',
      ],
    };
  }

  if (criticalNetworkCount === 0 && frontendErrorCount >= 2) {
    return {
      verdict: 'frontend-likely',
      confidence: frontendErrorCount >= 4 ? 'high' : 'medium',
      summary: `${frontendErrorCount} frontend runtime/console errors with no critical transport failures point to client-side defects.`,
      recommendations: [
        'Open Console panel and dedupe repeated errors first.',
        'Correlate stack traces with timeline step transitions.',
        'Verify release bundle/source map alignment.',
      ],
    };
  }

  if (perfPressure >= 2 && criticalNetworkCount <= 1) {
    return {
      verdict: 'performance-likely',
      confidence: perfPressure >= 4 ? 'high' : 'medium',
      summary: `Performance pressure detected (${webVitals.poor} poor vitals, ${longTasks.severe} severe long tasks).`,
      recommendations: [
        'Open Performance panel and inspect long-task concentration.',
        'Profile heavy render paths around INP/LCP spikes.',
        'Audit expensive synchronous work and large bundles.',
      ],
    };
  }

  if (criticalNetworkCount > 0 && frontendErrorCount > 0) {
    return {
      verdict: 'mixed',
      confidence: 'medium',
      summary: `Mixed failure signature: network failures (${criticalNetworkCount}) and frontend exceptions (${frontendErrorCount}) co-occur.`,
      recommendations: [
        'Start in Issues panel and follow highest-score item first.',
        'Use Timeline to establish ordering (network first vs JS first).',
        'Verify whether frontend fallback logic amplifies backend errors.',
      ],
    };
  }

  return {
    verdict: 'inconclusive',
    confidence: warningNetworkCount > 0 ? 'medium' : 'low',
    summary: warningNetworkCount > 0
      ? `Only warning-level signals detected (${warningNetworkCount} client/API warnings).`
      : 'No clear failure signal detected in this run.',
    recommendations: [
      'Review Timeline around suspect user steps.',
      'Re-run capture with the same scenario to confirm reproducibility.',
      'Compare against the latest passing run for drift.',
    ],
  };
}
