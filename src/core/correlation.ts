// Correlation engine — pure functions, no Chrome APIs.
// Input: Session + raw events. Output: RequestViews, Findings, Checkpoints, NegativeInference.

import type {
  TestEvent, NetPhaseEvent, UserClickEvent, ConsoleErrorEvent, PageErrorEvent,
  DomChangeEvent, EvidenceStoredEvent, EvidenceFailedEvent, NegativeInferenceEvent,
  NavigationEvent, CheckpointEvent, Session, SessionReport, RequestView, Finding,
  Checkpoint, FindingType, FindingDisposition, FindingSeverity, Step,
} from './types.js';
import { CORRELATION_VERSION } from './types.js';
import { groupByRequest, foldRequest } from './fold.js';
import { safePath } from './url.js';
import { newFindingId, newCheckpointId } from './ids.js';

const CLICK_BEFORE_FAILURE_MS = 3000;
const ERROR_AFTER_FAILURE_MS = 2500;
const DOM_AFTER_FAILURE_MS = 2000;

/**
 * Auto-derived severity. A tester can override it later via Finding.status /
 * severity in the report UI. This is a presentation-ordering hint, NOT a
 * defect judgement: 'expected-negative' findings are demoted to 'info'
 * because during a negative test a 4xx is the expected result.
 */
function normalizeExpectedHttpStatuses(session: Session): Set<number> {
  const out = new Set<number>();
  for (const code of session.negativeExpectations?.httpStatuses ?? []) {
    if (Number.isInteger(code) && code >= 100 && code <= 599) out.add(code);
  }
  return out;
}

function normalizeExpectedUiSignals(session: Session): string[] {
  return (session.negativeExpectations?.uiSignals ?? [])
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
}

function messageMatchesExpectedUiSignal(
  message: string | undefined,
  expectedSignals: readonly string[],
): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return expectedSignals.some((signal) => normalized.includes(signal));
}

function deriveSeverity(
  type: FindingType,
  disposition: FindingDisposition,
  statusCode?: number,
): FindingSeverity {
  if (disposition === 'expected-negative') return 'info';
  if (disposition === 'tester-marked') return 'info';
  if (type === 'NETWORK_ERROR') return 'high';
  if (type === 'HTTP_ERROR') return (statusCode ?? 0) >= 500 ? 'critical' : 'high';
  if (type === 'PAGE_ERROR') return 'high';
  if (type === 'CONSOLE_ERROR') return 'medium';
  if (type === 'CONSOLE_WARN') return 'low';
  return 'info';
}

