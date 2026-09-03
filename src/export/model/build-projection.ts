// build-projection.ts — pure transformation from raw session data to the
// CanonicalExportModel. Uses `buildReport()` from core/correlation.ts so
// finding/request-view derivation is NOT duplicated.
//
// This module has ZERO React/Preact/Chrome/DOM dependencies. If you add any,
// unit tests will break and the export system will lose its testability.

import type {
  Checkpoint,
  ConsoleErrorEvent,
  ConsoleWarnEvent,
  CspViolationEvent,
  DomChangeEvent,
  DomMetricsEvent,
  EvidenceStoredEvent,
  Finding,
  FindingSeverity,
  LongTaskEvent,
  MemorySnapshotEvent,
  NavigationEvent,
  NegativeInferenceEvent,
  PageErrorEvent,
  PageTimingEvent,
  RageClickEvent,
  RequestView,
  Session,
  Step,
  TestEvent,
  WebVitalEvent,
} from '../../core/types.js';
import { CORRELATION_VERSION } from '../../core/types.js';
import { buildReport } from '../../core/correlation.js';
import { normalizeStepBugs, normalizeStepNotes, stepLabel } from '../../core/step-helpers.js';

import type {
  CanonicalExportModel,
  CanonicalExportOptions,
  CanonicalStep,
  CheckpointSummary,
  ConsoleFindingSummary,
  CorrelatedEvidence,
  CspViolationSummary,
  DomMetricsSummary,
  EnvironmentSnapshot,
  EvidenceRef,
  ExecutionStatistics,
  LongTaskSummary,
  MemorySnapshotSummary,
  NavigationSummary,
  NetworkFindingSummary,
  ObservedFinding,
  PageTimingSummary,
  ReportMeta,
  SessionExportInput,
  StepAction,
  StepAnnotation,
  StepBugSummary,
  StepTesterNote,
  TechnicalAppendix,
  TestOverview,
  TestSection,
  WebVitalSummary,
} from './canonical.js';

// Matches the historical dashboard `findNearbyNetworkErrors` window.
const DEFAULT_CORRELATION_WINDOW_MS = 4000;
const DEFAULT_GENERATOR_VERSION = 'unknown';

const ZERO_SEVERITY_COUNTS: Readonly<Record<FindingSeverity, number>> = Object.freeze({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  info: 0,
});

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Build a CanonicalExportModel for ONE BusinessFlow session.
 *
 * Pure function: given identical input, produces identical output. Screenshots
 * are represented by `blobKey` references only — the projection never decodes
 * blob bytes.
 */
export function buildCanonicalExportModel(
  input: SessionExportInput,
  options: CanonicalExportOptions = {},
): CanonicalExportModel {
  const { session, events, steps, knownBlobKeys } = input;
  // networkLogs is currently unused: RequestView from buildReport() already
  // supersedes it for correlation. Keep it on the input contract so the
  // storage adapter has a stable shape and future consumers can wire it in.
  void input.networkLogs;
  const correlationWindowMs = options.correlationWindowMs ?? DEFAULT_CORRELATION_WINDOW_MS;
  const generatorVersion = options.generatorVersion ?? session.environment.extVersion ?? DEFAULT_GENERATOR_VERSION;
  const nowMs = options.nowMs ?? Date.now();

  // Reuse the existing derivation engine. Findings, request views, checkpoints,
  // negative inference — all come from here. Do not reinvent.
  const report = buildReport(session, [...events], [...steps]);

  const evidenceById = indexEvidenceStoredEvents(events);
  const orderedSteps = [...steps].sort((a, b) => a.index - b.index || a.ts - b.ts);

  const sectionSteps: CanonicalStep[] = orderedSteps.map((step, position) => {
    const nextStep = orderedSteps[position + 1];
    return projectStep(step, {
      nextStepTs: nextStep?.ts,
      evidenceById,
      knownBlobKeys,
      events,
      requests: report.requests,
      apiSlaSec: session.apiSlaSec,
      correlationWindowMs,
      scopeOrigins: session.scopeOrigins,
    });
  });

  const sections: TestSection[] = [
    { id: 'default', steps: sectionSteps },
  ];

  const stats = buildStatistics(session, events, orderedSteps, report.requests, report.findings);
  const findings = report.findings.map((finding) =>
    projectFinding(finding, orderedSteps, knownBlobKeys),
  );
  const appendix = buildAppendix(events, report.requests, report.checkpoints, report.negativeInference, session.scopeOrigins, session.apiSlaSec);
  const overview = buildOverview(session, stats, report.requests, events);
  const environment = buildEnvironment(session);
  const meta: ReportMeta = {
    generatedAt: nowMs,
    generatedBy: { product: 'BusinessFlow', version: generatorVersion },
    sessionId: session.id,
    correlationVersion: CORRELATION_VERSION,
  };

  return {
    schemaVersion: 1,
    meta,
    overview,
    environment,
    stats,
    sections,
    findings,
    appendix,
  };
}

