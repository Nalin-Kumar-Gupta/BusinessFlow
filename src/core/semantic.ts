// Semantic Report Builder — read-time transform on raw events.
//
// Architecture: raw events are stored verbatim during recording.
// ALL intelligence runs here at report-generation time. This means:
//  - No computation overhead during recording
//  - Intelligence can be improved without re-recording
//  - Multiple views of the same data possible
//
// Organized around the Chrome DevTools 5-layer framework:
//  Layer 1: Network & API (Network Panel)
//  Layer 2: Performance (Performance Panel + Lighthouse)
//  Layer 3: JavaScript & Runtime (Console Panel)
//  Layer 4: DOM & Accessibility (Elements Panel)
//  Layer 5: Memory & Storage (Application Panel)

import type {
  TestEvent, NavigationEvent, UserClickEvent, RageClickEvent,
  DomChangeEvent, EvidenceStoredEvent, EvidenceFailedEvent, Session,
  WebVitalEvent, PageTimingEvent, ConsoleWarnEvent, ConsoleErrorEvent, PageErrorEvent,
  LongTaskEvent, MemorySnapshotEvent, DomMetricsEvent, CspViolationEvent,
  ResourceTimingEvent, VitalName, VitalRating, TestResult, FindingSeverity, FindingStatus,
} from './types.js';
import { foldRequest, groupByRequest } from './fold.js';
import type { RequestView } from './types.js';
import { newId } from './ids.js';

// ─── Grade system ──────────────────────────────────────────────────────────────

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

const GRADE_COLOR: Record<Grade, string> = {
  A: '#27ae60', B: '#5dade2', C: '#f39c12', D: '#e67e22', F: '#e94560',
};

export function gradeColor(g: Grade): string { return GRADE_COLOR[g]; }

function scoreToGrade(score: number): Grade {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 45) return 'D';
  return 'F';
}

// ─── Layer types ──────────────────────────────────────────────────────────────

export interface LayerMetric {
  label: string;
  value: string;
  status: 'good' | 'warn' | 'fail' | 'info';
  detail?: string;
}

export interface DiagnosticLayer {
  id: 'network' | 'performance' | 'javascript' | 'dom' | 'memory';
  name: string;
  icon: string;
  grade: Grade;
  score: number;          // 0-100
  headline: string;
  metrics: LayerMetric[];
  issues: string[];
  rawData?: unknown;
}

export interface ChromeDevToolsLayers {
  network: DiagnosticLayer;
  performance: DiagnosticLayer;
  javascript: DiagnosticLayer;
  dom: DiagnosticLayer;
  memory: DiagnosticLayer;
}

// ─── Screenshot enrichment ────────────────────────────────────────────────────
//
// Each screenshot is enriched at REPORT TIME with the surrounding API context.
// This is the core of "screenshot tagging" — we never store derived data,
// we compute it lazily from the raw event log.

export interface EnrichedScreenshot {
  event: EvidenceStoredEvent;
  /** Human label describing what caused this screenshot */
  stepLabel: string;
  /** Step number within the session (navigation-based for aware/auto, sequential for guided) */
  stepNumber: number;
  /** APIs that started or were active within 5s before this screenshot */
  apisBefore: RequestView[];
  /** APIs that completed within 2s after this screenshot (confirms the result) */
  apisAfter: RequestView[];
  /** All related APIs combined, for display */
  relatedApis: RequestView[];
  /** Click that most directly preceded this screenshot (within 3s) */
  triggerClick?: UserClickEvent;
  /** DOM change that settled after this screenshot (within 3s) — confirms UI updated */
  uiResponse?: DomChangeEvent;
  /** One-line API summary: "3 APIs ✓, 1 failed" */
  apiSummary: string;
  /** Whether this screenshot shows a failure state */
  isFailureEvidence: boolean;
}

// ─── Other output types ────────────────────────────────────────────────────────

export interface ScreenVisit {
  id: string;
  screenKey: string;
  screenName: string;
  sectionName?: string;
  url: string;
  startTs: number;
  endTs: number;
  durationMs: number;
  arrivedVia?: string;
  stepNumber: number;  // 1-based, increments with each navigation
  actions: ActionCluster[];
  pageLoadApis: RequestView[];
  /** Raw screenshot events */
  screenshots: EvidenceStoredEvent[];
  missedScreenshots: EvidenceFailedEvent[];
  /** Enriched screenshots with full API context — the key output */
  enrichedScreenshots: EnrichedScreenshot[];
  webVitals: WebVitalEvent[];
  pageTiming?: PageTimingEvent;
  totalApiCalls: number;
  failedApiCalls: number;
  slowApiCalls: number;
  hasErrors: boolean;
}

export type ActionOutcome = 'success' | 'failure' | 'mixed' | 'no-api' | 'pending';

export interface ActionCluster {
  id: string;
  ts: number;
  trigger: UserClickEvent | null;
  triggerLabel: string;
  apiCalls: RequestView[];
  domResponse?: DomChangeEvent;
  screenshots: EvidenceStoredEvent[];
  missedScreenshots: EvidenceFailedEvent[];
  component?: string;
  description: string;
  notes: string[];
  outcome: ActionOutcome;
  failedApis: RequestView[];
  slowApis: RequestView[];
  totalDurationMs?: number;
}

export interface IssueItem {
  id: string;
  severity: FindingSeverity;
  status: FindingStatus;
  type: string;
  title: string;
  detail: string;
  screen?: string;
  actionLabel?: string;
  ts: number;
  apiPath?: string;
  apiMethod?: string;
  statusCode?: number;
  durationMs?: number;
  slaSec?: number;
  screenshot?: EvidenceStoredEvent;
  testerNote?: string;
}

export interface WebVitalScore {
  name: VitalName;
  value: number;
  rating: VitalRating;
  unit: string;
  good: number;
  poor: number;
}

export interface PerformanceDashboard {
  vitals: WebVitalScore[];
  slaCompliant: number;
  slaTotal: number;
  slaPercent: number;
  slowestApis: RequestView[];
  pageTiming?: PageTimingEvent;
  longTasks: LongTaskEvent[];
  longTaskCount: number;
  maxLongTaskMs: number;
}

export interface ExecutiveSummary {
  result: TestResult;
  issuesBySeverity: Record<FindingSeverity, number>;
  topIssue?: IssueItem;
  slaPercent?: number;
  vitalsSummary: string;
  totalScreens: number;
  totalActions: number;
  totalApiCalls: number;
  screenshotCount: number;
}

export interface ScreenGroup {
  screenKey: string;
  screenName: string;
  visits: ScreenVisit[];
  totalDurationMs: number;
  totalApiCalls: number;
  failedApiCalls: number;
}

export interface ApiEndpointSummary {
  path: string;
  method: string;
  component: string;
  callCount: number;
  successCount: number;
  failureCount: number;
  avgDurationMs: number;
  maxDurationMs: number;
}

// ─── Guided mode: step-by-step structure ─────────────────────────────────────
// Each manual screenshot the tester takes = one test step.
// Computed at report time from the raw event log.

export interface GuidedStep {
  stepNumber: number;
  ts: number;
  /** The screenshot the tester manually captured */
  screenshot: EvidenceStoredEvent;
  /** Tester's note if they wrote one */
  note?: string;
  /** Screen the tester was on when they captured */
  screenName: string;
  sectionName?: string;
  url?: string;
  /** Click that most likely preceded this capture (within 10s) */
  precedingAction?: string;
  /** APIs active or completed within ±10s of this capture */
  apisAround: RequestView[];
  /** Any API calls that failed around this step */
  failedApis: RequestView[];
  /** DOM state that was visible (from changeSignature) */
  uiSummary?: string;
  /** Errors that occurred between previous step and this one */
  errorsInWindow: Array<ConsoleErrorEvent | PageErrorEvent>;
  /** Auto-captured error screenshots between this and previous step */
  errorScreenshots: EvidenceStoredEvent[];
  /** Whether this step shows a failure / error state */
  hasIssue: boolean;
}

