// Screenshot manager: queue, throttle, capture, store.
import type { EvidenceTrigger, UnavailableReason, TestEvent } from '../core/types.js';
import { newEventId, newBlobKey } from '../core/ids.js';
import { appendEvent, putBlob, getSession, getStep, putStep } from '../storage/db.js';
import { isPaused, checkScreenshotThrottle, nextSeq } from '../storage/session-state.js';
import { incrementCounter } from './session.js';
import { getSettings } from '../storage/settings.js';
import { isSessionTab } from '../storage/session-state.js';
import { getEventsForSession } from '../storage/db.js';

const RECENT_CAPTURE_LOOKBACK_MS = 5000;

// Session-level caps (persist via Session counters so they survive SW restarts)
const MAX_SCREENSHOTS_PER_SESSION = 150;
const MAX_MANUAL_PER_SESSION = 50;
const DEDUP_WINDOW_MS = 1200;
const BEFORE_FRAME_WAIT_ATTEMPTS = 10;
const BEFORE_FRAME_WAIT_INTERVAL_MS = 200;
const MIN_CAPTURE_VISIBLE_TAB_INTERVAL_MS = 400;
const BACKGROUND_CAPTURE_MIN_INTERVAL_MS = 700;
const CAPTURE_VISIBLE_TAB_MAX_ATTEMPTS = 3;
const CRITICAL_STEP_WINDOW_MS = 1200;
const OVERLAY_HIDE_SETTLE_MS = 60;
const OVERLAY_HIDE_SETTLE_MS_BEFORE = 8;
const BEFORE_FRAME_CAPTURE_QUALITY = 70;
const TRANSIENT_CAPTURE_RETRY_DELAYS_MS = [60, 120, 220] as const;

const NOISY_COALESCE_TRIGGERS = new Set<EvidenceTrigger>([
  'dom_change',
  'api_loading',
  'api_complete',
  'navigation',
  'session_start',
  'network_error',
]);

const recentCaptureFingerprints = new Map<string, number>();

interface CaptureQueueItem {
  req: CaptureRequest;
  enqueuedAt: number;
  order: number;
  deferCount: number;
  resolve: (result: CaptureResult) => void;
}

interface CaptureQueueStatsBucket {
  processed: number;
  waitMsTotal: number;
  execMsTotal: number;
}

interface CaptureQueueStats {
  processedTotal: number;
  buckets: Record<'before' | 'after' | 'system' | 'other', CaptureQueueStatsBucket>;
}

const captureQueues = new Map<string, CaptureQueueItem[]>();
const queueWorkers = new Set<string>();
const queueStatsBySession = new Map<string, CaptureQueueStats>();
const lastBackgroundCaptureAtBySession = new Map<string, number>();
const activeStepFrames = new Set<string>();
const criticalStepUntilByTab = new Map<string, number>();
const beforeFrameTerminalFailures = new Map<string, { sessionId: string; reason: UnavailableReason; ts: number }>();
let queueOrderCounter = 0;
let lastCaptureVisibleTabCallAt = 0;

function createEmptyQueueStats(): CaptureQueueStats {
  const emptyBucket = (): CaptureQueueStatsBucket => ({ processed: 0, waitMsTotal: 0, execMsTotal: 0 });
  return {
    processedTotal: 0,
    buckets: {
      before: emptyBucket(),
      after: emptyBucket(),
      system: emptyBucket(),
      other: emptyBucket(),
    },
  };
}

function queueBucketFor(req: CaptureRequest): keyof CaptureQueueStats['buckets'] {
  if (req.stepFrame === 'before') return 'before';
  if (req.stepFrame === 'after') return 'after';
  if (req.stepFrame === 'system') return 'system';
  return 'other';
}

function summarizeQueueStats(sessionId: string): void {
  const stats = queueStatsBySession.get(sessionId);
  if (!stats) return;

  const avg = (bucket: CaptureQueueStatsBucket): number => (
    bucket.processed === 0 ? 0 : Math.round(bucket.waitMsTotal / bucket.processed)
  );
  const avgExec = (bucket: CaptureQueueStatsBucket): number => (
    bucket.processed === 0 ? 0 : Math.round(bucket.execMsTotal / bucket.processed)
  );

  console.log('[TestTrace] capture-queue: metrics', {
    sessionId,
    processedTotal: stats.processedTotal,
    beforeAvgWaitMs: avg(stats.buckets.before),
    afterAvgWaitMs: avg(stats.buckets.after),
    systemAvgWaitMs: avg(stats.buckets.system),
    otherAvgWaitMs: avg(stats.buckets.other),
    beforeAvgExecMs: avgExec(stats.buckets.before),
    afterAvgExecMs: avgExec(stats.buckets.after),
    systemAvgExecMs: avgExec(stats.buckets.system),
    otherAvgExecMs: avgExec(stats.buckets.other),
  });
}

function tabSessionKey(sessionId: string, tabId: number): string {
  return `${sessionId}|${tabId}`;
}

function markCriticalStepWindow(req: CaptureRequest): void {
  if (!req.stepFrame) return;
  const key = tabSessionKey(req.sessionId, req.tabId);
  criticalStepUntilByTab.set(key, Date.now() + CRITICAL_STEP_WINDOW_MS);
}