// ─── Step projection ────────────────────────────────────────────────────

interface StepProjectionContext {
  readonly nextStepTs?: number;
  readonly evidenceById: ReadonlyMap<string, EvidenceStoredEvent>;
  readonly knownBlobKeys: ReadonlySet<string>;
  readonly events: readonly TestEvent[];
  readonly requests: readonly RequestView[];
  readonly apiSlaSec: number;
  readonly correlationWindowMs: number;
  readonly scopeOrigins: readonly string[];
}

function projectStep(step: Step, ctx: StepProjectionContext): CanonicalStep {
  const action: StepAction = {
    label: stepLabel(step),
    ...(step.semanticLabel ? { semanticLabel: step.semanticLabel } : {}),
    ...(step.pageUrl ? { pageUrl: step.pageUrl } : {}),
    ...(step.elementRect
      ? {
          elementRect: {
            x: step.elementRect.x,
            y: step.elementRect.y,
            width: step.elementRect.width,
            height: step.elementRect.height,
            pageScrollX: step.elementRect.pageScrollX,
            pageScrollY: step.elementRect.pageScrollY,
            viewportWidth: step.elementRect.viewportWidth,
            viewportHeight: step.elementRect.viewportHeight,
            devicePixelRatio: step.elementRect.devicePixelRatio,
          },
        }
      : {}),
    clickCount: step.clickEventIds.length,
  };

  const beforeEvidence = resolveEvidenceRef(step.beforeEvidenceEventId, ctx.evidenceById, ctx.knownBlobKeys);
  const afterEvidence = resolveEvidenceRef(step.afterEvidenceEventId, ctx.evidenceById, ctx.knownBlobKeys);
  const systemEvidence = step.systemEvidenceEventIds
    .map((id) => resolveEvidenceRef(id, ctx.evidenceById, ctx.knownBlobKeys))
    .filter((ref): ref is EvidenceRef => ref !== undefined);

  const annotations = buildStepAnnotations(step);
  const testerNotes = normalizeStepNotes(step).map<StepTesterNote>((note) => ({
    id: note.id,
    text: note.text,
    hasPin: Boolean(note.pin),
  }));
  const bugs = normalizeStepBugs(step).map<StepBugSummary>((bug) => ({
    id: bug.id,
    description: bug.description,
    hasPin: Boolean(bug.pin),
  }));

  const correlated = buildCorrelatedEvidence(step, ctx);

  const canonicalStep: CanonicalStep = {
    id: step.id,
    sourceStepId: step.id,
    index: step.index,
    timestamp: step.ts,
    ...(typeof ctx.nextStepTs === 'number' ? { durationToNextMs: Math.max(0, ctx.nextStepTs - step.ts) } : {}),
    action,
    ...(beforeEvidence ? { beforeEvidence } : {}),
    ...(afterEvidence ? { afterEvidence } : {}),
    systemEvidence,
    annotations,
    noVisibleChange: Boolean(step.noChangeDetected),
    testerNotes,
    bugs,
    correlated,
  };
  return canonicalStep;
}

function buildStepAnnotations(step: Step): StepAnnotation[] {
  const out: StepAnnotation[] = [];

  // Element highlight: rendered onto the BEFORE frame at export time — never
  // baked into the stored image (Screenshot principle).
  if (step.elementRect) {
    out.push({
      kind: 'highlight-rect',
      target: 'before',
      rect: {
        x: step.elementRect.x,
        y: step.elementRect.y,
        width: step.elementRect.width,
        height: step.elementRect.height,
      },
      sourceKind: 'element',
      sourceId: step.id,
    });
  }

  for (const note of normalizeStepNotes(step)) {
    if (!note.pin) continue;
    out.push({
      kind: 'pin',
      target: note.pin.target,
      xPercent: note.pin.x,
      yPercent: note.pin.y,
      ...(note.text ? { note: note.text } : {}),
      sourceKind: 'note',
      sourceId: note.id,
    });
  }
  for (const bug of normalizeStepBugs(step)) {
    if (!bug.pin) continue;
    out.push({
      kind: 'pin',
      target: bug.pin.target,
      xPercent: bug.pin.x,
      yPercent: bug.pin.y,
      ...(bug.description ? { note: bug.description } : {}),
      sourceKind: 'bug',
      sourceId: bug.id,
    });
  }
  return out;
}