export interface SemanticReport {
  session: Session;
  result: TestResult;
  issues: IssueItem[];
  executiveSummary: ExecutiveSummary;
  performance: PerformanceDashboard;
  layers: ChromeDevToolsLayers;
  screenVisits: ScreenVisit[];
  screenGroups: ScreenGroup[];
  apiSummary: ApiEndpointSummary[];
  rageClicks: RageClickEvent[];
  totalScreens: number;
  totalActions: number;
  totalApiCalls: number;
  failedApiCalls: number;
  /** Populated only for guided mode — the ordered test steps */
  guidedSteps?: GuidedStep[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CLICK_TO_API_WINDOW_MS = 5000;
const DOM_SETTLE_AFTER_API_MS = 3000;

// ─── Main entry ───────────────────────────────────────────────────────────────

export function buildSemanticReport(session: Session, events: TestEvent[]): SemanticReport {
  const sorted = [...events].sort((a, b) => a.seq - b.seq || a.ts - b.ts);
  const slaMs = (session.apiSlaSec ?? 3) * 1000;

  // Fold network phases → RequestViews
  const requestMap = groupByRequest(sorted);
  const allRequests: RequestView[] = [...requestMap.values()].map(foldRequest);
  allRequests.sort((a, b) => a.seq - b.seq);

  // Tag third-party
  for (const r of allRequests) {
    r.isThirdParty = !session.scopeOrigins.some((o) => {
      try { return new URL(o).origin === r.origin; } catch { return false; }
    });
  }

  // Index by kind
  const navEvents = sorted.filter((e): e is NavigationEvent => e.kind === 'navigation');
  const clickEvents = sorted.filter((e): e is UserClickEvent => e.kind === 'user_click');
  const domChanges = sorted.filter((e): e is DomChangeEvent => e.kind === 'dom_change');
  const screenshots = sorted.filter((e): e is EvidenceStoredEvent => e.kind === 'evidence_stored');
  const missedShots = sorted.filter((e): e is EvidenceFailedEvent => e.kind === 'evidence_failed');
  const webVitals = sorted.filter((e): e is WebVitalEvent => e.kind === 'web_vital');
  const pageTimings = sorted.filter((e): e is PageTimingEvent => e.kind === 'page_timing');
  const rageClicks = sorted.filter((e): e is RageClickEvent => e.kind === 'rage_click');
  const consoleErrors = sorted.filter((e): e is ConsoleErrorEvent => e.kind === 'console_error');
  const consoleWarns = sorted.filter((e): e is ConsoleWarnEvent => e.kind === 'console_warn');
  const pageErrors = sorted.filter((e): e is PageErrorEvent => e.kind === 'page_error');
  const longTasks = sorted.filter((e): e is LongTaskEvent => e.kind === 'long_task');
  const memSnapshots = sorted.filter((e): e is MemorySnapshotEvent => e.kind === 'memory_snapshot');
  const domMetrics = sorted.filter((e): e is DomMetricsEvent => e.kind === 'dom_metrics');
  const cspViolations = sorted.filter((e): e is CspViolationEvent => e.kind === 'csp_violation');
  const resourceTimings = sorted.filter((e): e is ResourceTimingEvent => e.kind === 'resource_timing');

  // Screen visits
  const screenVisits = segmentIntoVisits(
    sorted, navEvents, allRequests, clickEvents, domChanges,
    screenshots, missedShots, webVitals, pageTimings,
  );

  // Issues
  const issues = buildIssues(
    allRequests, consoleErrors, consoleWarns, pageErrors, rageClicks,
    cspViolations, webVitals, longTasks, screenshots, screenVisits, session, slaMs,
  );

  // Test result
  const result = deriveTestResult(issues, session);

  // Performance dashboard
  const performance = buildPerfDashboard(webVitals, allRequests, pageTimings[0], slaMs, longTasks);

  // 5-layer Chrome DevTools diagnostic
  const layers = buildChromeLayers(
    allRequests, webVitals, pageTimings, longTasks, memSnapshots,
    domMetrics, cspViolations, resourceTimings, consoleErrors, consoleWarns, pageErrors,
    slaMs,
  );

  // Groups and API summary
  const screenGroups = groupVisitsByScreen(screenVisits);
  const apiSummary = buildApiSummary(allRequests);

  // Executive summary
  const issuesBySeverity: Record<FindingSeverity, number> = {
    critical: 0, high: 0, medium: 0, low: 0, info: 0,
  };
  for (const iss of issues) issuesBySeverity[iss.severity]++;
  const topIssue = issues.find((i) => i.severity === 'critical') ?? issues.find((i) => i.severity === 'high') ?? issues[0];

  const executiveSummary: ExecutiveSummary = {
    result,
    issuesBySeverity,
    topIssue,
    slaPercent: performance.slaPercent,
    vitalsSummary: buildVitalSummary(performance.vitals),
    totalScreens: screenVisits.length,
    totalActions: screenVisits.reduce((n, v) => n + v.actions.length, 0),
    totalApiCalls: allRequests.length,
    screenshotCount: screenshots.length,
  };

  // Build guided steps for Mode 1
  const guidedSteps = session.mode === 'guided'
    ? buildGuidedSteps(sorted, allRequests, screenVisits)
    : undefined;

  return {
    session, result, issues, executiveSummary, performance, layers,
    screenVisits, screenGroups, apiSummary, rageClicks,
    totalScreens: screenVisits.length,
    totalActions: executiveSummary.totalActions,
    totalApiCalls: allRequests.length,
    failedApiCalls: allRequests.filter((r) => r.outcome === 'http_error' || r.outcome === 'network_error').length,
    guidedSteps,
  };
}

// ─── Guided Mode Step Builder ─────────────────────────────────────────────────
// Each manual screenshot the tester takes becomes one numbered test step.
// Around each step we compute: which screen, which APIs fired, any errors, DOM state.

function buildGuidedSteps(
  events: TestEvent[],
  allRequests: RequestView[],
  screenVisits: ScreenVisit[],
): GuidedStep[] {
  const consoleErrors = events.filter((e): e is ConsoleErrorEvent => e.kind === 'console_error');
  const pageErrors = events.filter((e): e is PageErrorEvent => e.kind === 'page_error');
  const allErrors = [...consoleErrors, ...pageErrors].sort((a, b) => a.ts - b.ts);
  const clicks = events.filter((e): e is UserClickEvent => e.kind === 'user_click');
  const domChanges = events.filter((e): e is DomChangeEvent => e.kind === 'dom_change');
  const allScreenshots = events.filter((e): e is EvidenceStoredEvent => e.kind === 'evidence_stored');

  // Manual captures = the test steps
  const manualShots = allScreenshots
    .filter((s) => s.trigger === 'manual' || s.trigger === 'session_start')
    .sort((a, b) => a.ts - b.ts);

  // Error screenshots (auto-captured) — will be attached to nearest step
  const errorShots = allScreenshots.filter(
    (s) => s.trigger === 'http_error' || s.trigger === 'network_error' || s.trigger === 'page_error' || s.trigger === 'console_error',
  );

  const steps: GuidedStep[] = [];
  const API_WINDOW = 10_000; // 10s before/after capture

  for (let i = 0; i < manualShots.length; i++) {
    const shot = manualShots[i]!;
    const prevShotTs = manualShots[i - 1]?.ts ?? 0;
    const T = shot.ts;

    // APIs around this capture (±10s)
    const apisAround = allRequests.filter(
      (r) => r.startedAt >= T - API_WINDOW && r.startedAt <= T + API_WINDOW,
    );
    const failedApis = apisAround.filter(
      (r) => r.outcome === 'http_error' || r.outcome === 'network_error',
    );

    // Most recent click before this capture (within 10s)
    const precedingClick = clicks
      .filter((c) => c.ts <= T && T - c.ts <= 10_000)
      .sort((a, b) => b.ts - a.ts)[0];

    // DOM state at capture time
    const domAtCapture = domChanges
      .filter((d) => d.ts <= T && T - d.ts <= 5_000)
      .sort((a, b) => b.ts - a.ts)[0];

    // Errors between previous step and this one
    const errorsInWindow = allErrors.filter(
      (e) => e.ts > prevShotTs && e.ts <= T,
    );

    // Error screenshots in this window
    const errorScreenshots = errorShots.filter(
      (s) => s.ts > prevShotTs && s.ts <= T,
    );

    // Screen context
    const visit = findScreenForTs(screenVisits, T);

    // DOM summary (what was the page showing?)
    const domSummary = domAtCapture
      ? extractDomSummary(domAtCapture.changeSignature)
      : undefined;

    steps.push({
      stepNumber: i + 1,
      ts: T,
      screenshot: shot,
      note: shot.note,
      screenName: visit?.screenName ?? 'Unknown Screen',
      sectionName: visit?.sectionName,
      url: shot.pageUrl ?? visit?.url,
      precedingAction: precedingClick
        ? (precedingClick.text ?? precedingClick.ariaLabel ?? `<${precedingClick.tagName}>`)
        : undefined,
      apisAround,
      failedApis,
      uiSummary: domSummary,
      errorsInWindow,
      errorScreenshots,
      hasIssue: failedApis.length > 0 || errorsInWindow.length > 0,
    });
  }

  return steps;
}

function extractDomSummary(signature: string): string | undefined {
  const alerts = (signature.split('///')[1] ?? '').split('|').filter((p) => p.trim()).slice(0, 3).join(' · ');
  return alerts || undefined;
}

function findScreenForTs(visits: ScreenVisit[], ts: number): ScreenVisit | undefined {
  return visits.find((v) => ts >= v.startTs && ts < v.endTs);
}

// ─── Chrome DevTools 5-Layer Scoring ─────────────────────────────────────────

function buildChromeLayers(
  requests: RequestView[],
  vitals: WebVitalEvent[],
  pageTimings: PageTimingEvent[],
  longTasks: LongTaskEvent[],
  memSnapshots: MemorySnapshotEvent[],
  domMetrics: DomMetricsEvent[],
  cspViolations: CspViolationEvent[],
  resourceTimings: ResourceTimingEvent[],
  consoleErrors: ConsoleErrorEvent[],
  consoleWarns: ConsoleWarnEvent[],
  pageErrors: PageErrorEvent[],
  slaMs: number,
): ChromeDevToolsLayers {
  return {
    network: buildNetworkLayer(requests, slaMs),
    performance: buildPerformanceLayer(vitals, pageTimings, longTasks),
    javascript: buildJavaScriptLayer(consoleErrors, consoleWarns, pageErrors, cspViolations),
    dom: buildDomLayer(domMetrics, resourceTimings),
    memory: buildMemoryLayer(memSnapshots),
  };
}

function buildNetworkLayer(requests: RequestView[], slaMs: number): DiagnosticLayer {
  const total = requests.filter((r) => !r.isThirdParty).length;
  const failed = requests.filter((r) => !r.isThirdParty && (r.outcome === 'http_error' || r.outcome === 'network_error')).length;
  const measured = requests.filter((r) => !r.isThirdParty && r.durationMs !== undefined);
  const slaFail = measured.filter((r) => (r.durationMs ?? 0) > slaMs).length;
  const thirdParty = requests.filter((r) => r.isThirdParty).length;

  const slaFailRate = measured.length > 0 ? slaFail / measured.length : 0;
  const http5xx = requests.filter((r) => (r.statusCode ?? 0) >= 500).length;
  const http4xx = requests.filter((r) => (r.statusCode ?? 0) >= 400 && (r.statusCode ?? 0) < 500).length;

  let score = 100;
  if (http5xx > 0) score -= http5xx * 20;
  if (http4xx > 0) score -= http4xx * 8;
  if (slaFailRate > 0.05) score -= 15;
  if (slaFailRate > 0.20) score -= 15;
  score = Math.max(0, score);

  const slaPercent = measured.length > 0 ? Math.round(((measured.length - slaFail) / measured.length) * 100) : 100;

  const metrics: LayerMetric[] = [
    { label: 'Total Requests', value: String(total), status: 'info' },
    { label: 'HTTP Errors', value: String(failed), status: failed === 0 ? 'good' : failed <= 2 ? 'warn' : 'fail' },
    { label: 'SLA Compliance', value: `${slaPercent}%`, status: slaPercent >= 95 ? 'good' : slaPercent >= 80 ? 'warn' : 'fail', detail: `${slaMs / 1000}s threshold` },
    { label: 'HTTP 5xx', value: String(http5xx), status: http5xx === 0 ? 'good' : 'fail' },
    { label: 'HTTP 4xx', value: String(http4xx), status: http4xx === 0 ? 'good' : http4xx <= 2 ? 'warn' : 'fail' },
    { label: '3rd Party Requests', value: String(thirdParty), status: 'info' },
  ];

  const issues: string[] = [];
  if (http5xx > 0) issues.push(`${http5xx} server error(s) — check backend logs`);
  if (slaFailRate > 0.1) issues.push(`${Math.round(slaFailRate * 100)}% of APIs exceeded ${slaMs / 1000}s SLA`);
  const slowest = requests.filter((r) => !r.isThirdParty).sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))[0];
  if (slowest && (slowest.durationMs ?? 0) > slaMs * 2) {
    issues.push(`Slowest: ${slowest.method} ${shortPath(slowest.path)} (${Math.round(slowest.durationMs ?? 0)}ms)`);
  }