export function buildReport(session: Session, events: TestEvent[], steps: Step[] = []): SessionReport {
  const sorted = [...events].sort((a, b) => a.seq - b.seq || a.ts - b.ts);

  // Group net events → RequestViews
  const requestMap = groupByRequest(sorted);
  const requests: RequestView[] = [...requestMap.values()].map(foldRequest);
  requests.sort((a, b) => a.seq - b.seq);

  // Index by kind for fast lookup
  const clicks = sorted.filter((e): e is UserClickEvent => e.kind === 'user_click');
  const navs = sorted.filter((e): e is NavigationEvent => e.kind === 'navigation');
  const consoleErrors = sorted.filter((e): e is ConsoleErrorEvent => e.kind === 'console_error');
  const pageErrors = sorted.filter((e): e is PageErrorEvent => e.kind === 'page_error');
  const domChanges = sorted.filter((e): e is DomChangeEvent => e.kind === 'dom_change');
  const stored = sorted.filter((e): e is EvidenceStoredEvent => e.kind === 'evidence_stored');
  const failed = sorted.filter((e): e is EvidenceFailedEvent => e.kind === 'evidence_failed');
  const manualCheckpoints = sorted.filter((e): e is CheckpointEvent => e.kind === 'checkpoint');

  // `triggerEventId` is recorded ONLY on evidence_requested. Stored/failed
  // events reference it indirectly through requestedEventId, so resolve the
  // link here. Without this indirection NO screenshot ever attaches to a
  // finding, because the field does not exist on the stored event at all.
  const triggerOf = new Map<string, string>();
  for (const e of sorted) {
    if (e.kind === 'evidence_requested' && e.triggerEventId) {
      triggerOf.set(e.id, e.triggerEventId);
    }
  }
  const triggerFor = (e: EvidenceStoredEvent | EvidenceFailedEvent): string | undefined =>
    triggerOf.get(e.requestedEventId);

  const expectedHttpStatuses = normalizeExpectedHttpStatuses(session);
  const expectedUiSignals = normalizeExpectedUiSignals(session);

  // Build findings for error requests
  const findings: Finding[] = [];
  for (const req of requests) {
    if (req.outcome !== 'http_error' && req.outcome !== 'network_error') continue;

    const type: FindingType = req.outcome === 'http_error' ? 'HTTP_ERROR' : 'NETWORK_ERROR';
    const disposition: FindingDisposition =
      session.negativeTest === 'yes'
      && req.outcome === 'http_error'
      && typeof req.statusCode === 'number'
      && expectedHttpStatuses.has(req.statusCode)
        ? 'expected-negative'
        : 'observed-failure';

    // Net phase event IDs for this request
    const phaseIds = new Set(
      sorted
        .filter((e): e is NetPhaseEvent => e.kind === 'net_phase' && e.requestId === req.requestId)
        .map((e) => e.id),
    );

    // Screenshots anchored to any phase event of this request.
    // apiRequestId is the direct link when the net observer set it; the
    // resolved trigger id covers captures anchored to a specific phase event.
    const evidence = stored.filter((e) => {
      if (e.apiRequestId === req.requestId) return true;
      const t = triggerFor(e);
      return t !== undefined && phaseIds.has(t);
    });
    const unavailable = failed.filter((e) => {
      const t = triggerFor(e);
      return t !== undefined && phaseIds.has(t);
    });

    // Infer: click that likely triggered this request
    const precedingClick = findPreceding(clicks, req.startedAt, CLICK_BEFORE_FAILURE_MS);

    // Errors that followed the failure
    const relatedErrors: Array<ConsoleErrorEvent | PageErrorEvent> = [
      ...consoleErrors.filter((e) => e.ts > req.startedAt && e.ts - req.startedAt < ERROR_AFTER_FAILURE_MS && e.tabId === req.tabId),
      ...pageErrors.filter((e) => e.ts > req.startedAt && e.ts - req.startedAt < ERROR_AFTER_FAILURE_MS && e.tabId === req.tabId),
    ];

    const domChangeAfter = domChanges.find(
      (e) => e.ts > req.startedAt && e.ts - req.startedAt < DOM_AFTER_FAILURE_MS && e.tabId === req.tabId,
    );

    findings.push({
      id: newFindingId(),
      type,
      disposition,
      severity: deriveSeverity(type, disposition, req.statusCode),
      status: 'open',
      ts: req.startedAt,
      seq: req.seq,
      request: req,
      primaryEventId: req.requestId,
      pageUrl: req.url,
      likelyPrecededBy: precedingClick
        ? {
            eventId: precedingClick.id,
            confidence: 'inferred-high',
            rationale: `Click on <${precedingClick.tagName}> ${Math.round(req.startedAt - precedingClick.ts)}ms before request`,
            gapMs: req.startedAt - precedingClick.ts,
          }
        : undefined,
      evidence,
      unavailable,
      relatedErrors,
      domChangeAfter,
    });
  }

  // Manual evidence findings
  const manualStored = stored.filter((e) => e.trigger === 'manual');
  for (const ev of manualStored) {
    findings.push({
      id: newFindingId(),
      type: 'MANUAL_EVIDENCE',
      disposition: 'tester-marked',
      severity: 'info',
      status: 'open',
      ts: ev.ts,
      seq: ev.seq,
      primaryEventId: ev.id,
      pageUrl: ev.pageUrl,
      evidence: [ev],
      unavailable: failed.filter((f) => f.requestedEventId === ev.requestedEventId),
      relatedErrors: [],
      note: ev.note,
    });
  }

  // Page / console error findings (not already linked to a request)
  const linkedErrorIds = new Set(findings.flatMap((f) => f.relatedErrors.map((e) => e.id)));
  for (const err of [...consoleErrors, ...pageErrors]) {
    if (linkedErrorIds.has(err.id)) continue;
    const errType: FindingType = err.kind === 'console_error' ? 'CONSOLE_ERROR' : 'PAGE_ERROR';
    const errDisposition: FindingDisposition =
      session.negativeTest === 'yes' && messageMatchesExpectedUiSignal(err.message, expectedUiSignals)
        ? 'expected-negative'
        : 'observed-failure';
    findings.push({
      id: newFindingId(),
      type: errType,
      disposition: errDisposition,
      severity: deriveSeverity(errType, errDisposition),
      status: 'open',
      ts: err.ts,
      seq: err.seq,
      primaryEventId: err.id,
      pageUrl: 'pageUrl' in err ? err.pageUrl : undefined,
      evidence: stored.filter((e) => triggerFor(e) === err.id),
      unavailable: failed.filter((e) => triggerFor(e) === err.id),
      relatedErrors: [err],
    });
  }

  findings.sort((a, b) => a.seq - b.seq);

  // Build checkpoints
  const checkpoints: Checkpoint[] = [];

  // Navigation checkpoints
  for (const nav of navs) {
    checkpoints.push({
      id: newCheckpointId(),
      sessionId: session.id,
      name: `Navigated to ${safePath(nav.url)}`,
      ts: nav.ts,
      seq: nav.seq,
      source: 'navigation',
      pageUrl: nav.url,
      eventIds: [nav.id],
    });
  }

  // Manual checkpoint events
  for (const cp of manualCheckpoints) {
    checkpoints.push({
      id: newCheckpointId(),
      sessionId: session.id,
      name: cp.name,
      ts: cp.ts,
      seq: cp.seq,
      source: cp.source,
      pageUrl: cp.pageUrl,
      eventIds: [cp.id],
      note: cp.note,
    });
  }

  // Failure checkpoints
  for (const finding of findings) {
    if (finding.type === 'MANUAL_EVIDENCE') continue;
    checkpoints.push({
      id: newCheckpointId(),
      sessionId: session.id,
      name: `${finding.type.replace('_', ' ')}: ${finding.request?.url ?? finding.type}`,
      ts: finding.ts,
      seq: finding.seq,
      source: 'failure',
      pageUrl: finding.pageUrl,
      eventIds: [finding.primaryEventId],
    });
  }

  checkpoints.sort((a, b) => a.seq - b.seq);

  // Negative test inference (for automatic mode or when session is unknown)
  let negativeInference: NegativeInferenceEvent | undefined;
  if (session.negativeTest === 'unknown' || session.mode === 'automatic') {
    negativeInference = inferNegativeTest(session, sorted, requests, findings);
  }

  return {
    session,
    events: sorted,
    requests,
    findings,
    checkpoints,
    steps,
    negativeInference,
    correlationVersion: CORRELATION_VERSION,
  };
}