// ─── Evidence refs ──────────────────────────────────────────────────────

function indexEvidenceStoredEvents(events: readonly TestEvent[]): ReadonlyMap<string, EvidenceStoredEvent> {
  const map = new Map<string, EvidenceStoredEvent>();
  for (const event of events) {
    if (event.kind === 'evidence_stored') map.set(event.id, event);
  }
  return map;
}

function resolveEvidenceRef(
  eventId: string | undefined,
  evidenceById: ReadonlyMap<string, EvidenceStoredEvent>,
  knownBlobKeys: ReadonlySet<string>,
): EvidenceRef | undefined {
  if (!eventId) return undefined;
  const evt = evidenceById.get(eventId);
  if (!evt) return undefined;

  return {
    blobKey: evt.blobKey,
    mimeType: evt.format,
    capturedAt: evt.ts,
    ...(typeof evt.width === 'number' ? { width: evt.width } : {}),
    ...(typeof evt.height === 'number' ? { height: evt.height } : {}),
    ...(typeof evt.bytes === 'number' ? { bytes: evt.bytes } : {}),
    ...(evt.capturePhase ? { capturePhase: evt.capturePhase } : {}),
    ...(typeof evt.aboveFold === 'boolean' ? { aboveFold: evt.aboveFold } : {}),
    ...(evt.componentName ? { componentName: evt.componentName } : {}),
    triggerConfidence: evt.confidence,
    sourceEventId: evt.id,
    missing: !knownBlobKeys.has(evt.blobKey),
  };
}

// ─── Per-step correlation (inline Level 2 signals) ──────────────────────

function buildCorrelatedEvidence(step: Step, ctx: StepProjectionContext): CorrelatedEvidence {
  const halfWindow = ctx.correlationWindowMs;
  const slaMs = Math.max(0, ctx.apiSlaSec) * 1000;
  const scopeOrigins = ctx.scopeOrigins;

  const failedRequests: NetworkFindingSummary[] = [];
  const slowRequests: NetworkFindingSummary[] = [];
  for (const request of ctx.requests) {
    if (Math.abs(request.startedAt - step.ts) > halfWindow) continue;
    const summary = requestToSummary(request, scopeOrigins, slaMs, step.ts);
    if (request.outcome === 'http_error' || request.outcome === 'network_error') {
      failedRequests.push(summary);
    }
    if (slaMs > 0 && typeof request.durationMs === 'number' && request.durationMs > slaMs) {
      slowRequests.push(summary);
    }
  }

  const consoleErrors: ConsoleFindingSummary[] = [];
  const pageErrors: ConsoleFindingSummary[] = [];
  let rageClicks = 0;
  let navigation: NavigationSummary | undefined;
  let closestNavGap = Number.POSITIVE_INFINITY;

  for (const event of ctx.events) {
    const deltaMs = event.ts - step.ts;
    if (Math.abs(deltaMs) > halfWindow) continue;

    switch (event.kind) {
      case 'console_error':
        consoleErrors.push(consoleEventToSummary(event, step.ts));
        break;
      case 'page_error':
        pageErrors.push(pageErrorEventToSummary(event, step.ts));
        break;
      case 'rage_click':
        if (matchesStep(event, step)) rageClicks += (event as RageClickEvent).clickCount ?? 1;
        break;
      case 'navigation': {
        // Prefer the navigation temporally closest to the step (either side).
        const gap = Math.abs(deltaMs);
        if (gap < closestNavGap) {
          closestNavGap = gap;
          navigation = navigationEventToSummary(event, step.ts);
        }
        break;
      }
      default:
        // Other event kinds are handled at the appendix level, not inline.
        break;
    }
  }

  return {
    failedRequests,
    slowRequests,
    consoleErrors,
    pageErrors,
    ...(navigation ? { navigation } : {}),
    rageClicks,
  };
}

