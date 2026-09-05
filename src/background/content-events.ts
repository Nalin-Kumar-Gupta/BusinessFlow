import type { ResourceSummary, Step, ElementRect } from '../core/types.js';
import { newEventId, newStepId } from '../core/ids.js';
import { appendEvent, putStep, getStep } from '../storage/db.js';
import { getActiveSessionId, nextSeq } from '../storage/session-state.js';
import { incrementCounter, nextStepIndex } from './session.js';


import { requestCapture } from './screenshot.js';
import { getInFlightRequestCount } from './net-observer.js';
import {
  evaluateAfterCaptureDecision,
  markAfterQueued,
  normalizeUrlForCompare,
} from './after-capture-policy.js';

const KNOWN_CONTENT_EVENT_KINDS = new Set([
  'user_click',
  'user_action_stable',
  'console_error',
  'page_error',
  'dom_change',
  'console_warn',
  'rage_click',
  'web_vital',
  'page_timing',
  'long_task',
  'memory_snapshot',
  'dom_metrics',
  'csp_violation',
  'resource_timing',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asElementRect(value: unknown): ElementRect | undefined {
  if (!isRecord(value)) return undefined;
  const num = (k: string) => typeof value[k] === 'number' ? (value[k] as number) : NaN;
  const rect: ElementRect = {
    x: num('x'),
    y: num('y'),
    width: num('width'),
    height: num('height'),
    pageScrollX: num('pageScrollX'),
    pageScrollY: num('pageScrollY'),
    viewportWidth: num('viewportWidth'),
    viewportHeight: num('viewportHeight'),
    devicePixelRatio: num('devicePixelRatio'),
  };
  for (const k of Object.keys(rect) as Array<keyof ElementRect>) {
    if (!Number.isFinite(rect[k])) return undefined;
  }
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  return rect;
}

function buildStepLabel(
  semanticLabel: string | undefined,
  accessibleName: string | undefined,
  tagName: string,
): string {
  const semantic = semanticLabel?.trim();
  if (semantic) return `Click "${semantic}"`;
  const name = accessibleName?.trim();
  if (name) return `Click "${name}"`;
  if (tagName) return `Click <${tagName}>`;
  return 'Click element';
}

function getKind(event: Record<string, unknown>): string | null {
  const kind = event['kind'];
  if (typeof kind !== 'string') return null;
  return KNOWN_CONTENT_EVENT_KINDS.has(kind) ? kind : null;
}

function asSafeResources(value: unknown): ResourceSummary[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((item) => {
    if (!isRecord(item)) {
      return {
        name: '',
        initiatorType: '',
        durationMs: 0,
        transferSizeBytes: 0,
        encodedBodySizeBytes: 0,
        failed: false,
      };
    }
    return {
      name: String(item['name'] ?? '').slice(0, 300),
      initiatorType: String(item['initiatorType'] ?? '').slice(0, 40),
      durationMs: Number(item['durationMs'] ?? 0),
      transferSizeBytes: Number(item['transferSizeBytes'] ?? 0),
      encodedBodySizeBytes: Number(item['encodedBodySizeBytes'] ?? 0),
      failed: item['failed'] === true,
    };
  });
}

const clickToStep = new Map<string, {
  stepId: string;
  sessionId: string;
  tabId: number;
  clickTs: number;
  generation: number;
}>();
const pendingAfterWatchdogs = new Map<string, number>();
const CLICK_TO_STEP_TTL_MS = 30_000;
const STEP_NOTE_MAX_LEN = 1000;
const AFTER_WATCHDOG_DELAY_MS = 1800;
const AFTER_NETWORK_QUIET_MS = 260;
const AFTER_NETWORK_MAX_WAIT_MS = 1400;
const AFTER_NETWORK_POLL_MS = 80;

// ─── Cross-module state for nav-aware after-frame (Option A) ───────────────
// nav-observer.ts reads these to decide whether an onBeforeNavigate fired
// within the click's causal window, and to mark a step as awaiting nav.
const lastClickTsByTab = new Map<number, number>();
const activeStepByTab = new Map<number, string>();
const interactionGenerationByTab = new Map<number, number>();
const pendingNavForStep = new Set<string>();
// Last time we saw a dom_change from a given tab — used by nav-observer to
// detect "page has rendered and stabilized" instead of relying on
// onCompleted, which fires way too early for SPAs like Workday.
const lastDomChangeAtByTab = new Map<number, number>();

export function getClickContextForTab(tabId: number): { clickTs?: number; stepId?: string; generation?: number } {
  return {
    clickTs: lastClickTsByTab.get(tabId),
    stepId: activeStepByTab.get(tabId),
    generation: interactionGenerationByTab.get(tabId),
  };
}

export function getInteractionGeneration(tabId: number): number {
  return interactionGenerationByTab.get(tabId) ?? 0;
}

export function isActiveStepForTab(tabId: number, stepId: string, generation?: number): boolean {
  if (activeStepByTab.get(tabId) !== stepId) return false;
  if (generation === undefined) return true;
  return interactionGenerationByTab.get(tabId) === generation;
}

export function getLastDomChangeAt(tabId: number): number | undefined {
  return lastDomChangeAtByTab.get(tabId);
}

export function markStepAwaitingNav(stepId: string): void {
  pendingNavForStep.add(stepId);
}

export function isStepAwaitingNav(stepId: string): boolean {
  return pendingNavForStep.has(stepId);
}

export function clearStepNavPending(stepId: string): void {
  pendingNavForStep.delete(stepId);
}

// Called from index.ts on tabs.onRemoved. Prevents per-tab state maps from
// growing unbounded across long testing sessions.
export function cleanupTabState(tabId: number): void {
  lastClickTsByTab.delete(tabId);
  activeStepByTab.delete(tabId);
  interactionGenerationByTab.delete(tabId);
  lastDomChangeAtByTab.delete(tabId);
}

// URLs that content scripts CANNOT be injected into per Chrome MV3 policy.
// Nav-aware after-frame relies on the content script emitting dom_change
// as its render signal; on non-scriptable URLs it will never fire, so the
// nav-aware path must skip these entirely and fall back to the standard
// navigation screenshot.
const NON_SCRIPTABLE_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'chrome-search://',
  'edge://',
  'about:',
  'data:',
  'file://',
  'view-source:',
  'devtools://',
];

export function isScriptableUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  for (const p of NON_SCRIPTABLE_URL_PREFIXES) {
    if (lower.startsWith(p)) return false;
  }
  // Chrome Web Store also blocks injection
  if (lower.startsWith('https://chrome.google.com/webstore')) return false;
  return lower.startsWith('http://') || lower.startsWith('https://');
}

