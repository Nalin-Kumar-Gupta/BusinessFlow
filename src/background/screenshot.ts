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
const CAPTURE_VISIBLE_TAB_MAX_ATTEMPTS = 3;

const recentCaptureFingerprints = new Map<string, number>();
const captureLocks = new Map<string, Promise<void>>();
let lastCaptureVisibleTabCallAt = 0;

async function withCaptureLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prior = captureLocks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const chained = prior.then(() => gate);
  captureLocks.set(sessionId, chained);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (captureLocks.get(sessionId) === chained) {
      captureLocks.delete(sessionId);
    }
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

async function waitForBeforeFrame(stepId: string): Promise<boolean> {
  for (let i = 0; i < BEFORE_FRAME_WAIT_ATTEMPTS; i++) {
    const step = await getStep(stepId);
    if (!step) return true;
    if (step.beforeEvidenceEventId) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, BEFORE_FRAME_WAIT_INTERVAL_MS));
  }
  console.error('[TestTrace] waitForBeforeFrame timeout: step=%s attempts=%d', stepId, BEFORE_FRAME_WAIT_ATTEMPTS);
  return false;
}

async function linkEvidenceToStep(req: CaptureRequest, evidenceEventId: string): Promise<void> {
  if (!req.stepId) return;
  const step = await getStep(req.stepId);
  if (!step) return;

  if (req.stepFrame === 'before') {
    step.beforeEvidenceEventId = evidenceEventId;
  } else if (req.stepFrame === 'after') {
    step.afterEvidenceEventId = evidenceEventId;
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

async function waitForCaptureVisibleTabBudget(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCaptureVisibleTabCallAt;
  if (elapsed < MIN_CAPTURE_VISIBLE_TAB_INTERVAL_MS) {
    await new Promise<void>((resolve) => setTimeout(resolve, MIN_CAPTURE_VISIBLE_TAB_INTERVAL_MS - elapsed));
  }
}

async function captureVisibleTabWithRetry(windowId: number, quality: number): Promise<{ dataUrl?: string; error: string }> {
  let lastError = '';

  for (let attempt = 1; attempt <= CAPTURE_VISIBLE_TAB_MAX_ATTEMPTS; attempt++) {
    await waitForCaptureVisibleTabBudget();
    lastCaptureVisibleTabCallAt = Date.now();

    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality });
      return { dataUrl, error: '' };
    } catch (error) {
      lastError = String(error);
      if (!isCaptureQuotaError(error) || attempt === CAPTURE_VISIBLE_TAB_MAX_ATTEMPTS) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250 * attempt));
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
  return withCaptureLock(req.sessionId, async () => {
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
        const beforeReady = await waitForBeforeFrame(req.stepId);
        if (!beforeReady) {
          console.error('[TestTrace] before-frame missing, continuing with after-frame capture: step=%s', req.stepId);
        }
      }

      if (isDuplicateAutoCapture(req)) {
        await recordFailed(req, reqEv.id, seq + 1, 'throttled', 'deduplicated within short window');
        return { ok: false, requestedEventId: reqEv.id, reason: 'throttled', detail: 'deduplicated within short window' };
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
      const activeRetries = isStepCapture ? 8 : 1; // ~8 * 150ms = ~1.2s grace
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

      // Only capture active tabs. For step-before frames, if we still can't capture
      // (e.g., click opened a new tab and the source tab is now backgrounded),
      // link the most recent stored evidence from the same tab as the before-frame.
      // Visually this shows what the button looked like just before the click.
      if (!tab.active) {
        if (req.stepFrame === 'before' && req.stepId) {
          const linked = await linkRecentCaptureAsBefore(req);
          if (linked) {
            await recordFailed(req, reqEv.id, seq + 1, 'tab_not_active', 'linked_recent_capture');
            return { ok: false, requestedEventId: reqEv.id, reason: 'tab_not_active', detail: 'linked_recent_capture' };
          }
        }
        await recordFailed(req, reqEv.id, seq + 1, 'tab_not_active');
        return { ok: false, requestedEventId: reqEv.id, reason: 'tab_not_active' };
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
          const scrollResp = await chrome.tabs.sendMessage(req.tabId, {
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
        await chrome.tabs.sendMessage(req.tabId, { type: 'TT_HIDE_OVERLAY' });
        await new Promise<void>((resolve) => setTimeout(resolve, 60));
        overlayHidden = true;
      } catch { /* content script not injected — proceed anyway */ }

      // Capture — try with the tab's windowId first.
      // Read quality from user settings (non-blocking; defaults to 82 on error)
      const quality = await getSettings().then((s) => s.screenshotQuality).catch(() => 82);

      let dataUrl: string | undefined;
      let firstError = '';

      const primaryCapture = await captureVisibleTabWithRetry(tab.windowId, quality);
      dataUrl = primaryCapture.dataUrl;
      firstError = primaryCapture.error;

      if (!dataUrl && firstError) {
        console.error('[TestTrace] captureVisibleTab failed:', firstError);
        console.warn('[TestTrace] captureVisibleTab failed (windowId=%d): %s', tab.windowId, firstError);

        try {
          const focusedWin = await chrome.windows.getLastFocused();
          if (focusedWin.id !== undefined && focusedWin.id !== tab.windowId) {
            const fallbackCapture = await captureVisibleTabWithRetry(focusedWin.id, 82);
            dataUrl = fallbackCapture.dataUrl;
            if (!dataUrl && fallbackCapture.error) firstError = fallbackCapture.error;
          }
        } catch { /* fallback also failed - dataUrl stays undefined */ }
      }

      if (dataUrl === undefined) {
        if (overlayHidden) chrome.tabs.sendMessage(req.tabId, { type: 'TT_SHOW_OVERLAY' }).catch(() => {});
        await recordFailed(req, reqEv.id, seq + 1, 'capture_failed', firstError);
        return { ok: false, requestedEventId: reqEv.id, reason: 'capture_failed', detail: firstError };
      }

      if (overlayHidden) {
        chrome.tabs.sendMessage(req.tabId, { type: 'TT_SHOW_OVERLAY' }).catch(() => {});
      }

      const rendered = await decodeCaptureDataUrl(dataUrl);

      const blobKey = newBlobKey();
      await putBlob({ key: blobKey, data: rendered.bytes, mimeType: 'image/jpeg', storedAt: Date.now(), sessionId: req.sessionId });

      if (didScroll && originalScrollY !== undefined) {
        chrome.tabs.sendMessage(req.tabId, {
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
        tabId: req.tabId,
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
        tabId: req.tabId,
        trigger: req.trigger,
        stepId: req.stepId,
        stepFrame: req.stepFrame,
        evidenceEventId: storeEv.id,
        bytes: rendered.bytes.length,
      });
      emitCaptureDebug(req.tabId, {
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
  });
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
  captureLocks.delete(sessionId);
  const prefix = `${sessionId}|`;
  for (const key of recentCaptureFingerprints.keys()) {
    if (key.startsWith(prefix)) {
      recentCaptureFingerprints.delete(key);
    }
  }
}