function matchesStep(event: RageClickEvent, step: Step): boolean {
  // The current step engine does not carry a selector on the Step directly;
  // however a rage click within the ±window and on the same tab is a
  // conservative approximation. We deliberately do NOT claim causation.
  return event.tabId === step.tabId;
}

// ─── Summary builders ───────────────────────────────────────────────────

function requestToSummary(
  request: RequestView,
  scopeOrigins: readonly string[],
  slaMs: number,
  anchorTs?: number,
): NetworkFindingSummary {
  const isThirdParty = typeof request.isThirdParty === 'boolean'
    ? request.isThirdParty
    : isOriginThirdParty(request.origin, scopeOrigins);
  const isOverSla = slaMs > 0 && typeof request.durationMs === 'number' ? request.durationMs > slaMs : false;
  return {
    requestId: request.requestId,
    method: request.method,
    url: request.url,
    origin: request.origin,
    path: request.path,
    ...(typeof request.statusCode === 'number' ? { statusCode: request.statusCode } : {}),
    outcome: request.outcome,
    ...(typeof request.durationMs === 'number' ? { durationMs: request.durationMs } : {}),
    startedAt: request.startedAt,
    resourceType: request.resourceType,
    ...(typeof request.fromCache === 'boolean' ? { fromCache: request.fromCache } : {}),
    ...(typeof request.responseSize === 'number' ? { responseSizeBytes: request.responseSize } : {}),
    ...(request.errorText ? { errorText: request.errorText } : {}),
    isThirdParty,
    isOverSla,
    ...(typeof anchorTs === 'number' ? { temporalDeltaMs: request.startedAt - anchorTs } : {}),
  };
}

function isOriginThirdParty(origin: string, scopeOrigins: readonly string[]): boolean {
  if (!scopeOrigins.length) return false;
  const host = safeHost(origin);
  if (!host) return false;
  for (const scoped of scopeOrigins) {
    const scopedHost = safeHost(scoped) ?? scoped;
    if (scopedHost && host === scopedHost) return false;
  }
  return true;
}

function safeHost(input: string): string | undefined {
  try {
    // Scope origins are stored as glob-ish strings like "https://example.com/*";
    // strip trailing wildcard and parse.
    const cleaned = input.replace(/\/\*$/, '');
    return new URL(cleaned).host;
  } catch {
    return undefined;
  }
}

function consoleEventToSummary(event: ConsoleErrorEvent | ConsoleWarnEvent, anchorTs?: number): ConsoleFindingSummary {
  return {
    eventId: event.id,
    kind: event.kind,
    message: event.message,
    ...(event.stack ? { stack: event.stack } : {}),
    ...(event.pageUrl ? { pageUrl: event.pageUrl } : {}),
    timestamp: event.ts,
    ...(typeof anchorTs === 'number' ? { temporalDeltaMs: event.ts - anchorTs } : {}),
  };
}

function pageErrorEventToSummary(event: PageErrorEvent, anchorTs?: number): ConsoleFindingSummary {
  return {
    eventId: event.id,
    kind: 'page_error',
    message: event.message,
    ...(event.pageUrl ? { pageUrl: event.pageUrl } : {}),
    ...(event.source ? { source: event.source } : {}),
    ...(typeof event.lineno === 'number' ? { lineno: event.lineno } : {}),
    ...(typeof event.colno === 'number' ? { colno: event.colno } : {}),
    timestamp: event.ts,
    ...(typeof anchorTs === 'number' ? { temporalDeltaMs: event.ts - anchorTs } : {}),
  };
}

function navigationEventToSummary(event: NavigationEvent, anchorTs?: number): NavigationSummary {
  return {
    eventId: event.id,
    url: event.url,
    ...(event.previousUrl ? { previousUrl: event.previousUrl } : {}),
    isSpaRouteChange: event.isSpaRouteChange,
    ...(event.transitionType ? { transitionType: event.transitionType } : {}),
    timestamp: event.ts,
    ...(typeof anchorTs === 'number' ? { temporalDeltaMs: event.ts - anchorTs } : {}),
  };
}

// ─── Findings projection ────────────────────────────────────────────────