async function getLiveTabUrl(tabId: number): Promise<string | undefined> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.url ?? tab.pendingUrl;
  } catch {
    return undefined;
  }
}

function hasStrictUrlDelta(beforeUrl: string | undefined, afterUrl: string | undefined): boolean {
  const before = normalizeUrlForCompare(beforeUrl);
  const after = normalizeUrlForCompare(afterUrl);
  return Boolean(before && after && before !== after);
}

async function waitForNetworkQuietOnTab(tabId: number): Promise<{ quiet: boolean; waitedMs: number }> {
  const started = Date.now();
  let zeroSince: number | null = null;

  while (Date.now() - started < AFTER_NETWORK_MAX_WAIT_MS) {
    const inFlight = getInFlightRequestCount(tabId);
    if (inFlight === 0) {
      zeroSince ??= Date.now();
      if (Date.now() - zeroSince >= AFTER_NETWORK_QUIET_MS) {
        return { quiet: true, waitedMs: Date.now() - started };
      }
    } else {
      zeroSince = null;
    }
    await new Promise<void>((r) => setTimeout(r, AFTER_NETWORK_POLL_MS));
  }

  return { quiet: false, waitedMs: Date.now() - started };
}

function scheduleLateAfterCaptureRecheck(
  sessionId: string,
  stepId: string,
  tabId: number,
  generation: number,
): void {
  setTimeout(() => {
    void (async () => {
      if (!isActiveStepForTab(tabId, stepId, generation)) return;
      if (isStepAwaitingNav(stepId)) return;

      const step = await getStep(stepId);
      if (!step || step.afterEvidenceEventId) return;

      const liveUrl = await getLiveTabUrl(tabId);
      if (!hasStrictUrlDelta(step.pageUrl, liveUrl)) return;

      console.log('[TestTrace] user_action_stable: late URL delta detected, queueing after-frame', {
        tabId,
        stepId,
        beforeUrl: step.pageUrl,
        liveUrl,
      });

      void requestCapture({
        sessionId,
        tabId,
        trigger: 'user_action_after',
        stepId,
        stepFrame: 'after',
        priority: 'normal',
        pageUrl: liveUrl,
        note: 'after_settle:url_changed_late_recheck',
      });
      await markAfterQueued(stepId, 'url_changed');
    })();
  }, 450);
}