  return {
    id: 'network',
    name: 'Network & API',
    icon: '📡',
    grade: scoreToGrade(score),
    score,
    headline: `${total} requests · ${failed === 0 ? 'No errors' : `${failed} error${failed > 1 ? 's' : ''}`} · ${slaPercent}% within SLA`,
    metrics,
    issues,
  };
}

const VITAL_THRESHOLDS: Record<VitalName, { good: number; poor: number; unit: string }> = {
  LCP: { good: 2500, poor: 4000, unit: 'ms' },
  FCP: { good: 1800, poor: 3000, unit: 'ms' },
  CLS: { good: 0.1, poor: 0.25, unit: '' },
  INP: { good: 200, poor: 500, unit: 'ms' },
  TTFB: { good: 800, poor: 1800, unit: 'ms' },
};

function buildPerformanceLayer(vitals: WebVitalEvent[], pageTimings: PageTimingEvent[], longTasks: LongTaskEvent[]): DiagnosticLayer {
  const vitalMap = new Map<VitalName, WebVitalEvent>();
  for (const v of vitals) vitalMap.set(v.name, v);

  const poor = [...vitalMap.values()].filter((v) => v.rating === 'poor').length;
  const ni = [...vitalMap.values()].filter((v) => v.rating === 'needs-improvement').length;
  const longTaskCount = longTasks.length;
  const maxLongTask = longTasks.reduce((m, t) => Math.max(m, t.duration), 0);
  const blockedMs = longTasks.reduce((s, t) => s + t.duration, 0);

  let score = 100;
  if (poor >= 1) score -= poor * 25;
  if (ni >= 1) score -= ni * 10;
  if (longTaskCount > 5) score -= 10;
  if (maxLongTask > 500) score -= 10;
  score = Math.max(0, score);

  const metrics: LayerMetric[] = [];
  for (const [name, v] of vitalMap) {
    const t = VITAL_THRESHOLDS[name];
    const valStr = name === 'CLS' ? v.value.toFixed(3) : `${Math.round(v.value)}${t.unit}`;
    metrics.push({
      label: name,
      value: valStr,
      status: v.rating === 'good' ? 'good' : v.rating === 'needs-improvement' ? 'warn' : 'fail',
      detail: `Good < ${name === 'CLS' ? t.good : `${t.good}ms`}`,
    });
  }
  if (longTaskCount > 0) {
    metrics.push({
      label: 'Long Tasks (>50ms)',
      value: String(longTaskCount),
      status: longTaskCount === 0 ? 'good' : longTaskCount <= 5 ? 'warn' : 'fail',
      detail: `Max: ${Math.round(maxLongTask)}ms · Total blocked: ${Math.round(blockedMs)}ms`,
    });
  }
  if (pageTimings[0]) {
    metrics.push({ label: 'Page Load', value: `${pageTimings[0].loadEventMs}ms`, status: pageTimings[0].loadEventMs < 3000 ? 'good' : 'warn' });
  }

  const issues: string[] = [];
  if (poor > 0) issues.push(`${poor} Core Web Vital${poor > 1 ? 's' : ''} in "Poor" range — Google ranking impact`);
  if (ni > 0) issues.push(`${ni} Core Web Vital${ni > 1 ? 's' : ''} "Needs Improvement"`);
  if (longTaskCount > 0) issues.push(`${longTaskCount} Long Tasks block the main thread (max: ${Math.round(maxLongTask)}ms)`);

  const vitalList = [...vitalMap.values()];
  const headline = vitalList.length === 0
    ? `${longTaskCount} long tasks detected · No vitals captured`
    : `${vitalList.filter((v) => v.rating === 'good').length}/${vitalList.length} vitals good · ${longTaskCount} long tasks`;

  return {
    id: 'performance',
    name: 'Client Performance',
    icon: '⚡',
    grade: scoreToGrade(score),
    score,
    headline,
    metrics,
    issues,
  };
}