function projectFinding(
  finding: Finding,
  orderedSteps: readonly Step[],
  knownBlobKeys: ReadonlySet<string>,
): ObservedFinding {
  const stepIndex = orderedSteps.find((step) => step.ts <= finding.ts)?.index;

  const relatedEvidence: EvidenceRef[] = finding.evidence.map((evt) => ({
    blobKey: evt.blobKey,
    mimeType: evt.format,
    capturedAt: evt.ts,
    ...(typeof evt.width === 'number' ? { width: evt.width } : {}),
    ...(typeof evt.height === 'number' ? { height: evt.height } : {}),
    ...(typeof evt.bytes === 'number' ? { bytes: evt.bytes } : {}),
    ...(evt.capturePhase ? { capturePhase: evt.capturePhase } : {}),
    ...(typeof evt.aboveFold === 'boolean' ? { aboveFold: evt.aboveFold } : {}),
    ...(evt.componentName ? { componentName: evt.componentName } : {}),
    triggerConfidence: evt.confidence,
    sourceEventId: evt.id,
    missing: !knownBlobKeys.has(evt.blobKey),
  }));

  const relatedEventIds: string[] = [
    finding.primaryEventId,
    ...finding.relatedErrors.map((err) => err.id),
    ...finding.evidence.map((evt) => evt.id),
  ];

  const summary = buildFindingSummary(finding);
  const detail = buildFindingDetail(finding);

  return {
    id: finding.id,
    severity: finding.severity,
    type: finding.type,
    disposition: finding.disposition,
    status: finding.status,
    summary,
    ...(detail ? { detail } : {}),
    timestamp: finding.ts,
    seq: finding.seq,
    ...(finding.pageUrl ? { pageUrl: finding.pageUrl } : {}),
    ...(typeof stepIndex === 'number' ? { stepIndex } : {}),
    ...(finding.request?.requestId ? { relatedRequestId: finding.request.requestId } : {}),
    relatedEvidence,
    relatedEventIds,
    ...(finding.testerNote ? { testerNote: finding.testerNote } : {}),
    ...(finding.likelyPrecededBy ? { temporalDeltaFromClickMs: finding.likelyPrecededBy.gapMs } : {}),
    correlationClaim: 'observed_around_same_time',
  };
}

function buildFindingSummary(finding: Finding): string {
  switch (finding.type) {
    case 'HTTP_ERROR': {
      const status = finding.request?.statusCode ?? '???';
      const method = finding.request?.method ?? '???';
      const path = finding.request?.path ?? finding.request?.url ?? finding.pageUrl ?? '';
      return `HTTP ${status} ${method} ${path}`.trim();
    }
    case 'NETWORK_ERROR': {
      const method = finding.request?.method ?? '???';
      const path = finding.request?.path ?? finding.request?.url ?? '';
      const errorText = finding.request?.errorText ?? 'Network error';
      return `${errorText} — ${method} ${path}`.trim();
    }
    case 'CONSOLE_ERROR':
    case 'CONSOLE_WARN':
    case 'PAGE_ERROR': {
      const first = finding.relatedErrors[0];
      return first?.message ?? finding.type;
    }
    case 'MANUAL_EVIDENCE':
      return finding.note ?? 'Manual evidence';
    case 'RAGE_CLICK':
      return 'Rage click detected';
    case 'PERFORMANCE':
      return 'Performance signal';
    default:
      return finding.type;
  }
}

function buildFindingDetail(finding: Finding): string | undefined {
  const first = finding.relatedErrors[0];
  if (first && (first.kind === 'console_error' || first.kind === 'console_warn') && first.stack) {
    return first.stack;
  }
  if (finding.request?.errorText) return finding.request.errorText;
  return undefined;
}

// ─── Session-level rollups ──────────────────────────────────────────────