function shouldSuppressForCriticalStepWindow(req: CaptureRequest): boolean {
  if (req.stepFrame) return false;
  if (req.trigger === 'manual') return false;
  // Keep only truly critical failures flowing during step window.
  if (req.trigger === 'console_error' || req.trigger === 'page_error' || req.trigger === 'http_error') return false;
  if (!NOISY_COALESCE_TRIGGERS.has(req.trigger)) return false;

  const key = tabSessionKey(req.sessionId, req.tabId);
  const until = criticalStepUntilByTab.get(key);
  if (!until) return false;
  if (Date.now() > until) {
    criticalStepUntilByTab.delete(key);
    return false;
  }
  return true;
}

function shouldCoalesceQueuedCapture(queue: CaptureQueueItem[], req: CaptureRequest): boolean {
  if (req.stepFrame) return false;
  if (!NOISY_COALESCE_TRIGGERS.has(req.trigger)) return false;
  return queue.some((item) => {
    const queued = item.req;
    return !queued.stepFrame
      && queued.tabId === req.tabId
      && queued.trigger === req.trigger
      && queued.componentName === req.componentName
      && queued.capturePhase === req.capturePhase;
  });
}

function hasQueuedBeforeFrame(sessionId: string): boolean {
  const queue = captureQueues.get(sessionId);
  if (!queue || queue.length === 0) return false;
  return queue.some((item) => item.req.stepFrame === 'before');
}

function shouldYieldToQueuedBefore(req: CaptureRequest): boolean {
  if (req.stepFrame) return false;
  if (req.trigger === 'manual') return false;
  return hasQueuedBeforeFrame(req.sessionId);
}

function stepFrameKey(req: CaptureRequest): string | null {
  if (!req.stepId || !req.stepFrame) return null;
  return `${req.sessionId}|${req.stepId}|${req.stepFrame}`;
}

function isStepFrameAlreadyQueued(queue: CaptureQueueItem[], req: CaptureRequest): boolean {
  if (!req.stepId || !req.stepFrame) return false;
  return queue.some((item) => item.req.stepId === req.stepId && item.req.stepFrame === req.stepFrame);
}

function isBackgroundLaneRequest(req: CaptureRequest): boolean {
  return !req.stepFrame && req.priority !== 'high' && req.trigger !== 'manual';
}

function hasQueuedStepCritical(sessionId: string): boolean {
  const queue = captureQueues.get(sessionId);
  if (!queue || queue.length === 0) return false;
  return queue.some((item) => item.req.stepFrame === 'before' || item.req.stepFrame === 'after');
}

function shouldDelayBackgroundLane(sessionId: string, req: CaptureRequest): boolean {
  if (!isBackgroundLaneRequest(req)) return false;
  if (hasQueuedStepCritical(sessionId)) return true;

  const lastBgAt = lastBackgroundCaptureAtBySession.get(sessionId) ?? 0;
  return Date.now() - lastBgAt < BACKGROUND_CAPTURE_MIN_INTERVAL_MS;
}

function captureQueuePriority(req: CaptureRequest): number {
  if (req.stepFrame === 'before') return 500;
  if (req.stepFrame === 'after') return 400;
  if (req.priority === 'high') return 300;
  if (req.trigger === 'manual') return 250;
  if (req.priority === 'normal') return 200;
  return 100;
}

function pickNextCaptureIndex(queue: CaptureQueueItem[]): number {
  let bestIndex = 0;
  for (let i = 1; i < queue.length; i++) {
    const candidate = queue[i]!;
    const best = queue[bestIndex]!;
    const candidatePriority = captureQueuePriority(candidate.req);
    const bestPriority = captureQueuePriority(best.req);
    if (candidatePriority > bestPriority) {
      bestIndex = i;
      continue;
    }
    if (candidatePriority === bestPriority && candidate.order < best.order) {
      bestIndex = i;
    }
  }
  return bestIndex;
}

function enqueueCaptureRequest(req: CaptureRequest): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const queue = captureQueues.get(req.sessionId) ?? [];

    if (isStepFrameAlreadyQueued(queue, req)) {
      console.log('[TestTrace] capture-queue: step-frame deduped (queued)', {
        sessionId: req.sessionId,
        stepId: req.stepId,
        stepFrame: req.stepFrame,
        trigger: req.trigger,
      });
      resolve({ ok: false, reason: 'throttled', detail: 'duplicate_step_frame_queued' });
      return;
    }

    const sfKey = stepFrameKey(req);
    if (sfKey && activeStepFrames.has(sfKey)) {
      console.log('[TestTrace] capture-queue: step-frame deduped (active)', {
        sessionId: req.sessionId,
        stepId: req.stepId,
        stepFrame: req.stepFrame,
        trigger: req.trigger,
      });
      resolve({ ok: false, reason: 'throttled', detail: 'duplicate_step_frame_active' });
      return;
    }

    if (shouldSuppressForCriticalStepWindow(req)) {
      console.log('[TestTrace] capture-queue: suppressed-by-step-window', {
        sessionId: req.sessionId,
        tabId: req.tabId,
        trigger: req.trigger,
        stepId: req.stepId,
      });
      resolve({ ok: false, reason: 'throttled', detail: 'suppressed_by_step_window' });
      return;
    }

    if (shouldCoalesceQueuedCapture(queue, req)) {
      console.log('[TestTrace] capture-queue: coalesced', {
        sessionId: req.sessionId,
        tabId: req.tabId,
        trigger: req.trigger,
        componentName: req.componentName,
        capturePhase: req.capturePhase,
        queueDepth: queue.length,
      });
      resolve({ ok: false, reason: 'throttled', detail: 'coalesced_in_queue' });
      return;
    }

    const item: CaptureQueueItem = {
      req,
      enqueuedAt: Date.now(),
      order: ++queueOrderCounter,
      deferCount: 0,
      resolve,
    };

    queue.push(item);
    captureQueues.set(req.sessionId, queue);
    markCriticalStepWindow(req);

    console.log('[TestTrace] capture-queue: enqueued', {
      sessionId: req.sessionId,
      tabId: req.tabId,
      trigger: req.trigger,
      stepId: req.stepId,
      stepFrame: req.stepFrame,
      priority: req.priority,
      queueDepth: queue.length,
      queuePriority: captureQueuePriority(req),
    });

    void processCaptureQueue(req.sessionId);
  });
}