function buildJavaScriptLayer(
  errors: ConsoleErrorEvent[],
  warns: ConsoleWarnEvent[],
  pageErrors: PageErrorEvent[],
  cspViolations: CspViolationEvent[],
): DiagnosticLayer {
  const uncaught = pageErrors.filter((e) => e.type === 'uncaught').length;
  const rejections = pageErrors.filter((e) => e.type === 'unhandled_rejection').length;
  const errorCount = errors.length;
  const warnCount = warns.length;
  const cspCount = cspViolations.length;

  let score = 100;
  if (uncaught > 0) score -= uncaught * 20;
  if (rejections > 0) score -= rejections * 15;
  if (errorCount > 0) score -= errorCount * 10;
  if (warnCount > 3) score -= 5;
  if (cspCount > 0) score -= cspCount * 10;
  score = Math.max(0, score);

  const metrics: LayerMetric[] = [
    { label: 'Uncaught Exceptions', value: String(uncaught), status: uncaught === 0 ? 'good' : 'fail' },
    { label: 'Unhandled Rejections', value: String(rejections), status: rejections === 0 ? 'good' : 'fail' },
    { label: 'Console Errors', value: String(errorCount), status: errorCount === 0 ? 'good' : errorCount <= 2 ? 'warn' : 'fail' },
    { label: 'Console Warnings', value: String(warnCount), status: warnCount === 0 ? 'good' : 'warn' },
    { label: 'CSP Violations', value: String(cspCount), status: cspCount === 0 ? 'good' : 'fail', detail: 'Content-Security-Policy blocked content' },
  ];

  const issues: string[] = [];
  if (uncaught > 0) issues.push(`${uncaught} uncaught JS exception${uncaught > 1 ? 's' : ''} — check stack traces`);
  if (rejections > 0) issues.push(`${rejections} unhandled promise rejection${rejections > 1 ? 's' : ''}`);
  if (cspCount > 0) issues.push(`${cspCount} CSP violation${cspCount > 1 ? 's' : ''} — content blocked by policy`);
  if (errors.length > 0) issues.push(...errors.slice(0, 2).map((e) => e.message.slice(0, 80)));

  return {
    id: 'javascript',
    name: 'JavaScript & Runtime',
    icon: '🎭',
    grade: scoreToGrade(score),
    score,
    headline: uncaught + rejections + errorCount === 0
      ? `${warnCount} warning${warnCount !== 1 ? 's' : ''} · No errors`
      : `${uncaught + rejections} exception${uncaught + rejections !== 1 ? 's' : ''} · ${errorCount} error${errorCount !== 1 ? 's' : ''}`,
    metrics,
    issues,
  };
}

function buildDomLayer(domMetrics: DomMetricsEvent[], resourceTimings: ResourceTimingEvent[]): DiagnosticLayer {
  const latest = domMetrics[domMetrics.length - 1];
  const nodeCount = latest?.nodeCount ?? 0;
  const maxDepth = latest?.maxDepth ?? 0;
  const ariaInvalid = latest?.ariaInvalidCount ?? 0;
  const missingAlt = latest?.missingAltCount ?? 0;
  const unlabelled = latest?.unlabelledInteractiveCount ?? 0;

  // Count failed resources (404 scripts/images)
  const allResources = resourceTimings.flatMap((r) => r.resources);
  const failedResources = allResources.filter((r) => r.failed).length;
  const largeResources = allResources.filter((r) => r.transferSizeBytes > 500_000).length;

  let score = 100;
  if (nodeCount > 1400) score -= 15;
  if (nodeCount > 2000) score -= 15;
  if (maxDepth > 25) score -= 10;
  if (ariaInvalid > 0) score -= ariaInvalid * 5;
  if (missingAlt > 0) score -= missingAlt * 3;
  if (failedResources > 0) score -= failedResources * 10;
  if (largeResources > 0) score -= largeResources * 5;
  score = Math.max(0, score);

  const metrics: LayerMetric[] = [];
  if (nodeCount > 0) {
    metrics.push({
      label: 'DOM Nodes',
      value: nodeCount.toLocaleString(),
      status: nodeCount < 1000 ? 'good' : nodeCount < 1400 ? 'warn' : 'fail',
      detail: 'Google recommends < 1,400 nodes',
    });
    metrics.push({
      label: 'Max DOM Depth',
      value: String(maxDepth),
      status: maxDepth < 20 ? 'good' : maxDepth < 30 ? 'warn' : 'fail',
    });
    metrics.push({ label: 'ARIA Invalid', value: String(ariaInvalid), status: ariaInvalid === 0 ? 'good' : 'warn' });
    metrics.push({ label: 'Missing Alt Text', value: String(missingAlt), status: missingAlt === 0 ? 'good' : 'warn' });
    metrics.push({ label: 'Unlabelled Interactive', value: String(unlabelled), status: unlabelled === 0 ? 'good' : 'warn' });
  }
  if (allResources.length > 0) {
    metrics.push({ label: 'Resources Loaded', value: String(allResources.length), status: 'info' });
    metrics.push({ label: 'Failed Resources', value: String(failedResources), status: failedResources === 0 ? 'good' : 'fail', detail: '404 scripts, images, CSS' });
  }

  const issues: string[] = [];
  if (nodeCount > 1400) issues.push(`Heavy DOM: ${nodeCount.toLocaleString()} nodes — hurts style calculation & rendering`);
  if (failedResources > 0) issues.push(`${failedResources} resource(s) failed to load (broken assets)`);
  if (ariaInvalid > 0 || missingAlt > 0) issues.push(`Accessibility: ${ariaInvalid} ARIA invalid, ${missingAlt} images missing alt text`);

  return {
    id: 'dom',
    name: 'DOM & Accessibility',
    icon: '🏗',
    grade: nodeCount === 0 ? 'A' : scoreToGrade(score),
    score: nodeCount === 0 ? 100 : score,
    headline: nodeCount === 0
      ? 'DOM metrics not captured'
      : `${nodeCount.toLocaleString()} nodes · depth ${maxDepth} · ${ariaInvalid + missingAlt} a11y signals`,
    metrics,
    issues,
  };
}