function buildOverview(
  session: Session,
  stats: ExecutionStatistics,
  requests: readonly RequestView[],
  events: readonly TestEvent[],
): TestOverview {
  const bugText = stats.bugs === 1 ? '1 bug' : `${stats.bugs} bugs`;
  const failText = stats.network.failed === 1 ? '1 failed request' : `${stats.network.failed} failed requests`;
  const verdictLabel = session.testResult === 'in_progress'
    ? 'In progress'
    : session.testResult.charAt(0).toUpperCase() + session.testResult.slice(1);
  const parts: string[] = [];
  if (stats.bugs > 0) parts.push(bugText);
  if (stats.network.failed > 0) parts.push(failText);
  if (stats.console.errors > 0) parts.push(`${stats.console.errors} console error${stats.console.errors === 1 ? '' : 's'}`);
  const verdictSummary = parts.length > 0 ? `${verdictLabel} — ${parts.join(', ')}` : verdictLabel;

  const negativeAssertions = buildNegativeAssertions(session, requests, events);

  return {
    ...(session.featureName ? { featureName: session.featureName } : {}),
    ...(session.testCaseName ? { testCaseName: session.testCaseName } : {}),
    ...(session.testCaseId ? { testCaseId: session.testCaseId } : {}),
    ...(session.testType ? { testType: session.testType } : {}),
    negativeTest: session.negativeTest,
    ...(session.status ? { status: session.status } : {}),
    testResult: session.testResult,
    verdictSummary,
    ...(session.notes ? { testerNotes: session.notes } : {}),
    ...(negativeAssertions.length > 0 ? { negativeAssertions } : {}),
  };
}

function buildNegativeAssertions(
  session: Session,
  requests: readonly RequestView[],
  events: readonly TestEvent[],
): NonNullable<TestOverview['negativeAssertions']> {
  if (session.negativeTest !== 'yes') return [];

  const assertions: NonNullable<TestOverview['negativeAssertions']>[number][] = [];
  const expectedHttpStatuses = (session.negativeExpectations?.httpStatuses ?? [])
    .filter((code) => Number.isInteger(code) && code >= 100 && code <= 599);

  if (expectedHttpStatuses.length > 0) {
    const observedStatusCodes = [...new Set(
      requests
        .map((request) => request.statusCode)
        .filter((code): code is number => Number.isInteger(code)),
    )].sort((a, b) => a - b);

    for (const expectedCode of expectedHttpStatuses) {
      const matched = requests.some((request) => request.statusCode === expectedCode);
      assertions.push({
        channel: 'http',
        expected: `HTTP ${expectedCode}`,
        observed: matched
          ? `HTTP ${expectedCode}`
          : observedStatusCodes.length > 0
            ? `Observed statuses: ${observedStatusCodes.join(', ')}`
            : 'No HTTP response status captured',
        verdict: matched ? 'pass' : 'fail',
      });
    }
  }

  const expectedUiSignals = (session.negativeExpectations?.uiSignals ?? [])
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  for (const expectedSignal of expectedUiSignals) {
    const token = expectedSignal.toLowerCase();
    const domHit = events.find(
      (event): event is DomChangeEvent => event.kind === 'dom_change' && event.summary.toLowerCase().includes(token),
    );
    const consoleHit = events.find((event): event is ConsoleErrorEvent | PageErrorEvent =>
      (event.kind === 'console_error' || event.kind === 'page_error')
      && event.message.toLowerCase().includes(token),
    );

    const observed = domHit
      ? `DOM signal: ${domHit.summary}`
      : consoleHit
        ? `Error signal: ${consoleHit.message}`
        : 'No matching UI/error signal captured';

    assertions.push({
      channel: 'ui',
      expected: expectedSignal,
      observed,
      verdict: (domHit || consoleHit) ? 'pass' : 'fail',
    });
  }

  return assertions;
}


function buildEnvironment(session: Session): EnvironmentSnapshot {
  const durationMs = typeof session.endedAt === 'number' ? session.endedAt - session.startedAt : undefined;
  const env = session.environment;
  return {
    startedAt: session.startedAt,
    ...(typeof session.endedAt === 'number' ? { endedAt: session.endedAt } : {}),
    ...(typeof durationMs === 'number' ? { durationMs } : {}),
    userAgent: env.userAgent,
    ...(env.chromeVersion ? { chromeVersion: env.chromeVersion } : {}),
    ...(env.platform ? { platform: env.platform } : {}),
    ...(env.extVersion ? { extVersion: env.extVersion } : {}),
    ...(env.timeZone ? { timeZone: env.timeZone } : {}),
    ...(env.viewport
      ? {
          viewport: {
            width: env.viewport.width,
            height: env.viewport.height,
            dpr: env.viewport.devicePixelRatio,
          },
        }
      : {}),
    scopeOrigins: [...session.scopeOrigins],
    ...(typeof session.apiSlaSec === 'number' ? { apiSlaSec: session.apiSlaSec } : {}),
  };
}