function findPreceding<T extends { ts: number }>(
  candidates: T[],
  ts: number,
  windowMs: number,
): T | undefined {
  // Find the most recent candidate within the window before ts
  let best: T | undefined;
  for (const c of candidates) {
    if (c.ts <= ts && ts - c.ts <= windowMs) {
      if (!best || c.ts > best.ts) best = c;
    }
  }
  return best;
}

function inferNegativeTest(
  session: Session,
  events: TestEvent[],
  requests: RequestView[],
  _findings: Finding[],
): NegativeInferenceEvent | undefined {
  const signals: string[] = [];
  const evidenceEventIds: string[] = [];

  const errorRequests = requests.filter(
    (r) => r.outcome === 'http_error' || r.outcome === 'network_error',
  );
  const http4xx = errorRequests.filter((r) => r.statusCode && r.statusCode >= 400 && r.statusCode < 500);
  const http5xx = errorRequests.filter((r) => r.statusCode && r.statusCode >= 500);
  const netErrors = errorRequests.filter((r) => r.outcome === 'network_error');
  const consoleErrors = events.filter((e) => e.kind === 'console_error');
  const pageErrors = events.filter((e) => e.kind === 'page_error');
  const domChanges = events.filter((e) => e.kind === 'dom_change');

  if (http4xx.length > 0) {
    signals.push(`${http4xx.length} HTTP 4xx response(s) (${http4xx.map((r) => r.statusCode).join(', ')})`);
    evidenceEventIds.push(...http4xx.map((r) => r.requestId));
  }
  if (http5xx.length > 0) {
    signals.push(`${http5xx.length} HTTP 5xx response(s)`);
    evidenceEventIds.push(...http5xx.map((r) => r.requestId));
  }
  if (netErrors.length > 0) {
    signals.push(`${netErrors.length} network error(s)`);
  }
  if (consoleErrors.length > 0) {
    signals.push(`${consoleErrors.length} console error(s)`);
    evidenceEventIds.push(...consoleErrors.map((e) => e.id));
  }
  if (pageErrors.length > 0) {
    signals.push(`${pageErrors.length} uncaught page error(s)`);
    evidenceEventIds.push(...pageErrors.map((e) => e.id));
  }
  if (domChanges.length > 0 && errorRequests.length > 0) {
    signals.push('DOM state changed after error response (possible error UI)');
  }

  if (signals.length === 0) return undefined;

  // High confidence: 4xx/5xx + console/page errors
  // Low confidence: only network errors or only console errors
  const confidence =
    (http4xx.length > 0 || http5xx.length > 0) && (consoleErrors.length > 0 || pageErrors.length > 0)
      ? ('inferred-high' as const)
      : ('inferred-low' as const);

  const firstErrorTs = Math.min(
    ...[...http4xx, ...http5xx, ...netErrors].map((r) => r.startedAt),
    ...consoleErrors.map((e) => e.ts),
    ...pageErrors.map((e) => e.ts),
    Infinity,
  );

  if (!isFinite(firstErrorTs)) return undefined;

  return {
    id: `ev:neg-inf:${session.id}`,
    sessionId: session.id,
    ts: firstErrorTs,
    seq: 0,
    kind: 'negative_inference',
    tabId: -1,
    confidence,
    signals,
    evidenceEventIds,
    testerVerdict: undefined,
  };
}

// Re-export from fold.ts for convenience
export { groupByRequest, foldRequest } from './fold.js';
export { safeOrigin, safePath } from './url.js';