function buildMemoryLayer(snapshots: MemorySnapshotEvent[]): DiagnosticLayer {
  if (!snapshots.length) {
    return {
      id: 'memory',
      name: 'Memory & Storage',
      icon: '🗄',
      grade: 'A',
      score: 100,
      headline: 'Memory metrics not captured',
      metrics: [{ label: 'JS Heap', value: 'N/A', status: 'info', detail: 'Requires Chrome with performance.memory' }],
      issues: [],
    };
  }

  const first = snapshots[0]!;
  const last = snapshots[snapshots.length - 1]!;
  const usedMB = Math.round(last.usedJSHeapSizeBytes / 1_048_576);
  const limitMB = Math.round(last.jsHeapSizeLimitBytes / 1_048_576);
  const growthBytes = last.usedJSHeapSizeBytes - first.usedJSHeapSizeBytes;
  const growthMB = Math.round(growthBytes / 1_048_576);
  const growthPct = first.usedJSHeapSizeBytes > 0 ? Math.round((growthBytes / first.usedJSHeapSizeBytes) * 100) : 0;

  let score = 100;
  if (usedMB > 100) score -= 15;
  if (usedMB > 200) score -= 20;
  if (growthPct > 50 && snapshots.length > 1) score -= 20; // possible leak
  if (growthPct > 100) score -= 20;
  score = Math.max(0, score);

  const leakSignal = growthPct > 50 && snapshots.length > 2;

  const metrics: LayerMetric[] = [
    { label: 'JS Heap Used', value: `${usedMB} MB`, status: usedMB < 50 ? 'good' : usedMB < 150 ? 'warn' : 'fail' },
    { label: 'Heap Limit', value: `${limitMB} MB`, status: 'info' },
    {
      label: 'Memory Growth',
      value: growthMB >= 0 ? `+${growthMB} MB` : `${growthMB} MB`,
      status: leakSignal ? 'fail' : Math.abs(growthPct) < 20 ? 'good' : 'warn',
      detail: snapshots.length > 1 ? `${growthPct > 0 ? '+' : ''}${growthPct}% over session` : 'Single snapshot',
    },
    { label: 'Snapshots', value: String(snapshots.length), status: 'info' },
  ];

  const issues: string[] = [];
  if (leakSignal) issues.push(`Memory grew ${growthPct}% — possible memory leak (check for undetached DOM listeners)`);
  if (usedMB > 200) issues.push(`High heap usage: ${usedMB}MB — monitor for browser tab crashes`);

  return {
    id: 'memory',
    name: 'Memory & Storage',
    icon: '🗄',
    grade: scoreToGrade(score),
    score,
    headline: `JS Heap: ${usedMB}MB${snapshots.length > 1 ? ` · Growth: ${growthPct > 0 ? '+' : ''}${growthPct}%` : ''}${leakSignal ? ' ⚠ Possible leak' : ''}`,
    metrics,
    issues,
  };
}

// ─── Issue classification ─────────────────────────────────────────────────────

function classifyRequestSeverity(req: RequestView, slaMs: number): FindingSeverity | null {
  if (req.isThirdParty) return 'info';
  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  const dur = req.durationMs ?? 0;

  if (req.outcome === 'http_error') {
    const code = req.statusCode ?? 0;
    if (code >= 500) return isMutation ? 'critical' : 'high';
    if (code >= 400) return isMutation ? 'high' : 'medium';
  }
  if (req.outcome === 'network_error') return isMutation ? 'critical' : 'high';
  if (req.outcome === 'success') {
    if (dur > slaMs * 3) return 'high';
    if (dur > slaMs * 1.5) return 'medium';
    if (dur > slaMs) return 'low';
  }
  return null;
}

function buildIssues(
  requests: RequestView[],
  consoleErrors: ConsoleErrorEvent[],
  consoleWarns: ConsoleWarnEvent[],
  pageErrors: PageErrorEvent[],
  rageClicks: RageClickEvent[],
  cspViolations: CspViolationEvent[],
  webVitals: WebVitalEvent[],
  longTasks: LongTaskEvent[],
  screenshots: EvidenceStoredEvent[],
  screenVisits: ScreenVisit[],
  session: Session,
  slaMs: number,
): IssueItem[] {
  const issues: IssueItem[] = [];

  for (const req of requests) {
    const sev = classifyRequestSeverity(req, slaMs);
    if (!sev) continue;
    const screen = findScreenForTs(screenVisits, req.startedAt);
    const action = findActionForRequest(screenVisits, req.requestId);
    const screenshot = screenshots.find((s) => s.ts >= req.startedAt && s.ts - req.startedAt < 6000);
    const dur = req.durationMs ?? 0;
    const slaSec = session.apiSlaSec ?? 3;
    let title = '', detail = '';

    if (req.outcome === 'http_error') {
      title = `HTTP ${req.statusCode} on ${req.method} ${shortPath(req.path)}`;
      detail = `${req.statusLine ?? ''} — ${req.url}`;
    } else if (req.outcome === 'network_error') {
      title = `Network error on ${req.method} ${shortPath(req.path)}`;
      detail = `${req.errorText ?? 'Connection failed'} — ${req.url}`;
    } else {
      title = `Slow: ${req.method} ${shortPath(req.path)} (${Math.round(dur)}ms)`;
      detail = `${Math.round(dur)}ms — ${(dur / slaMs).toFixed(1)}× over ${slaSec}s SLA`;
    }

    issues.push({ id: `issue:${req.requestId}`, severity: sev, status: 'open',
      type: req.outcome === 'success' ? 'PERFORMANCE' : req.outcome === 'network_error' ? 'NETWORK_ERROR' : 'HTTP_ERROR',
      title, detail, screen: screen?.screenName, actionLabel: action?.triggerLabel,
      ts: req.startedAt, apiPath: req.path, apiMethod: req.method,
      statusCode: req.statusCode, durationMs: dur, slaSec, screenshot });
  }

  for (const err of consoleErrors) {
    const screen = findScreenForTs(screenVisits, err.ts);
    issues.push({ id: `issue:${err.id}`, severity: 'medium', status: 'open', type: 'CONSOLE_ERROR',
      title: `Console error: ${err.message.slice(0, 80)}`, detail: err.message, screen: screen?.screenName, ts: err.ts });
  }

  for (const warn of consoleWarns) {
    if (/Warning:|React|Deprecat|DevTools/i.test(warn.message) && warn.message.length > 200) continue;
    const screen = findScreenForTs(screenVisits, warn.ts);
    issues.push({ id: `issue:${warn.id}`, severity: 'low', status: 'open', type: 'CONSOLE_WARN',
      title: `Warning: ${warn.message.slice(0, 80)}`, detail: warn.message, screen: screen?.screenName, ts: warn.ts });
  }

  for (const err of pageErrors) {
    const screen = findScreenForTs(screenVisits, err.ts);
    issues.push({ id: `issue:${err.id}`, severity: 'high', status: 'open', type: 'PAGE_ERROR',
      title: `${err.type === 'unhandled_rejection' ? 'Unhandled rejection' : 'Uncaught error'}: ${err.message.slice(0, 60)}`,
      detail: err.message, screen: screen?.screenName, ts: err.ts });
  }

  for (const csp of cspViolations) {
    issues.push({ id: `issue:${csp.id}`, severity: 'medium', status: 'open', type: 'CSP_VIOLATION',
      title: `CSP Violation: ${csp.violatedDirective}`, detail: `Blocked: ${csp.blockedURI}`, ts: csp.ts });
  }

  for (const rc of rageClicks) {
    issues.push({ id: `issue:${rc.id}`, severity: 'low', status: 'open', type: 'RAGE_CLICK',
      title: `Rage click: <${rc.tagName}> clicked ${rc.clickCount}× in ${rc.windowMs}ms`,
      detail: `"${rc.selector}" clicked rapidly — UI may be unresponsive`, ts: rc.ts });
  }

  const vitalMap = new Map<VitalName, WebVitalEvent>();
  for (const v of webVitals) vitalMap.set(v.name, v);
  for (const v of vitalMap.values()) {
    if (v.rating === 'good') continue;
    const sev: FindingSeverity = v.rating === 'poor' ? 'medium' : 'low';
    const valStr = v.name === 'CLS' ? v.value.toFixed(3) : `${Math.round(v.value)}ms`;
    issues.push({ id: `issue:vital:${v.id}`, severity: sev, status: 'open', type: 'PERFORMANCE',
      title: `${v.name} ${v.rating}: ${valStr}`,
      detail: `${v.name} = ${valStr} — Google threshold for "Good": ${v.name === 'CLS' ? VITAL_THRESHOLDS[v.name].good : `${VITAL_THRESHOLDS[v.name].good}ms`}`,
      ts: v.ts });
  }

  const order: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  issues.sort((a, b) => order[a.severity] - order[b.severity] || a.ts - b.ts);
  return issues;
}