function buildStatistics(
  session: Session,
  events: readonly TestEvent[],
  orderedSteps: readonly Step[],
  requests: readonly RequestView[],
  findings: readonly Finding[],
): ExecutionStatistics {
  const stepsWithBugs = orderedSteps.filter((s) => normalizeStepBugs(s).length > 0).length;
  const stepsNoStateChange = orderedSteps.filter((s) => Boolean(s.noChangeDetected)).length;
  const bugs = orderedSteps.reduce((sum, s) => sum + normalizeStepBugs(s).length, 0);

  const slaMs = Math.max(0, session.apiSlaSec) * 1000;
  const failed = requests.filter((r) => r.outcome === 'http_error' || r.outcome === 'network_error').length;
  const slowOverSla = slaMs > 0
    ? requests.filter((r) => typeof r.durationMs === 'number' && r.durationMs > slaMs).length
    : 0;
  const thirdParty = requests.filter((r) => (typeof r.isThirdParty === 'boolean' ? r.isThirdParty : isOriginThirdParty(r.origin, session.scopeOrigins))).length;

  const severityCounts: Record<FindingSeverity, number> = { ...ZERO_SEVERITY_COUNTS };
  for (const finding of findings) severityCounts[finding.severity] += 1;

  const perf = summarizeWebVitals(events);

  return {
    steps: orderedSteps.length,
    stepsWithBugs,
    stepsNoStateChange,
    bugs,
    findings: severityCounts,
    network: {
      total: requests.length,
      failed,
      slowOverSla,
      thirdParty,
    },
    console: {
      errors: session.counters.consoleErrors,
      warnings: session.counters.consoleWarns,
      pageErrors: session.counters.pageErrors,
    },
    userSignals: {
      // Approximation: dashboard has not historically tracked total click
      // count on the session; steps ≈ user-driven clicks. Manual captures /
      // rage clicks / screenshots come from the authoritative counters.
      clicks: session.counters.steps ?? orderedSteps.length,
      rageClicks: session.counters.rageClicks,
      manualCaptures: session.counters.manualCaptures,
      screenshots: session.counters.screenshots,
    },
    ...(perf ? { performance: perf } : {}),
  };
}

function summarizeWebVitals(events: readonly TestEvent[]): ExecutionStatistics['performance'] {
  const latestByName = new Map<string, WebVitalEvent>();
  for (const event of events) {
    if (event.kind !== 'web_vital') continue;
    const existing = latestByName.get(event.name);
    if (!existing || existing.ts < event.ts) latestByName.set(event.name, event);
  }
  if (latestByName.size === 0) return undefined;
  const lcp = latestByName.get('LCP');
  const fcp = latestByName.get('FCP');
  const cls = latestByName.get('CLS');
  const inp = latestByName.get('INP');
  const ttfb = latestByName.get('TTFB');
  return {
    ...(lcp ? { lcpMs: lcp.value } : {}),
    ...(fcp ? { fcpMs: fcp.value } : {}),
    ...(cls ? { cls: cls.value } : {}),
    ...(inp ? { inpMs: inp.value } : {}),
    ...(ttfb ? { ttfbMs: ttfb.value } : {}),
  };
}

// ─── Appendix ───────────────────────────────────────────────────────────