function scheduleStepAfterWatchdog(
  sessionId: string,
  stepId: string,
  tabId: number,
  generation: number,
): void {
  const existing = pendingAfterWatchdogs.get(stepId);
  if (existing) clearTimeout(existing);

  const handle = setTimeout(() => {
    pendingAfterWatchdogs.delete(stepId);
    void (async () => {
      if (!isActiveStepForTab(tabId, stepId, generation)) return;
      if (isStepAwaitingNav(stepId)) return;

      const step = await getStep(stepId);
      if (!step || step.afterEvidenceEventId) return;

      const liveUrl = await getLiveTabUrl(tabId);
      const decision = await evaluateAfterCaptureDecision(sessionId, stepId, tabId, liveUrl, {
        navConfirmed: false,
        hasDomChangeSignal: false,
      });
      if (!decision.shouldCapture) return;

      console.log('[TestTrace] after-watchdog: URL delta with missing after, queueing capture', {
        sessionId,
        stepId,
        tabId,
        beforeUrl: step.pageUrl,
        liveUrl,
        reason: decision.reason,
      });

      void requestCapture({
        sessionId,
        tabId,
        trigger: 'user_action_after',
        stepId,
        stepFrame: 'after',
        priority: 'normal',
        pageUrl: liveUrl,
        note: `after_settle:${decision.reason}_watchdog_fallback`,
      });
      await markAfterQueued(stepId, decision.reason);
    })();
  }, AFTER_WATCHDOG_DELAY_MS) as unknown as number;

  pendingAfterWatchdogs.set(stepId, handle);
}

function cleanupClickToStep(now: number): void {
  for (const [key, value] of clickToStep.entries()) {
    if (now - value.clickTs > CLICK_TO_STEP_TTL_MS) clickToStep.delete(key);
  }
}

export async function updateStepNote(
  stepId: string,
  noteText: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sessionId = await getActiveSessionId();
  if (!sessionId) return { ok: false, error: 'No active session' };

  const step = await getStep(stepId);
  if (!step || step.sessionId !== sessionId) return { ok: false, error: 'Step not found' };

  const note = noteText.replace(/\s+/g, ' ').trim().slice(0, STEP_NOTE_MAX_LEN);
  const updated: Step = { ...step, note: note || undefined };
  await putStep(updated);

  chrome.runtime.sendMessage({
    type: 'TT_STEP_UPDATED',
    sessionId,
    stepId: updated.id,
    tabId: updated.tabId,
    note: updated.note ?? '',
    phase: 'note',
  }).catch(() => {});

  return { ok: true };
}