function deriveTestResult(issues: IssueItem[], session: Session): TestResult {
  if (session.testResult !== 'in_progress') return session.testResult;
  const critical = issues.filter((i) => i.severity === 'critical').length;
  const high = issues.filter((i) => i.severity === 'high').length;
  const medium = issues.filter((i) => i.severity === 'medium').length;
  if (critical > 0) return 'fail';
  if (high > 1) return 'fail';
  if (high > 0) return 'partial';
  if (medium > 0) return 'partial';
  return issues.length === 0 ? 'pass' : 'partial';
}

// ─── Performance dashboard ────────────────────────────────────────────────────

function buildPerfDashboard(
  vitals: WebVitalEvent[], requests: RequestView[],
  pageTiming: PageTimingEvent | undefined, slaMs: number,
  longTasks: LongTaskEvent[],
): PerformanceDashboard {
  const vitalMap = new Map<VitalName, WebVitalEvent>();
  for (const v of vitals) vitalMap.set(v.name, v);
  const scores: WebVitalScore[] = [...vitalMap.values()].map((v) => {
    const t = VITAL_THRESHOLDS[v.name];
    return { name: v.name, value: v.value, rating: v.rating, unit: t.unit, good: t.good, poor: t.poor };
  });
  const measured = requests.filter((r) => !r.isThirdParty && r.outcome !== 'pending' && r.durationMs !== undefined);
  const slaCompliant = measured.filter((r) => (r.durationMs ?? 0) <= slaMs).length;
  const slowestApis = [...requests].filter((r) => !r.isThirdParty && r.durationMs !== undefined)
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0)).slice(0, 5);
  const longTaskCount = longTasks.length;
  const maxLongTaskMs = longTasks.reduce((m, t) => Math.max(m, t.duration), 0);
  return {
    vitals: scores, slaCompliant, slaTotal: measured.length,
    slaPercent: measured.length > 0 ? Math.round((slaCompliant / measured.length) * 100) : 100,
    slowestApis, pageTiming, longTasks, longTaskCount, maxLongTaskMs,
  };
}

function buildVitalSummary(vitals: WebVitalScore[]): string {
  if (!vitals.length) return 'Web Vitals not captured';
  const poor = vitals.filter((v) => v.rating === 'poor');
  const ni = vitals.filter((v) => v.rating === 'needs-improvement');
  if (!poor.length && !ni.length) return `All ${vitals.length} Web Vitals: Good ✓`;
  const parts: string[] = [];
  if (poor.length) parts.push(`${poor.map((v) => v.name).join(', ')} poor`);
  if (ni.length) parts.push(`${ni.map((v) => v.name).join(', ')} needs improvement`);
  return parts.join('; ');
}

// ─── Screenshot enrichment ────────────────────────────────────────────────────

function enrichScreenshot(
  shot: EvidenceStoredEvent,
  stepNumber: number,
  allRequests: RequestView[],
  clicks: UserClickEvent[],
  domChanges: DomChangeEvent[],
): EnrichedScreenshot {
  const T = shot.ts;
  const BEFORE_MS = 5000;
  const AFTER_MS = 2000;

  // APIs active or completed within the context window around this screenshot
  const apisBefore = allRequests.filter(
    (r) => r.startedAt >= T - BEFORE_MS && r.startedAt <= T,
  );
  const apisAfter = allRequests.filter(
    (r) => r.startedAt > T && r.startedAt <= T + AFTER_MS,
  );
  const relatedApis = [...apisBefore, ...apisAfter].filter(
    (r, i, a) => a.findIndex((x) => x.requestId === r.requestId) === i,
  );

  // Most recent click within 3s before this screenshot
  const triggerClick = clicks
    .filter((c) => c.ts <= T && T - c.ts <= 3000)
    .sort((a, b) => b.ts - a.ts)[0];

  // First DOM change within 3s after screenshot — confirms UI settled
  const uiResponse = domChanges.find((d) => d.ts > T && d.ts - T <= 3000);

  // API summary string
  const failed = relatedApis.filter((r) => r.outcome === 'http_error' || r.outcome === 'network_error');
  const slow = relatedApis.filter((r) => r.outcome === 'success' && (r.durationMs ?? 0) > 3000);
  let apiSummary = '';
  if (!relatedApis.length) {
    apiSummary = 'No API activity';
  } else {
    const ok = relatedApis.length - failed.length;
    const parts: string[] = [];
    if (ok > 0) parts.push(`${ok} ✓`);
    if (failed.length > 0) parts.push(`${failed.length} ✗`);
    if (slow.length > 0) parts.push(`${slow.length} slow`);
    apiSummary = parts.join(' · ');
  }

  // Human-readable step label — uses componentName stored in the event itself
  // (set by net-observer.ts when the API triggered this capture)
  const stepLabel = buildStepLabel(shot, stepNumber, triggerClick);

  return {
    event: shot,
    stepLabel,
    stepNumber,
    apisBefore,
    apisAfter,
    relatedApis,
    triggerClick,
    uiResponse,
    apiSummary,
    isFailureEvidence: failed.length > 0 || shot.trigger === 'http_error' || shot.trigger === 'network_error' || shot.trigger === 'page_error' || shot.trigger === 'console_error',
  };
}