function buildAppendix(
  events: readonly TestEvent[],
  requests: readonly RequestView[],
  checkpoints: readonly Checkpoint[],
  negativeInference: NegativeInferenceEvent | undefined,
  scopeOrigins: readonly string[],
  apiSlaSec: number,
): TechnicalAppendix {
  const slaMs = Math.max(0, apiSlaSec) * 1000;

  const network = requests.map((r) => requestToSummary(r, scopeOrigins, slaMs));

  const consoleWarnings: ConsoleFindingSummary[] = [];
  const webVitals: WebVitalSummary[] = [];
  const pageTimings: PageTimingSummary[] = [];
  const longTasks: LongTaskSummary[] = [];
  const memorySnapshots: MemorySnapshotSummary[] = [];
  const domMetrics: DomMetricsSummary[] = [];
  const cspViolations: CspViolationSummary[] = [];
  const navigationHistory: NavigationSummary[] = [];
  const pausedAt: number[] = [];
  const resumedAt: number[] = [];

  for (const event of events) {
    switch (event.kind) {
      case 'console_warn':
        consoleWarnings.push(consoleEventToSummary(event as ConsoleWarnEvent));
        break;
      case 'web_vital':
        webVitals.push(webVitalSummary(event as WebVitalEvent));
        break;
      case 'page_timing':
        pageTimings.push(pageTimingSummary(event as PageTimingEvent));
        break;
      case 'long_task':
        longTasks.push(longTaskSummary(event as LongTaskEvent));
        break;
      case 'memory_snapshot':
        memorySnapshots.push(memorySnapshotSummary(event as MemorySnapshotEvent));
        break;
      case 'dom_metrics':
        domMetrics.push(domMetricsSummary(event as DomMetricsEvent));
        break;
      case 'csp_violation':
        cspViolations.push(cspViolationSummary(event as CspViolationEvent));
        break;
      case 'navigation':
        navigationHistory.push(navigationEventToSummary(event as NavigationEvent));
        break;
      case 'capture_paused':
        pausedAt.push(event.ts);
        break;
      case 'capture_resumed':
        resumedAt.push(event.ts);
        break;
      default:
        break;
    }
  }

  const checkpointSummaries: CheckpointSummary[] = checkpoints.map((cp) => ({
    id: cp.id,
    name: cp.name,
    source: cp.source,
    ...(cp.pageUrl ? { pageUrl: cp.pageUrl } : {}),
    timestamp: cp.ts,
    ...(cp.note ? { note: cp.note } : {}),
  }));

  return {
    network,
    consoleWarnings,
    performance: { webVitals, pageTimings, longTasks, memorySnapshots },
    domMetrics,
    cspViolations,
    checkpoints: checkpointSummaries,
    navigationHistory,
    captureTimeline: { pausedAt, resumedAt },
    ...(negativeInference
      ? {
          negativeInference: {
            confidence: negativeInference.confidence,
            signals: [...negativeInference.signals],
            evidenceEventIds: [...negativeInference.evidenceEventIds],
            ...(negativeInference.testerVerdict ? { testerVerdict: negativeInference.testerVerdict } : {}),
          },
        }
      : {}),
  };
}

function webVitalSummary(event: WebVitalEvent): WebVitalSummary {
  return {
    eventId: event.id,
    name: event.name,
    value: event.value,
    rating: event.rating,
    ...(event.pageUrl ? { pageUrl: event.pageUrl } : {}),
    timestamp: event.ts,
  };
}

function pageTimingSummary(event: PageTimingEvent): PageTimingSummary {
  return {
    eventId: event.id,
    ttfbMs: event.ttfbMs,
    domContentLoadedMs: event.domContentLoadedMs,
    loadEventMs: event.loadEventMs,
    redirectCount: event.redirectCount,
    ...(event.pageUrl ? { pageUrl: event.pageUrl } : {}),
    timestamp: event.ts,
  };
}

function longTaskSummary(event: LongTaskEvent): LongTaskSummary {
  return {
    eventId: event.id,
    durationMs: event.duration,
    startTime: event.startTime,
    ...(event.pageUrl ? { pageUrl: event.pageUrl } : {}),
    timestamp: event.ts,
  };
}

function memorySnapshotSummary(event: MemorySnapshotEvent): MemorySnapshotSummary {
  return {
    eventId: event.id,
    usedJSHeapSizeBytes: event.usedJSHeapSizeBytes,
    totalJSHeapSizeBytes: event.totalJSHeapSizeBytes,
    jsHeapSizeLimitBytes: event.jsHeapSizeLimitBytes,
    timestamp: event.ts,
  };
}

function domMetricsSummary(event: DomMetricsEvent): DomMetricsSummary {
  return {
    eventId: event.id,
    nodeCount: event.nodeCount,
    maxDepth: event.maxDepth,
    ariaInvalidCount: event.ariaInvalidCount,
    missingAltCount: event.missingAltCount,
    unlabelledInteractiveCount: event.unlabelledInteractiveCount,
    ...(event.pageUrl ? { pageUrl: event.pageUrl } : {}),
    timestamp: event.ts,
  };
}

function cspViolationSummary(event: CspViolationEvent): CspViolationSummary {
  return {
    eventId: event.id,
    violatedDirective: event.violatedDirective,
    blockedURI: event.blockedURI,
    ...(event.pageUrl ? { pageUrl: event.pageUrl } : {}),
    timestamp: event.ts,
  };
}