async function processCaptureQueue(sessionId: string): Promise<void> {
  if (queueWorkers.has(sessionId)) return;
  queueWorkers.add(sessionId);

  try {
    while (true) {
      const queue = captureQueues.get(sessionId);
      if (!queue || queue.length === 0) {
        captureQueues.delete(sessionId);
        return;
      }

      const nextIndex = pickNextCaptureIndex(queue);
      const [item] = queue.splice(nextIndex, 1);
      if (!item) continue;
      if (queue.length === 0) captureQueues.delete(sessionId);

      if (item.req.stepFrame === 'after' && item.deferCount < 1 && hasQueuedBeforeFrame(sessionId)) {
        item.deferCount += 1;
        item.order = ++queueOrderCounter;
        const requeue = captureQueues.get(sessionId) ?? [];
        requeue.push(item);
        captureQueues.set(sessionId, requeue);
        console.log('[TestTrace] capture-queue: deferred-after-for-before', {
          sessionId,
          stepId: item.req.stepId,
          trigger: item.req.trigger,
          deferCount: item.deferCount,
          queueDepth: requeue.length,
        });
        continue;
      }

      if (shouldDelayBackgroundLane(sessionId, item.req)) {
        item.order = ++queueOrderCounter;
        const requeue = captureQueues.get(sessionId) ?? [];
        requeue.push(item);
        captureQueues.set(sessionId, requeue);

        const lastBgAt = lastBackgroundCaptureAtBySession.get(sessionId) ?? 0;
        const cooldownRemainingMs = Math.max(0, BACKGROUND_CAPTURE_MIN_INTERVAL_MS - (Date.now() - lastBgAt));
        const waitMs = hasQueuedStepCritical(sessionId)
          ? Math.min(100, Math.max(20, cooldownRemainingMs || 40))
          : Math.max(20, cooldownRemainingMs);

        console.log('[TestTrace] capture-queue: deferred-background-lane', {
          sessionId,
          trigger: item.req.trigger,
          queueDepth: requeue.length,
          waitMs,
          reason: hasQueuedStepCritical(sessionId) ? 'step_critical_pending' : 'background_cooldown',
        });

        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      const sfKey = stepFrameKey(item.req);
      if (sfKey) activeStepFrames.add(sfKey);

      console.log('[TestTrace] capture-queue: dequeued', {
        sessionId,
        tabId: item.req.tabId,
        trigger: item.req.trigger,
        stepId: item.req.stepId,
        stepFrame: item.req.stepFrame,
        priority: item.req.priority,
        waitMs: Date.now() - item.enqueuedAt,
        queueDepthAfter: queue.length,
      });

      let result: CaptureResult;
      const startedAt = Date.now();
      try {
        result = await executeCaptureRequest(item.req);
      } catch (error) {
        result = {
          ok: false,
          reason: 'capture_failed',
          detail: error instanceof Error ? error.message : String(error),
        };
      }

      if (sfKey) activeStepFrames.delete(sfKey);
      if (isBackgroundLaneRequest(item.req)) {
        lastBackgroundCaptureAtBySession.set(sessionId, Date.now());
      }

      const stats = queueStatsBySession.get(sessionId) ?? createEmptyQueueStats();
      const bucketName = queueBucketFor(item.req);
      const bucket = stats.buckets[bucketName];
      const waitMs = startedAt - item.enqueuedAt;
      const execMs = Date.now() - startedAt;
      bucket.processed += 1;
      bucket.waitMsTotal += waitMs;
      bucket.execMsTotal += execMs;
      stats.processedTotal += 1;
      queueStatsBySession.set(sessionId, stats);

      if (item.req.stepFrame === 'before' || stats.processedTotal % 10 === 0) {
        summarizeQueueStats(sessionId);
      }

      item.resolve(result);
    }
  } finally {
    queueWorkers.delete(sessionId);
  }
}

function cleanupFingerprintCache(now: number): void {
  for (const [key, ts] of recentCaptureFingerprints.entries()) {
    if (now - ts > DEDUP_WINDOW_MS * 2) {
      recentCaptureFingerprints.delete(key);
    }
  }
}

function buildCaptureFingerprint(req: CaptureRequest): string {
  return [
    req.sessionId,
    req.tabId,
    req.trigger,
    req.triggerEventId ?? '',
    req.componentName ?? '',
    req.apiRequestId ?? '',
    req.capturePhase ?? '',
    req.note ?? '',
    req.pageUrl ?? '',
  ].join('|');
}

function isDuplicateAutoCapture(req: CaptureRequest): boolean {
  if (req.trigger === 'manual') return false;
  const now = Date.now();
  cleanupFingerprintCache(now);
  const key = buildCaptureFingerprint(req);
  const prev = recentCaptureFingerprints.get(key);
  recentCaptureFingerprints.set(key, now);
  return prev !== undefined && now - prev <= DEDUP_WINDOW_MS;
}

type BeforeFrameWaitResult = 'ready' | 'failed' | 'timeout';

async function waitForBeforeFrame(stepId: string): Promise<BeforeFrameWaitResult> {
  for (let i = 0; i < BEFORE_FRAME_WAIT_ATTEMPTS; i++) {
    if (beforeFrameTerminalFailures.has(stepId)) return 'failed';
    const step = await getStep(stepId);
    if (!step) return 'ready';
    if (step.beforeEvidenceEventId) return 'ready';
    await new Promise<void>((resolve) => setTimeout(resolve, BEFORE_FRAME_WAIT_INTERVAL_MS));
  }
  console.error('[TestTrace] waitForBeforeFrame timeout: step=%s attempts=%d', stepId, BEFORE_FRAME_WAIT_ATTEMPTS);
  return 'timeout';
}

async function linkEvidenceToStep(req: CaptureRequest, evidenceEventId: string): Promise<void> {
  if (!req.stepId) return;
  const step = await getStep(req.stepId);
  if (!step) return;

  if (req.stepFrame === 'before') {
    step.beforeEvidenceEventId = evidenceEventId;
    step.stepState = 'BEFORE_STORED';
    beforeFrameTerminalFailures.delete(step.id);
  } else if (req.stepFrame === 'after') {
    step.afterEvidenceEventId = evidenceEventId;
    step.stepState = 'AFTER_STORED';
  } else {
    if (!step.systemEvidenceEventIds.includes(evidenceEventId)) {
      step.systemEvidenceEventIds.push(evidenceEventId);
    }
  }
  await putStep(step);

  chrome.runtime.sendMessage({
    type: 'TT_STEP_UPDATED',
    sessionId: req.sessionId,
    stepId: step.id,
    frame: req.stepFrame ?? 'system',
    evidenceEventId,
  }).catch(() => {});
}

/**
 * Fallback for step-before frames when live capture isn't possible (e.g., click
 * opened a new tab and the source tab lost focus). Finds the most recent stored
 * evidence event from the same tab within RECENT_CAPTURE_LOOKBACK_MS and links
 * it as this step's before-frame. Returns true if a candidate was linked.
 */
async function linkRecentCaptureAsBefore(req: CaptureRequest): Promise<boolean> {
  if (!req.stepId) return false;
  const step = await getStep(req.stepId);
  if (!step || step.beforeEvidenceEventId) return false;

  const events = await getEventsForSession(req.sessionId);
  const cutoff = Date.now() - RECENT_CAPTURE_LOOKBACK_MS;

  // Newest first, only stored evidence on the same tab within lookback window.
  const candidate = [...events]
    .reverse()
    .find((e) => e.kind === 'evidence_stored' && e.tabId === req.tabId && e.ts >= cutoff);

  if (!candidate) return false;

  step.beforeEvidenceEventId = candidate.id;
  await putStep(step);

  console.log('[TestTrace] linked recent capture as before-frame', {
    stepId: step.id, evidenceEventId: candidate.id, tabId: req.tabId,
  });
  emitCaptureDebug(req.tabId, {
    phase: 'linked_recent',
    trigger: req.trigger,
    stepId: step.id,
    stepFrame: 'before',
    evidenceEventId: candidate.id,
  });

  chrome.runtime.sendMessage({
    type: 'TT_STEP_UPDATED',
    sessionId: req.sessionId,
    stepId: step.id,
    frame: 'before',
    evidenceEventId: candidate.id,
  }).catch(() => {});

  return true;
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(',')[1] ?? '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function dataUrlMimeType(dataUrl: string): string {
  const match = /^data:([^;]+);base64,/.exec(dataUrl);
  return match?.[1] ?? 'image/jpeg';
}

async function decodeCaptureDataUrl(
  dataUrl: string,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const bytes = dataUrlToBytes(dataUrl);
  try {
    const mimeType = dataUrlMimeType(dataUrl);
    const copied = new Uint8Array(new ArrayBuffer(bytes.byteLength));
    copied.set(bytes);
    const blob = new Blob([copied], { type: mimeType });
    const bitmap = await createImageBitmap(blob);
    const width = bitmap.width;
    const height = bitmap.height;
    bitmap.close();
    return { bytes: copied, width, height };
  } catch {
    return { bytes, width: 0, height: 0 };
  }
}

export interface CaptureRequest {
  sessionId: string;
  tabId: number;
  trigger: EvidenceTrigger;
  triggerEventId?: string;
  note?: string;
  pageUrl?: string;
  priority: 'high' | 'normal' | 'low';
  /**
   * If true, capture must use req.tabId only.
   * Do NOT fall back to another active session tab.
   */
  explicitTabTarget?: boolean;
  /** Inferred component name from API URL — e.g. "Inventory Health" */
  componentName?: string;
  /** The webRequest requestId that triggered this screenshot */
  apiRequestId?: string;
  /** loading = in-flight screenshot; complete = post-settle screenshot */
  capturePhase?: 'loading' | 'complete';
  /**
   * Confidence level from the signal pipeline.
   * 'observed'      — direct ARIA/DOM observation (alert, dialog, error).
   * 'inferred-high' — heuristic + fingerprint change corroborates signal.
   * 'inferred-low'  — fallback; carry-over from existing non-pipeline captures.
   * Defaults to 'observed' when not set.
   */
  confidence?: 'observed' | 'inferred-high' | 'inferred-low';
  /** If this capture belongs to a click-driven step, the step id. */
  stepId?: string;
  /** Which frame of the step this evidence represents. */
  stepFrame?: 'before' | 'after' | 'system';
}

// Throttle config
const MIN_INTERVAL_NORMAL_MS = 2000;
const MIN_INTERVAL_FAILURE_MS = 800;
const MIN_INTERVAL_DOM_MS = 2000; // More frequent screenshots on UI changes

function emitCaptureDebug(tabId: number, payload: Record<string, unknown>): void {
  chrome.tabs.sendMessage(tabId, {
    type: 'TT_CAPTURE_DEBUG',
    payload,
  }).catch(() => {});
}

function isCaptureQuotaError(error: unknown): boolean {
  return String(error).includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
}

function isTransientCaptureError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes('image readback failed')
    || message.includes('failed to capture tab')
    || message.includes('no tab with id')
    || message.includes('tab was closed')
    || message.includes('cannot access contents of the page');
}