function buildStepLabel(shot: EvidenceStoredEvent, step: number, click: UserClickEvent | undefined): string {
  const comp = shot.componentName;

  switch (shot.trigger) {
    case 'manual':
      return shot.note ? `📸 ${shot.note}` : '📸 Manual capture';

    case 'session_start':
      return '📍 Baseline';

    case 'session_end':
      return '🏁 Final state';

    case 'navigation':
      return `Step ${step}: Page loaded`;

    case 'api_loading':
      // Loading state — component is fetching data (skeleton/spinner visible)
      return comp ? `⏳ ${comp} — loading` : `⏳ Loading…`;

    case 'api_complete':
      // Loaded state — component has rendered with data
      return comp
        ? `${shot.capturePhase === 'loading' ? '⏳' : '✅'} ${comp} — ${shot.capturePhase === 'loading' ? 'loading' : 'loaded'}`
        : `✅ Data loaded`;

    case 'http_error':
      return comp ? `🔴 ${comp} — failed` : '🔴 HTTP error';

    case 'network_error':
      return comp ? `🔴 ${comp} — network error` : '🔴 Network error';

    case 'page_error':
    case 'console_error':
      return '⚠️ Error state';

    case 'dom_change':
    case 'component_visible':
      if (click) {
        const label = (click.text ?? click.ariaLabel ?? `<${click.tagName}>`).slice(0, 40);
        return comp ? `After "${label}" → ${comp}` : `After: "${label}"`;
      }
      return comp ? `${comp} — visible` : `UI changed`;

    case 'user_action':
      return click
        ? `Before: "${(click.text ?? click.ariaLabel ?? `<${click.tagName}>`).slice(0, 40)}"`
        : 'Before action';

    default:
      return `Step ${step}`;
  }
}

// ─── Screen visit segmentation ────────────────────────────────────────────────

function segmentIntoVisits(
  allEvents: TestEvent[], navEvents: NavigationEvent[], allRequests: RequestView[],
  clickEvents: UserClickEvent[], domChanges: DomChangeEvent[],
  screenshots: EvidenceStoredEvent[], missedShots: EvidenceFailedEvent[],
  webVitals: WebVitalEvent[], pageTimings: PageTimingEvent[],
): ScreenVisit[] {
  if (!navEvents.length) return [];
  const visits: ScreenVisit[] = [];
  let stepCounter = 0;

  for (let i = 0; i < navEvents.length; i++) {
    stepCounter++;
    const nav = navEvents[i]!;
    const nextNav = navEvents[i + 1];
    const visitStart = nav.ts;
    const visitEnd = nextNav?.ts ?? (allEvents[allEvents.length - 1]?.ts ?? visitStart + 1000);

    const inRange = <T extends { ts: number; tabId: number }>(arr: T[]) =>
      arr.filter((e) => e.ts >= visitStart && e.ts < visitEnd && e.tabId === nav.tabId);

    const visitClicks = inRange(clickEvents);
    const visitDomChanges = inRange(domChanges);
    const visitScreenshots = inRange(screenshots);
    const visitMissed = inRange(missedShots);
    const visitRequests = allRequests.filter((r) => r.startedAt >= visitStart && r.startedAt < visitEnd && r.tabId === nav.tabId);

    // Enrich each screenshot with API context — the core of "screenshot tagging"
    const enrichedScreenshots = visitScreenshots.map((shot) =>
      enrichScreenshot(shot, stepCounter, allRequests, visitClicks, visitDomChanges),
    );

    const { pageLoadApis, actions } = clusterActions(
      visitStart, visitClicks, visitRequests, visitDomChanges, visitScreenshots, visitMissed,
    );

    const { screenName, sectionName, screenKey } = parseScreenInfo(nav.url);
    const failedApiCalls = visitRequests.filter((r) => r.outcome === 'http_error' || r.outcome === 'network_error').length;

    visits.push({
      id: `visit:${newId()}`, screenKey, screenName, sectionName, url: nav.url,
      startTs: visitStart, endTs: visitEnd, durationMs: visitEnd - visitStart,
      stepNumber: stepCounter,
      arrivedVia: i === 0 ? 'Session start' : getPrecedingClickLabel(navEvents[i - 1]!, clickEvents),
      actions, pageLoadApis,
      screenshots: visitScreenshots, missedScreenshots: visitMissed,
      enrichedScreenshots,
      webVitals: inRange(webVitals), pageTiming: inRange(pageTimings)[0],
      totalApiCalls: visitRequests.length,
      failedApiCalls,
      slowApiCalls: visitRequests.filter((r) => (r.durationMs ?? 0) > 3000).length,
      hasErrors: failedApiCalls > 0 || enrichedScreenshots.some((s) => s.isFailureEvidence),
    });
  }
  return visits;
}

function clusterActions(
  visitStart: number, clicks: UserClickEvent[], requests: RequestView[],
  domChanges: DomChangeEvent[], screenshots: EvidenceStoredEvent[], missedShots: EvidenceFailedEvent[],
): { pageLoadApis: RequestView[]; actions: ActionCluster[] } {
  const used = new Set<string>();
  const actions: ActionCluster[] = [];
  for (const click of [...clicks].sort((a, b) => a.ts - b.ts)) {
    const attributed = requests.filter(
      (r) => !used.has(r.requestId) && r.startedAt >= click.ts && r.startedAt - click.ts <= CLICK_TO_API_WINDOW_MS,
    );
    attributed.forEach((r) => used.add(r.requestId));
    const lastApiEnd = attributed.reduce((t, r) => Math.max(t, r.endedAt ?? r.startedAt), click.ts);
    const domResponse = domChanges.find((d) => d.ts > click.ts && d.ts <= lastApiEnd + DOM_SETTLE_AFTER_API_MS);
    const actionScreenshots = screenshots.filter((s) => s.ts >= click.ts && s.ts <= lastApiEnd + DOM_SETTLE_AFTER_API_MS + 3000);
    const actionMissed = missedShots.filter((s) => s.ts >= click.ts && s.ts <= lastApiEnd + DOM_SETTLE_AFTER_API_MS + 3000);
    const failedApis = attributed.filter((r) => r.outcome === 'http_error' || r.outcome === 'network_error');
    const slowApis = attributed.filter((r) => (r.durationMs ?? 0) > 3000);
    actions.push({
      id: `action:${newId()}`, ts: click.ts, trigger: click,
      triggerLabel: `Clicked "${click.text ?? click.ariaLabel ?? `<${click.tagName}>`}"`,
      apiCalls: attributed, domResponse,
      screenshots: actionScreenshots, missedScreenshots: actionMissed,
      component: inferComponent(attributed, click),
      description: describeAction(click, attributed, domResponse, failedApis),
      notes: buildNotes(attributed, failedApis, slowApis, domResponse),
      outcome: deriveOutcome(attributed, failedApis),
      failedApis, slowApis,
      totalDurationMs: attributed.length > 0
        ? Math.max(...attributed.map((r) => (r.endedAt ?? r.startedAt) - click.ts))
        : undefined,
    });
  }
  return { pageLoadApis: requests.filter((r) => !used.has(r.requestId)), actions };
}

// ─── URL parsing ──────────────────────────────────────────────────────────────