export async function handleContentEvent(
  msg: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const rawKind = isRecord(msg['event']) ? (msg['event'] as Record<string, unknown>)['kind'] : undefined;
  console.log('[TestTrace] handleContentEvent received', {
    kind: rawKind,
    tabId: sender.tab?.id,
    frameId: sender.frameId,
    url: sender.tab?.url,
  });
  const sessionId = await getActiveSessionId();
  if (!sessionId) {
    console.warn('[TestTrace] handleContentEvent dropped — no active session', { kind: rawKind });
    return;
  }

  const eventRaw = msg['event'];
  if (!isRecord(eventRaw)) return;
  const event = eventRaw;

  const tabId = sender.tab?.id ?? -1;
  const seq = await nextSeq();
  const kind = getKind(event);
  if (!kind) return;

  if (kind === 'user_click') {
    console.log('[TestTrace] user_click received', {
      sessionId,
      tabId,
      clickCorrelationId: event['clickCorrelationId'],
    });
    const accessibleName = typeof event['accessibleName'] === 'string'
      ? (event['accessibleName'] as string)
      : undefined;
    const semanticLabel = typeof event['semanticLabel'] === 'string'
      ? (event['semanticLabel'] as string)
      : undefined;
    const elementRect = asElementRect(event['elementRect']);
    const clickCorrelationId = typeof event['clickCorrelationId'] === 'string'
      ? event['clickCorrelationId'] as string
      : undefined;

    const clickEvent = {
      id: newEventId(), sessionId, ts: Date.now(), seq, kind: 'user_click' as const,
      tabId, confidence: 'observed' as const,
      selector: String(event['robustSelector'] ?? event['selector'] ?? ''),
      tagName: String(event['tagName'] ?? ''),
      role: event['role'] as string | undefined,
      ariaLabel: event['ariaLabel'] as string | undefined,
      text: semanticLabel ?? event['text'] as string | undefined,
      accessibleName,
      elementRect,
      pageUrl: event['pageUrl'] as string | undefined,
    };
    await appendEvent(clickEvent);
    await incrementCounter(sessionId, 'events');

    // Open a new step for this click.
    const index = await nextStepIndex(sessionId);
    const interactionGeneration = (interactionGenerationByTab.get(tabId) ?? 0) + 1;
    interactionGenerationByTab.set(tabId, interactionGeneration);
    const step: Step = {
      id: newStepId(),
      sessionId,
      tabId,
      index,
      ts: clickEvent.ts,
      seq,
      label: buildStepLabel(semanticLabel, accessibleName, clickEvent.tagName),
      semanticLabel,
      interactionGeneration,
      stepState: 'BEFORE_QUEUED',
      pageUrl: clickEvent.pageUrl,
      clickEventIds: [clickEvent.id],
      elementRect,
      systemEvidenceEventIds: [],
    };
    await putStep(step);

    chrome.runtime.sendMessage({
      type: 'TT_STEP_CREATED',
      sessionId,
      stepId: step.id,
      stepIndex: step.index,
      label: step.label,
      tabId,
      ts: step.ts,
    }).catch(() => {});

    console.log('[TestTrace] step created for click', {
      sessionId,
      tabId,
      stepId: step.id,
      stepIndex: step.index,
      clickCorrelationId,
    });

    if (clickCorrelationId) {
      cleanupClickToStep(Date.now());
      clickToStep.set(clickCorrelationId, {
        stepId: step.id,
        sessionId,
        tabId,
        clickTs: clickEvent.ts,
        generation: interactionGeneration,
      });
    }

    // Register for nav-aware after-frame (Option A).
    lastClickTsByTab.set(tabId, clickEvent.ts);
    activeStepByTab.set(tabId, step.id);
    scheduleStepAfterWatchdog(sessionId, step.id, tabId, interactionGeneration);

    console.log('[TestTrace] requesting before-frame capture', {
      sessionId,
      tabId,
      stepId: step.id,
      triggerEventId: clickEvent.id,
    });

    // "Before" frame for the step. Fired from earliest interaction phase
    // (pointerdown/mousedown) so we freeze pre-transition UI as soon as possible.
    void requestCapture({
      sessionId,
      tabId,
      trigger: 'user_action',
      triggerEventId: clickEvent.id,
      stepId: step.id,
      stepFrame: 'before',
      priority: 'high',
      explicitTabTarget: true,
      pageUrl: clickEvent.pageUrl,
    });
    return;
  }

  if (kind === 'user_action_stable') {
    console.log('[TestTrace] user_action_stable received', {
      sessionId,
      tabId,
      clickCorrelationId: event['clickCorrelationId'],
      stableReason: event['stableReason'],
    });
    const clickCorrelationId = typeof event['clickCorrelationId'] === 'string'
      ? event['clickCorrelationId'] as string
      : '';
    if (!clickCorrelationId) return;

    cleanupClickToStep(Date.now());
    const linked = clickToStep.get(clickCorrelationId);
    if (!linked || linked.sessionId !== sessionId) return;
    clickToStep.delete(clickCorrelationId);

    if (!isActiveStepForTab(linked.tabId, linked.stepId, linked.generation)) {
      console.log('[TestTrace] user_action_stable skipped — stale step superseded by newer click', {
        tabId: linked.tabId,
        staleStepId: linked.stepId,
      });
      return;
    }

    chrome.runtime.sendMessage({
      type: 'TT_STEP_UPDATED',
      sessionId,
      stepId: linked.stepId,
      tabId: linked.tabId,
      phase: 'stabilized',
    }).catch(() => {});

    console.log('[TestTrace] requesting after-frame capture', {
      sessionId,
      tabId: linked.tabId,
      stepId: linked.stepId,
      clickCorrelationId,
      stableReason: event['stableReason'],
    });

    // After-frame should target the same step as the click.
    // If nav-observer already took over (click caused a navigation), skip —
    // the after-frame will be captured after webNavigation.onCompleted instead.
    if (isStepAwaitingNav(linked.stepId)) {
      console.log('[TestTrace] user_action_stable skipped — step is awaiting nav', {
        stepId: linked.stepId,
      });
      return;
    }

    const hintedUrl = typeof event['pageUrl'] === 'string'
      ? event['pageUrl'] as string
      : sender.tab?.url;
    const liveUrl = await getLiveTabUrl(linked.tabId);
    const effectiveUrl = liveUrl ?? hintedUrl;
    const majorShiftResets = typeof event['majorShiftResets'] === 'number'
      ? event['majorShiftResets'] as number
      : 0;

    const decision = await evaluateAfterCaptureDecision(
      sessionId,
      linked.stepId,
      linked.tabId,
      effectiveUrl,
      { hasDomChangeSignal: majorShiftResets >= 1, navConfirmed: false },
    );

    if (!decision.shouldCapture) {
      if (decision.reason === 'same_url_no_change') {
        console.log('[TestTrace] user_action_stable: after-frame skipped (same URL as before)', {
          stepId: linked.stepId,
          tabId: linked.tabId,
          url: effectiveUrl,
          reason: decision.reason,
        });
        scheduleLateAfterCaptureRecheck(
          sessionId,
          linked.stepId,
          linked.tabId,
          linked.generation,
        );
      }
      return;
    }

    const networkQuiet = await waitForNetworkQuietOnTab(linked.tabId);
    void requestCapture({
      sessionId,
      tabId: linked.tabId,
      trigger: 'user_action_after',
      stepId: linked.stepId,
      stepFrame: 'after',
      priority: 'normal',
      pageUrl: effectiveUrl,
      note: `after_settle:${decision.reason} networkQuiet:${networkQuiet.quiet ? 'yes' : 'timeout'} waitMs:${networkQuiet.waitedMs}`,
    });

    await markAfterQueued(linked.stepId, decision.reason);
    return;
  }

  if (kind === 'console_error') {
    const ev = {
      id: newEventId(), sessionId, ts: Date.now(), seq, kind: 'console_error' as const,
      tabId, confidence: 'observed' as const,
      message: String(event['message'] ?? '').slice(0, 500),
      stack: event['stack'] as string | undefined,
      pageUrl: event['pageUrl'] as string | undefined,
    };
    await appendEvent(ev);
    await incrementCounter(sessionId, 'events');
    await incrementCounter(sessionId, 'consoleErrors');
    void requestCapture({ sessionId, tabId, trigger: 'console_error', triggerEventId: ev.id, priority: 'high' });
    return;
  }

  if (kind === 'page_error') {
    const ev = {
      id: newEventId(), sessionId, ts: Date.now(), seq, kind: 'page_error' as const,
      tabId, confidence: 'observed' as const,
      type: (event['type'] as 'uncaught' | 'unhandled_rejection') ?? 'uncaught',
      message: String(event['message'] ?? '').slice(0, 500),
      source: event['source'] as string | undefined,
      lineno: event['lineno'] as number | undefined,
      colno: event['colno'] as number | undefined,
      pageUrl: event['pageUrl'] as string | undefined,
    };
    await appendEvent(ev);
    await incrementCounter(sessionId, 'events');
    await incrementCounter(sessionId, 'pageErrors');
    void requestCapture({ sessionId, tabId, trigger: 'page_error', triggerEventId: ev.id, priority: 'high' });
    return;
  }

  if (kind === 'dom_change') {
    lastDomChangeAtByTab.set(tabId, Date.now());
    const ev = {
      id: newEventId(), sessionId, ts: Date.now(), seq, kind: 'dom_change' as const,
      tabId, confidence: 'observed' as const,
      summary: String(event['summary'] ?? ''),
      changeSignature: String(event['changeSignature'] ?? ''),
      pageUrl: event['pageUrl'] as string | undefined,
    };
    await appendEvent(ev);
    await incrementCounter(sessionId, 'events');
    void requestCapture({ sessionId, tabId, trigger: 'dom_change', triggerEventId: ev.id, priority: 'normal' });
    return;
  }

  if (kind === 'console_warn') {
    await appendEvent({
      id: newEventId(), sessionId, ts: Date.now(), seq, kind: 'console_warn',
      tabId, confidence: 'observed',
      message: String(event['message'] ?? '').slice(0, 500),
      stack: event['stack'] as string | undefined,
      pageUrl: event['pageUrl'] as string | undefined,
    });
    await incrementCounter(sessionId, 'events');
    await incrementCounter(sessionId, 'consoleWarns');
    return;
  }

  if (kind === 'rage_click') {
    await appendEvent({
      id: newEventId(), sessionId, ts: Date.now(), seq, kind: 'rage_click',
      tabId, confidence: 'observed',
      selector: String(event['selector'] ?? ''),
      tagName: String(event['tagName'] ?? ''),
      clickCount: Number(event['clickCount'] ?? 3),
      windowMs: Number(event['windowMs'] ?? 1000),
      pageUrl: event['pageUrl'] as string | undefined,
    });
    await incrementCounter(sessionId, 'events');
    await incrementCounter(sessionId, 'rageClicks');
    return;
  }

  if (kind === 'web_vital') {
    await appendEvent({
      id: newEventId(), sessionId, ts: Date.now(), seq, kind: 'web_vital',
      tabId, confidence: 'observed',
      name: event['name'] as 'LCP' | 'FCP' | 'CLS' | 'INP' | 'TTFB',
      value: Number(event['value'] ?? 0),
      rating: (event['rating'] ?? 'good') as 'good' | 'needs-improvement' | 'poor',
      pageUrl: event['pageUrl'] as string | undefined,
    });
    await incrementCounter(sessionId, 'events');
    return;
  }

  if (kind === 'page_timing') {
    await appendEvent({
      id: newEventId(), sessionId, ts: Date.now(), seq, kind: 'page_timing',
      tabId, confidence: 'observed',
      ttfbMs: Number(event['ttfbMs'] ?? 0),
      domContentLoadedMs: Number(event['domContentLoadedMs'] ?? 0),
      loadEventMs: Number(event['loadEventMs'] ?? 0),
      redirectCount: Number(event['redirectCount'] ?? 0),
      pageUrl: event['pageUrl'] as string | undefined,
    });
    await incrementCounter(sessionId, 'events');
    return;
  }

  if (kind === 'long_task') {
    await appendEvent({
      id: newEventId(), sessionId, ts: Date.now(), seq, kind: 'long_task',
      tabId, confidence: 'observed',
      duration: Number(event['duration'] ?? 0),
      startTime: Number(event['startTime'] ?? 0),
      pageUrl: event['pageUrl'] as string | undefined,
    });
    await incrementCounter(sessionId, 'events');
    return;
  }

  if (kind === 'memory_snapshot') {
    await appendEvent({
      id: newEventId(), sessionId, ts: Date.now(), seq, kind: 'memory_snapshot',
      tabId, confidence: 'observed',
      usedJSHeapSizeBytes: Number(event['usedJSHeapSizeBytes'] ?? 0),
      totalJSHeapSizeBytes: Number(event['totalJSHeapSizeBytes'] ?? 0),
      jsHeapSizeLimitBytes: Number(event['jsHeapSizeLimitBytes'] ?? 0),
      pageUrl: event['pageUrl'] as string | undefined,
    });
    await incrementCounter(sessionId, 'events');
    return;
  }

  if (kind === 'dom_metrics') {
    await appendEvent({
      id: newEventId(), sessionId, ts: Date.now(), seq, kind: 'dom_metrics',
      tabId, confidence: 'observed',
      nodeCount: Number(event['nodeCount'] ?? 0),
      maxDepth: Number(event['maxDepth'] ?? 0),
      ariaInvalidCount: Number(event['ariaInvalidCount'] ?? 0),
      missingAltCount: Number(event['missingAltCount'] ?? 0),
      unlabelledInteractiveCount: Number(event['unlabelledInteractiveCount'] ?? 0),
      pageUrl: event['pageUrl'] as string | undefined,
    });
    await incrementCounter(sessionId, 'events');
    return;
  }

  if (kind === 'csp_violation') {
    await appendEvent({
      id: newEventId(), sessionId, ts: Date.now(), seq, kind: 'csp_violation',
      tabId, confidence: 'observed',
      violatedDirective: String(event['violatedDirective'] ?? ''),
      blockedURI: String(event['blockedURI'] ?? ''),
      originalPolicy: String(event['originalPolicy'] ?? '').slice(0, 300),
      pageUrl: event['pageUrl'] as string | undefined,
    });
    await incrementCounter(sessionId, 'events');
    return;
  }

  if (kind === 'resource_timing') {
    await appendEvent({
      id: newEventId(), sessionId, ts: Date.now(), seq, kind: 'resource_timing',
      tabId, confidence: 'observed',
      resources: asSafeResources(event['resources']),
      pageUrl: event['pageUrl'] as string | undefined,
    });
    await incrementCounter(sessionId, 'events');
  }
}