async function waitForCaptureVisibleTabBudget(skipBudgetWait: boolean): Promise<void> {
  if (skipBudgetWait) return;
  const now = Date.now();
  const elapsed = now - lastCaptureVisibleTabCallAt;
  if (elapsed < MIN_CAPTURE_VISIBLE_TAB_INTERVAL_MS) {
    await new Promise<void>((resolve) => setTimeout(resolve, MIN_CAPTURE_VISIBLE_TAB_INTERVAL_MS - elapsed));
  }
}

async function captureVisibleTabWithRetry(
  windowId: number,
  quality: number,
  options?: { stepFrame?: CaptureRequest['stepFrame'] },
): Promise<{ dataUrl?: string; error: string }> {
  let lastError = '';
  const isStepCapture = Boolean(options?.stepFrame);
  const maxAttempts = CAPTURE_VISIBLE_TAB_MAX_ATTEMPTS + (isStepCapture ? TRANSIENT_CAPTURE_RETRY_DELAYS_MS.length : 0);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await waitForCaptureVisibleTabBudget(isStepCapture);
    lastCaptureVisibleTabCallAt = Date.now();

    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality });
      return { dataUrl, error: '' };
    } catch (error) {
      lastError = String(error);
      const quotaRetryable = isCaptureQuotaError(error);
      const transientRetryable = isStepCapture && isTransientCaptureError(error);
      const isLast = attempt === maxAttempts;
      if ((!quotaRetryable && !transientRetryable) || isLast) {
        break;
      }

      if (quotaRetryable) {
        await new Promise<void>((resolve) => setTimeout(resolve, 250 * attempt));
        continue;
      }

      const transientDelay = TRANSIENT_CAPTURE_RETRY_DELAYS_MS[Math.min(attempt - 1, TRANSIENT_CAPTURE_RETRY_DELAYS_MS.length - 1)] ?? 220;
      await new Promise<void>((resolve) => setTimeout(resolve, transientDelay));
    }
  }

  return { error: lastError };
}