const PATH_NAMES: Record<string, string> = {
  'dashboard': 'Dashboard', 'inventory-action-center': 'Inventory Action Center',
  'replenishment': 'Replenishment', 'home': 'Home', 'settings': 'Settings',
  'warehouse-replenishment-v2': 'Warehouse Replenishment',
};
const TAB_NAMES: Record<string, string> = {
  'inventory-health': 'Inventory Health', 'stockout-prevention': 'Stockout Prevention',
  'daily-order-management': 'Daily Order Management',
};
const STATUS_NAMES: Record<string, string> = {
  'out-of-stock': 'Out of Stock', 'understock': 'Understock',
  'overage': 'Overage', 'unavailable': 'Unavailable', 'healthy': 'Healthy',
};
const SUBNAMES: Record<string, string> = {
  'store-order-layout': 'Store Order Layout', 'alert-adherence': 'Alert Adherence',
  'warehouse-performance': 'Warehouse Performance', 'supplier': 'Supplier',
};

function parseScreenInfo(url: string): { screenName: string; sectionName?: string; screenKey: string } {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { screenName: url, screenKey: url }; }
  const last = parsed.pathname.split('/').filter((s) => s && !/^[0-9a-f-]{8,}$/i.test(s)).pop() ?? 'Page';
  const screenName = PATH_NAMES[last] ?? toTitleCase(last.replace(/-/g, ' '));
  const params = parsed.searchParams;
  const parts: string[] = [];
  const tab = params.get('tab'); if (tab) parts.push(TAB_NAMES[tab] ?? toTitleCase(tab));
  const st = params.get('statusTab'); if (st) parts.push(STATUS_NAMES[st] ?? toTitleCase(st));
  for (const key of ['ihNav', 'sopModule', 'whPerfSub', 'statusSub']) {
    const v = params.get(key); if (v) parts.push(SUBNAMES[v] ?? toTitleCase(v.replace(/-/g, ' ')));
  }
  return { screenName, sectionName: parts.length ? parts.join(' › ') : undefined, screenKey: parsed.pathname };
}

// ─── Component + action helpers ───────────────────────────────────────────────

const API_COMPONENT_MAP: Array<[RegExp, string]> = [
  [/\/inventory-health\//, 'Inventory Health'], [/\/critical-alerts?\//, 'Critical Alerts'],
  [/\/recommendations\//, 'Order Recommendations'], [/\/supplier-eta-missing-po\//, 'Supplier ETA'],
  [/\/store-orders-tobe\//, 'Store Order Layout'], [/\/critical-alert-adherence/, 'Alert Adherence'],
  [/\/warehouse-otif\//, 'Warehouse OTIF'], [/\/supplier-otif\//, 'Supplier OTIF'],
  [/\/orders\/create-orders/, 'Order Creation'], [/\/ordering\//, 'Order Management'],
  [/\/replenishment\/recommendations/, 'Recommendations'],
];

function inferComponent(apis: RequestView[], click?: UserClickEvent): string | undefined {
  for (const [pat, name] of API_COMPONENT_MAP) { if (apis.some((r) => pat.test(r.path))) return name; }
  return click?.ariaLabel ?? undefined;
}

function describeAction(click: UserClickEvent, apis: RequestView[], dom: DomChangeEvent | undefined, failed: RequestView[]): string {
  const label = click.text ?? click.ariaLabel ?? click.role ?? `<${click.tagName}>`;
  if (!apis.length) return label;
  if (failed.length === apis.length) return `${label} → all requests failed`;
  if (failed.length > 0) return `${label} → partial failure (${failed.map((r) => shortPath(r.path)).join(', ')})`;
  if (dom) {
    const first = (dom.changeSignature.split('///')[1] ?? '').split('|').find((p) => p.trim())?.trim();
    if (first) return `${label} → "${first.slice(0, 60)}"`;
  }
  const comp = inferComponent(apis) ?? shortPath(apis[0]!.path);
  const maxDur = Math.max(...apis.map((r) => r.durationMs ?? 0));
  return `${label} → ${comp}${maxDur > 0 ? ` (${Math.round(maxDur)}ms)` : ''}`;
}

function buildNotes(apis: RequestView[], failed: RequestView[], slow: RequestView[], dom: DomChangeEvent | undefined): string[] {
  const notes: string[] = [];
  for (const r of failed) notes.push(`⚠ ${r.method} ${shortPath(r.path)} → ${r.statusCode ?? 'network error'}`);
  for (const r of slow) if (!failed.includes(r)) notes.push(`🐢 ${r.method} ${shortPath(r.path)} took ${Math.round(r.durationMs ?? 0)}ms`);
  if (dom) {
    const alerts = (dom.changeSignature.split('///')[1] ?? '').split('|').filter((p) => p.trim()).slice(0, 2).join(', ');
    if (alerts) notes.push(`UI: ${alerts}`);
  }
  return notes;
}

function deriveOutcome(apis: RequestView[], failed: RequestView[]): ActionOutcome {
  if (!apis.length) return 'no-api';
  if (apis.some((r) => r.outcome === 'pending')) return 'pending';
  if (failed.length === 0) return 'success';
  if (failed.length === apis.length) return 'failure';
  return 'mixed';
}

function groupVisitsByScreen(visits: ScreenVisit[]): ScreenGroup[] {
  const map = new Map<string, ScreenGroup>();
  for (const v of visits) {
    if (!map.has(v.screenKey)) map.set(v.screenKey, { screenKey: v.screenKey, screenName: v.screenName, visits: [], totalDurationMs: 0, totalApiCalls: 0, failedApiCalls: 0 });
    const g = map.get(v.screenKey)!;
    g.visits.push(v); g.totalDurationMs += v.durationMs; g.totalApiCalls += v.totalApiCalls; g.failedApiCalls += v.failedApiCalls;
  }
  return [...map.values()].sort((a, b) => (a.visits[0]?.startTs ?? 0) - (b.visits[0]?.startTs ?? 0));
}

function buildApiSummary(requests: RequestView[]): ApiEndpointSummary[] {
  const map = new Map<string, ApiEndpointSummary>();
  for (const r of requests) {
    const path = normalizePath(r.path);
    const key = `${r.method}:${path}`;
    if (!map.has(key)) map.set(key, { path, method: r.method, component: inferComponent([r]) ?? '', callCount: 0, successCount: 0, failureCount: 0, avgDurationMs: 0, maxDurationMs: 0 });
    const e = map.get(key)!;
    e.callCount++;
    if (r.outcome === 'success') e.successCount++;
    if (r.outcome === 'http_error' || r.outcome === 'network_error') e.failureCount++;
    const dur = r.durationMs ?? 0;
    e.avgDurationMs = ((e.avgDurationMs * (e.callCount - 1)) + dur) / e.callCount;
    e.maxDurationMs = Math.max(e.maxDurationMs, dur);
  }
  return [...map.values()].sort((a, b) => b.callCount - a.callCount);
}

function findActionForRequest(visits: ScreenVisit[], requestId: string): ActionCluster | undefined {
  for (const v of visits) for (const a of v.actions) if (a.apiCalls.some((r) => r.requestId === requestId)) return a;
}

function getPrecedingClickLabel(prevNav: NavigationEvent, clicks: UserClickEvent[]): string {
  const last = clicks.filter((c) => c.ts <= prevNav.ts && prevNav.ts - c.ts < 3000).sort((a, b) => b.ts - a.ts)[0];
  if (!last) return prevNav.isSpaRouteChange ? 'SPA navigation' : 'Navigation';
  return `Clicked "${last.text ?? last.ariaLabel ?? `<${last.tagName}>`}"`;
}

function toTitleCase(s: string): string { return s.replace(/\b\w/g, (c) => c.toUpperCase()); }
function shortPath(path: string): string { return path.split('/').filter(Boolean).slice(-2).join('/'); }
function normalizePath(path: string): string {
  return path.replace(/\/[0-9a-f]{8,}/gi, '/:id').replace(/\/\d+/g, '/:id').replace(/\?.*$/, '');
}