export interface CaptureResult {
  ok: boolean;
  requestedEventId?: string;
  evidenceEventId?: string;
  reason?: UnavailableReason;
  detail?: string;
}

export async function requestCaptureWithResult(req: CaptureRequest): Promise<CaptureResult> {
  return enqueueCaptureRequest(req);
}

async function executeCaptureRequest(req: CaptureRequest): Promise<CaptureResult> {
    console.log('[TestTrace] requestCapture:start', {
      sessionId: req.sessionId,
      tabId: req.tabId,
      trigger: req.trigger,
      stepId: req.stepId,
      stepFrame: req.stepFrame,
      priority: req.priority,
      pageUrl: req.pageUrl,
    });
    emitCaptureDebug(req.tabId, {
      phase: 'start',
      trigger: req.trigger,
      stepId: req.stepId,
      stepFrame: req.stepFrame,
      priority: req.priority,
    });

    let requestedEventId = '';

    try {
      const seq = await nextSeq();

      // Write evidence_requested first so a SW death mid-capture is visible
      const reqEv: TestEvent = {
        id: newEventId(),
        sessionId: req.sessionId,
        ts: Date.now(),
        seq,
        kind: 'evidence_requested',
        tabId: req.tabId,
        trigger: req.trigger,
        triggerEventId: req.triggerEventId,
        stepId: req.stepId,
        note: req.note,
        pageUrl: req.pageUrl,
        confidence: 'observed',
      };
      await appendEvent(reqEv);
      requestedEventId = reqEv.id;

      // Check paused (manual captures bypass pause)
      if (req.trigger !== 'manual' && await isPaused()) {
        await recordFailed(req, reqEv.id, seq + 1, 'paused');
        return { ok: false, requestedEventId: reqEv.id, reason: 'paused' };
      }

      // After-frame capture must happen after the before-frame has been stored.
      // If this times out, continue anyway to avoid stalling the pipeline.
      if (req.stepId && req.stepFrame === 'after') {
        const existingStep = await getStep(req.stepId);
        if (existingStep?.afterEvidenceEventId) {
          await recordFailed(req, reqEv.id, seq + 1, 'throttled', 'after_already_stored');
          return { ok: false, requestedEventId: reqEv.id, reason: 'throttled', detail: 'after_already_stored' };
        }

        const beforeState = await waitForBeforeFrame(req.stepId);
        if (beforeState === 'timeout') {
          console.error('[TestTrace] before-frame missing, continuing with after-frame capture: step=%s', req.stepId);
        } else if (beforeState === 'failed') {
          const failure = beforeFrameTerminalFailures.get(req.stepId);
          console.warn('[TestTrace] before-frame failed earlier, skipping wait and continuing with after-frame capture', {
            stepId: req.stepId,
            reason: failure?.reason,
            failedAt: failure?.ts,
          });
        }
      }

      if (isDuplicateAutoCapture(req)) {
        await recordFailed(req, reqEv.id, seq + 1, 'throttled', 'deduplicated within short window');
        return { ok: false, requestedEventId: reqEv.id, reason: 'throttled', detail: 'deduplicated within short window' };
      }

      if (shouldYieldToQueuedBefore(req)) {
        await recordFailed(req, reqEv.id, seq + 1, 'throttled', 'yielded_to_before_frame');
        return { ok: false, requestedEventId: reqEv.id, reason: 'throttled', detail: 'yielded_to_before_frame' };
      }

      const session = await getSession(req.sessionId);
      const total = session?.counters.screenshots ?? 0;
      if (total >= MAX_SCREENSHOTS_PER_SESSION) {
        await recordFailed(req, reqEv.id, seq + 1, 'quota_exceeded');
        return { ok: false, requestedEventId: reqEv.id, reason: 'quota_exceeded' };
      }
      if (req.trigger === 'manual') {
        const manualTotal = session?.counters.manualCaptures ?? 0;
        if (manualTotal >= MAX_MANUAL_PER_SESSION) {
          await recordFailed(req, reqEv.id, seq + 1, 'quota_exceeded');
          return { ok: false, requestedEventId: reqEv.id, reason: 'quota_exceeded' };
        }
      }

      // Throttle
      // Step-linked captures (before/after/system) should not be throttled, otherwise
      // a recent session_start/dom_change capture can suppress click evidence.
      const minInterval = req.stepFrame ? 0
        : req.trigger === 'manual' ? 0
        : req.priority === 'high' ? MIN_INTERVAL_FAILURE_MS
        : req.priority === 'low' ? MIN_INTERVAL_DOM_MS
        : MIN_INTERVAL_NORMAL_MS;

      if (minInterval > 0) {
        const allowed = await checkScreenshotThrottle(req.tabId, minInterval);
        if (!allowed) {
          console.log('[TestTrace] capture throttled', {
            sessionId: req.sessionId,
            tabId: req.tabId,
            trigger: req.trigger,
            stepId: req.stepId,
            stepFrame: req.stepFrame,
            minInterval,
          });
          await recordFailed(req, reqEv.id, seq + 1, 'throttled');
          return { ok: false, requestedEventId: reqEv.id, reason: 'throttled' };
        }
      }

      // Find the tab (with brief retry — mid-navigation clicks can momentarily
      // report the tab as inactive/loading before Chrome settles the new state).
      // If the original tab is no longer active (e.g., click opened a new tab that
      // stole focus, or user switched tabs), fall back to whichever session tab
      // IS currently active in the same window — that's what the user is looking at.
      let tab: chrome.tabs.Tab | undefined;
      let effectiveTabId = req.tabId;
      const isStepCapture = Boolean(req.stepFrame) || req.trigger === 'user_action' || req.trigger === 'user_action_after';
      // Before-frame should be captured ASAP. If the original tab already lost
      // focus, don't burn ~1.2s retrying; fail fast and use recent-capture fallback.
      const activeRetries = req.stepFrame === 'before' ? 1 : (isStepCapture ? 8 : 1);
      let activeAttempt = 0;
      while (activeAttempt < activeRetries) {
        try { tab = await chrome.tabs.get(effectiveTabId); } catch {
          tab = undefined;
          break;
        }
        if (tab.active) break;
        activeAttempt++;
        if (activeAttempt < activeRetries) {
          await new Promise<void>((r) => setTimeout(r, 150));
        }
      }

      // Fallback: if original tab is still not active, capture whichever session
      // tab is now active in the same window (handles clicks that open new tabs
      // and steal focus, or user tab-switching mid-step).
      if (isStepCapture && !req.explicitTabTarget && (!tab || !tab.active)) {
        const query: chrome.tabs.QueryInfo & { windowId?: number } = { active: true };
        if (tab?.windowId !== undefined) query.windowId = tab.windowId;
        let activeTabs: chrome.tabs.Tab[] = [];
        try {
          activeTabs = await chrome.tabs.query(query as chrome.tabs.QueryInfo);
        } catch { activeTabs = []; }

        for (const candidate of activeTabs) {
          if (!candidate.id) continue;
          if (!await isSessionTab(candidate.id)) continue;
          tab = candidate;
          effectiveTabId = candidate.id;
          console.log('[TestTrace] capture fallback to active session tab', {
            original: req.tabId, effective: effectiveTabId, stepFrame: req.stepFrame,
          });
          break;
        }
      }

      if (!tab) {
        // For step-before frames on a tab that vanished, try recent-capture fallback.
        if (req.stepFrame === 'before' && req.stepId) {
          const linked = await linkRecentCaptureAsBefore(req);
          if (linked) {
            await recordFailed(req, reqEv.id, seq + 1, 'tab_not_found', 'linked_recent_capture');
            return { ok: false, requestedEventId: reqEv.id, reason: 'tab_not_found', detail: 'linked_recent_capture' };
          }
        }
        await recordFailed(req, reqEv.id, seq + 1, 'tab_not_found');
        return { ok: false, requestedEventId: reqEv.id, reason: 'tab_not_found' };
      }

      // Only capture active tabs. If the tab isn't active, try to focus its
      // window/tab once before declaring failure.
      if (!tab.active) {
        try {
          const windowsApi = chrome.windows as unknown as {
            update: (windowId: number, updateInfo: { focused?: boolean }) => Promise<chrome.windows.Window>;
          };
          const tabsApi = chrome.tabs as unknown as {
            update: (tabId: number, updateProperties: { active?: boolean }) => Promise<chrome.tabs.Tab>;
          };
          await windowsApi.update(tab.windowId, { focused: true });
          await tabsApi.update(effectiveTabId, { active: true });
          await new Promise<void>((resolve) => setTimeout(resolve, 140));
          tab = await chrome.tabs.get(effectiveTabId);
        } catch {
          // Best-effort focus; fallback below handles failure paths.
        }
      }

      if (!tab.active) {
        if (req.stepFrame === 'before' && req.stepId) {
          const linked = await linkRecentCaptureAsBefore(req);
          if (linked) {
            await recordFailed(req, reqEv.id, seq + 1, 'tab_not_active', 'linked_recent_capture');
            return { ok: false, requestedEventId: reqEv.id, reason: 'tab_not_active', detail: 'linked_recent_capture' };
          }
        }
        await recordFailed(req, reqEv.id, seq + 1, 'tab_not_active', 'tab_could_not_be_focused');
        return { ok: false, requestedEventId: reqEv.id, reason: 'tab_not_active', detail: 'tab_could_not_be_focused' };
      }

      // Check for restricted URLs
      const url = tab.url ?? tab.pendingUrl ?? '';
      if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) {
        await recordFailed(req, reqEv.id, seq + 1, 'restricted_url');
        return { ok: false, requestedEventId: reqEv.id, reason: 'restricted_url' };
      }

      // ─── Scroll-to-component (the "something else" for below-fold content) ────
      let originalScrollY: number | undefined;
      let didScroll = false;

      if (req.componentName && (req.trigger === 'api_complete' || req.trigger === 'api_loading')) {
        try {
          type ScrollResponse = { ok: boolean; originalScrollY: number };
          const scrollResp = await chrome.tabs.sendMessage(effectiveTabId, {
            type: 'TT_SCROLL_TO_COMPONENT',
            componentName: req.componentName,
          }) as ScrollResponse | undefined;

          if (scrollResp?.ok) {
            originalScrollY = scrollResp.originalScrollY;
            didScroll = true;
            await new Promise<void>((resolve) => setTimeout(resolve, 80));
          }
        } catch {
          // Content script not injected or tab unresponsive — proceed without scroll
        }
      }

      // ─── Hide extension UI so it doesn't appear in screenshots ─────────────────
      let overlayHidden = false;
      try {
        await chrome.tabs.sendMessage(effectiveTabId, { type: 'TT_HIDE_OVERLAY' });
        const overlaySettleMs = req.stepFrame === 'before' ? OVERLAY_HIDE_SETTLE_MS_BEFORE : OVERLAY_HIDE_SETTLE_MS;
        if (overlaySettleMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, overlaySettleMs));
        }
        overlayHidden = true;
      } catch { /* content script not injected — proceed anyway */ }

      // Capture — try with the tab's windowId first.
      const quality = req.stepFrame === 'before'
        ? BEFORE_FRAME_CAPTURE_QUALITY
        : await getSettings().then((s) => s.screenshotQuality).catch(() => 82);

      if (shouldYieldToQueuedBefore(req)) {
        if (overlayHidden) chrome.tabs.sendMessage(effectiveTabId, { type: 'TT_SHOW_OVERLAY' }).catch(() => {});
        await recordFailed(req, reqEv.id, seq + 1, 'throttled', 'yielded_to_before_frame_pre_capture');
        return { ok: false, requestedEventId: reqEv.id, reason: 'throttled', detail: 'yielded_to_before_frame_pre_capture' };
      }

      let dataUrl: string | undefined;
      let firstError = '';

      const primaryCapture = await captureVisibleTabWithRetry(tab.windowId, quality, { stepFrame: req.stepFrame });
      dataUrl = primaryCapture.dataUrl;
      firstError = primaryCapture.error;

      if (!dataUrl && firstError) {
        console.error('[TestTrace] captureVisibleTab failed:', firstError);
        console.warn('[TestTrace] captureVisibleTab failed (windowId=%d): %s', tab.windowId, firstError);

        try {
          const focusedWin = await chrome.windows.getLastFocused();
          if (focusedWin.id !== undefined && focusedWin.id !== tab.windowId) {
            const fallbackCapture = await captureVisibleTabWithRetry(focusedWin.id, 82, { stepFrame: req.stepFrame });
            dataUrl = fallbackCapture.dataUrl;
            if (!dataUrl && fallbackCapture.error) firstError = fallbackCapture.error;
          }
        } catch { /* fallback also failed - dataUrl stays undefined */ }
      }

      if (dataUrl === undefined) {
        if (overlayHidden) chrome.tabs.sendMessage(effectiveTabId, { type: 'TT_SHOW_OVERLAY' }).catch(() => {});
        await recordFailed(req, reqEv.id, seq + 1, 'capture_failed', firstError);
        return { ok: false, requestedEventId: reqEv.id, reason: 'capture_failed', detail: firstError };
      }

      if (overlayHidden) {
        chrome.tabs.sendMessage(effectiveTabId, { type: 'TT_SHOW_OVERLAY' }).catch(() => {});
      }

      const rendered = await decodeCaptureDataUrl(dataUrl);

      const blobKey = newBlobKey();
      await putBlob({ key: blobKey, data: rendered.bytes, mimeType: 'image/jpeg', storedAt: Date.now(), sessionId: req.sessionId });

      if (didScroll && originalScrollY !== undefined) {
        chrome.tabs.sendMessage(effectiveTabId, {
          type: 'TT_SCROLL_RESTORE',
          scrollY: originalScrollY,
        }).catch(() => {});
      }

      const storeSeq = await nextSeq();
      const storeEv: TestEvent = {
        id: newEventId(),
        sessionId: req.sessionId,
        ts: Date.now(),
        seq: storeSeq,
        kind: 'evidence_stored',
        tabId: effectiveTabId,
        requestedEventId: reqEv.id,
        trigger: req.trigger,
        blobKey,
        width: rendered.width,
        height: rendered.height,
        bytes: rendered.bytes.length,
        format: 'image/jpeg',
        pageUrl: url,
        note: req.note,
        confidence: req.confidence ?? 'observed',
        componentName: req.componentName,
        apiRequestId: req.apiRequestId,
        capturePhase: req.capturePhase,
        aboveFold: !didScroll,
        stepId: req.stepId,
        stepFrame: req.stepFrame,
      };
      await appendEvent(storeEv);
      console.log('[TestTrace] requestCapture:stored', {
        sessionId: req.sessionId,
        tabId: effectiveTabId,
        trigger: req.trigger,
        stepId: req.stepId,
        stepFrame: req.stepFrame,
        evidenceEventId: storeEv.id,
        bytes: rendered.bytes.length,
      });
      emitCaptureDebug(effectiveTabId, {
        phase: 'stored',
        trigger: req.trigger,
        stepId: req.stepId,
        stepFrame: req.stepFrame,
        evidenceEventId: storeEv.id,
        bytes: rendered.bytes.length,
      });
      await linkEvidenceToStep(req, storeEv.id);

      await incrementCounter(req.sessionId, 'screenshots');
      if (req.trigger === 'manual') await incrementCounter(req.sessionId, 'manualCaptures');
      await incrementCounter(req.sessionId, 'events');

      return {
        ok: true,
        requestedEventId: reqEv.id,
        evidenceEventId: storeEv.id,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (requestedEventId) {
        const recoverySeq = await nextSeq().catch(() => Date.now());
        await recordFailed(req, requestedEventId, recoverySeq, 'capture_failed', detail).catch(() => {});
      }
      return {
        ok: false,
        ...(requestedEventId ? { requestedEventId } : {}),
        reason: 'capture_failed',
        detail,
      };
    }
}

export async function requestCapture(req: CaptureRequest): Promise<void> {
  await requestCaptureWithResult(req);
}

async function recordFailed(
  req: CaptureRequest,
  requestedEventId: string,
  seq: number,
  reason: UnavailableReason,
  detail?: string,
): Promise<void> {
  const payload = {
    sessionId: req.sessionId,
    tabId: req.tabId,
    trigger: req.trigger,
    stepId: req.stepId,
    stepFrame: req.stepFrame,
    reason,
    detail,
  };

  // Most failures are expected control-flow (throttle, tab switched, etc.).
  // Keep only true capture errors loud; emit routine failures as debug.
  if (reason === 'capture_failed') {
    console.warn('[TestTrace] requestCapture:failed', payload);
  } else {
    console.debug('[TestTrace] requestCapture:failed', payload);
  }

  if (req.stepId && req.stepFrame === 'before' && (
    reason === 'capture_failed'
    || reason === 'tab_not_active'
    || reason === 'tab_not_found'
    || reason === 'restricted_url'
  )) {
    beforeFrameTerminalFailures.set(req.stepId, {
      sessionId: req.sessionId,
      reason,
      ts: Date.now(),
    });

    const step = await getStep(req.stepId);
    if (step && step.stepState !== 'BEFORE_STORED') {
      step.stepState = 'BEFORE_FAILED';
      await putStep(step);
    }
  }
  emitCaptureDebug(req.tabId, {
    phase: 'failed',
    trigger: req.trigger,
    stepId: req.stepId,
    stepFrame: req.stepFrame,
    reason,
    detail,
  });

  const ev: TestEvent = {
    id: newEventId(),
    sessionId: req.sessionId,
    ts: Date.now(),
    seq,
    kind: 'evidence_failed',
    tabId: req.tabId,
    requestedEventId,
    trigger: req.trigger,
    unavailableReason: reason,
    detail,
    confidence: 'observed',
  };
  await appendEvent(ev);
}

export function clearSessionCounts(sessionId: string): void {
  captureQueues.delete(sessionId);
  queueWorkers.delete(sessionId);
  queueStatsBySession.delete(sessionId);
  lastBackgroundCaptureAtBySession.delete(sessionId);

  for (const key of activeStepFrames) {
    if (key.startsWith(`${sessionId}|`)) activeStepFrames.delete(key);
  }

  for (const [key] of criticalStepUntilByTab.entries()) {
    if (key.startsWith(`${sessionId}|`)) criticalStepUntilByTab.delete(key);
  }
  for (const [stepId, failed] of beforeFrameTerminalFailures.entries()) {
    if (failed.sessionId === sessionId) beforeFrameTerminalFailures.delete(stepId);
  }

  const prefix = `${sessionId}|`;
  for (const key of recentCaptureFingerprints.keys()) {
    if (key.startsWith(prefix)) {
      recentCaptureFingerprints.delete(key);
    }
  }
}
