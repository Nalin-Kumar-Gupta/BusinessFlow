// MV3 service worker entry point.
// ALL chrome event listeners MUST be registered synchronously at top level.
// The SW is re-evaluated top-to-bottom on every restart.

import {
  getActiveSessionId, getScopeOrigins, isPaused,
  getSessionTabs, addSessionTab, removeSessionTab, clearSessionTabs,
  updateSessionTabOrigin, isSessionTab,
  addScopeOrigin,
  addPendingOrigin, removePendingOrigin, clearPendingOrigins,
  getSessionStartedAt, setSessionStartedAt,
  getPendingOrigins, nextSeq, clearAllState,
} from '../storage/session-state.js';
import { createChromeAuthEntitlementManager } from './auth-entitlement.js';
import type { NetworkPayload, Session, Step } from '../core/types.js';
import { startSession, stopSession, pauseSession, resumeSession, nextStepIndex } from './session.js';

import { requestCapture, requestCaptureWithResult, clearSessionCounts } from './screenshot.js';
import { attachNetListeners, detachNetListeners } from './net-observer.js';
import { attachNavListeners, detachNavListeners } from './nav-observer.js';
import { handleContentEvent, updateStepNote, cleanupTabState } from './content-events.js';
import {
  handleSessionStartFromPage as handleSessionStartFromPageImpl,
  handlePermitOrigin as handlePermitOriginImpl,
} from './session-flow.js';
import { injectIntoMatchingTabs, injectIntoTab, deactivateInAllTabs, requestOptionalPermission, hasCaptureAccessForOrigins } from './inject.js';

import { redactUrl, urlMatchesScope } from '../core/url.js';
import { newStepId, newEventId } from '../core/ids.js';
import { createLifecycleLock } from './lifecycle-lock.js';
import { putStep, getStepsForSession } from '../storage/db.js';
import { summarizeRecordingIntegrity, hasEvidenceIntegrityRisk } from '../core/reliability.js';
import { runDeferredStepCleanup } from './deferred-cleanup.js';

// ─── Synchronous top-level listener registration ──────────────────────────────
// NOTHING above this line that could fail/throw.

chrome.runtime.onInstalled.addListener(handleInstalled);
chrome.runtime.onStartup.addListener(handleStartup);
chrome.runtime.onMessage.addListener(handleMessage);
chrome.commands.onCommand.addListener(handleCommand);
chrome.tabs.onUpdated.addListener(handleTabUpdated);
chrome.tabs.onCreated.addListener(handleTabCreated);    // multi-tab: detect new tabs opened during session
chrome.tabs.onRemoved.addListener(handleTabRemoved);    // multi-tab: clean up closed tabs
chrome.tabs.onActivated.addListener(handleTabActivated); // capture when user switches TO a session tab

const BROAD_HOST_PATTERNS = ['<all_urls>'];

// Tabs that loaded in background; capture when user activates.
const pendingCaptureTabs = new Set<number>();
const withLifecycleLock = createLifecycleLock();
const authEntitlementManager = createChromeAuthEntitlementManager();

// Re-attach net/nav listeners only if a session was active when SW was last alive.
// Doing this async avoids the "You need to request host permissions" warning that
// fires when listeners are attached unconditionally with <all_urls> but no
// host_permissions are currently granted.
void (async () => {
  try {
    const sessionId = await getActiveSessionId();
    if (!sessionId) return;

    const { getSession, appendEvent } = await import('../storage/db.js');
    const session = await getSession(sessionId);
    if (!session || session.recordingState === 'stopped') {
      await clearAllState();
      detachNetListeners();
      detachNavListeners();
      await syncActionBadge();
      return;
    }

    attachNetListeners();
    attachNavListeners();

    // Mark restart gaps, but throttle to avoid noisy checkpoints on rapid wake/sleep cycles.
    const K_RECOVERY_MARK = 'tt:lastRecoveryCheckpoint';
    const now = Date.now();
    const markerRaw = await chrome.storage.local.get(K_RECOVERY_MARK).catch(() => ({}));
    const markerValue = isRec(markerRaw) ? markerRaw[K_RECOVERY_MARK] : undefined;
    const marker = isRec(markerValue) ? markerValue as { sessionId?: string; ts?: number } : undefined;
    const alreadyMarkedRecently = marker?.sessionId === sessionId
      && typeof marker.ts === 'number'
      && (now - marker.ts) < 30_000;

    if (!alreadyMarkedRecently) {
      await appendEvent({
        id: newEventId(),
        sessionId,
        ts: now,
        seq: await nextSeq(),
        kind: 'checkpoint',
        tabId: -1,
        confidence: 'observed',
        name: 'service_worker_restart',
        source: 'failure',
        note: 'Background worker restarted while session was active. Some in-flight captures may be missing.',
      });
      await chrome.storage.local.set({ [K_RECOVERY_MARK]: { sessionId, ts: now } });
    }

    await syncActionBadge();
    await authEntitlementManager.bootstrapOnStartup();
  } catch (error) {
    console.warn('[TestTrace] startup recovery skipped', error);
  }
})();

// ─── Action badge state ───────────────────────────────────────────────────────

async function syncActionBadge(): Promise<void> {
  const sessionId = await getActiveSessionId();
  if (!sessionId) {
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
    return;
  }

  const pending = await getPendingOrigins();
  if (pending.length > 0) {
    chrome.action.setBadgeText({ text: '!' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#e67e22' }).catch(() => {});
    return;
  }

  const paused = await isPaused();
  chrome.action.setBadgeText({ text: paused ? '⏸' : '●' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#e94560' }).catch(() => {});
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

function handleInstalled(details: chrome.runtime.InstalledDetails): void {
  console.info('[TestTrace] installed reason=%s', details.reason);
  // Make the toolbar icon open the side panel directly (no popup).
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => {
    console.warn('[TestTrace] sidePanel.setPanelBehavior failed', e);
  });

  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('ui/dashboard/dashboard.html') }).catch(() => {});
  }
}

function handleStartup(): void {
  console.info('[TestTrace] SW restart');
  // Re-assert the behavior on every SW cold start — cheap and idempotent.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  // Re-inject content scripts into any already-open tabs in scope
  void getScopeOrigins().then((origins) => {
    if (origins.length) void injectIntoMatchingTabs(origins);
  });
}

function handleMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r?: unknown) => void,
): boolean | undefined {
  if (sender.id && sender.id !== chrome.runtime.id) return;
  if (!isRec(message)) return;
  const type = message['type'];
  if (typeof type !== 'string') return;

  switch (type) {
    case 'TT_PING':
      sendResponse({ type: 'TT_PONG', ts: Date.now() });
      return undefined;

    case 'TT_GET_STATUS':
      void handleGetStatus(sendResponse);
      return true;

    case 'TT_AUTH_GET_STATUS':
      void handleAuthGetStatus(message as Record<string, unknown>, sendResponse);
      return true;

    case 'TT_AUTH_SIGN_IN':
      void handleAuthSignIn(message as Record<string, unknown>, sendResponse);
      return true;

    case 'TT_AUTH_SIGN_UP':
      void handleAuthSignUp(message as Record<string, unknown>, sendResponse);
      return true;

    case 'TT_AUTH_FORGOT_PASSWORD':
      void handleAuthForgotPassword(message as Record<string, unknown>, sendResponse);
      return true;

    case 'TT_AUTH_SIGN_OUT':
      void handleAuthSignOut(sendResponse);
      return true;

    case 'TT_AUTH_REFRESH':
      void handleAuthRefresh(sendResponse);
      return true;

    case 'TT_AUTH_SET_BACKEND_URL':
      void handleAuthSetBackendUrl(message as Record<string, unknown>, sendResponse);
      return true;

    case 'TT_BILLING_GET_CATALOG':
      void handleBillingGetCatalog(sendResponse);
      return true;

    case 'TT_BILLING_CREATE_CHECKOUT':
      void handleBillingCreateCheckout(message as Record<string, unknown>, sendResponse);
      return true;

    case 'TT_BILLING_CREATE_PORTAL':
      void handleBillingCreatePortal(sendResponse);
      return true;

    case 'TT_GET_FEATURES':
      void handleGetFeatures(sendResponse);
      return true;

    case 'TT_GET_FEATURE_SUMMARIES':
      void handleGetFeatureSummaries(sendResponse);
      return true;

    case 'TT_CREATE_FEATURE':
      void handleCreateFeature(message as Record<string, unknown>, sendResponse);
      return true;

    case 'TT_GET_FEATURE_NETWORK_STATS':
      void handleGetFeatureNetworkStats(message as Record<string, unknown>, sendResponse);
      return true;

    case 'TT_GET_TEST_CASES':
      void handleGetTestCases(message as Record<string, unknown>, sendResponse);
      return true;

    case 'TT_GET_SESSIONS_BY_FEATURE':
      void handleGetSessionsByFeature(message as Record<string, unknown>, sendResponse);
      return true;

    case 'TT_DELETE_FEATURE':
      void handleDeleteFeature(message as Record<string, unknown>, sendResponse);
      return true;

    case 'TT_RENAME_FEATURE':
      void handleRenameFeature(message as Record<string, unknown>, sendResponse);
      return true;

    case 'TT_RENAME_TEST_CASE':
      void handleRenameTestCase(message as Record<string, unknown>, sendResponse);
      return true;

    case 'TT_MOVE_TEST_CASE':
      void handleMoveTestCase(message as Record<string, unknown>, sendResponse);
      return true;

    case 'TT_DELETE_SESSION':
      void handleDeleteSession(message as Record<string, unknown>, sendResponse);
      return true;

    case 'TT_GET_SESSION_STEPS':
      void handleGetSessionSteps(message as Record<string, unknown>, sendResponse);
      return true;

    case 'TT_GET_NETWORK_LOGS':
      void handleGetNetworkLogs(message as Record<string, unknown>, sendResponse);
      return true;

    case 'TT_UPDATE_SESSION':
      void handleUpdateSession(message as Record<string, unknown>, sendResponse);
      return true;

    case 'TT_UPDATE_STEP':
      void handleUpdateStep(message as Record<string, unknown>, sendResponse);
      return true;

    case 'TT_SESSION_START':
      void withLifecycleLock(() => handleSessionStart(message as Record<string, unknown>, sendResponse));
      return true;

    case 'TT_SESSION_STOP':
      void withLifecycleLock(() => handleSessionStop(sendResponse));
      return true;

    case 'TT_PAUSE':
      void withLifecycleLock(() => handlePause(sendResponse));
      return true;

    case 'TT_RESUME':
      void withLifecycleLock(() => handleResume(sendResponse));
      return true;

    case 'TT_CAPTURE_EVIDENCE':
      void handleCaptureEvidence(message as Record<string, unknown>, sender, sendResponse);
      return true;

    // Content script finished activating and is ready for a screenshot.
    // This is more reliable than a setTimeout in the SW (SW can be killed in those ms).
    // The message delivery itself wakes the SW, so capture runs in the same invocation.
    case 'TT_CONTENT_READY':
      void handleContentReady(sender);
      return undefined;

    // Events from content scripts
    case 'TT_CONTENT_EVENT':
      void handleContentEvent(message as Record<string, unknown>, sender);
      return undefined;

    case 'TT_NETWORK_LOG':
      void handleNetworkLog(message as Record<string, unknown>, sender);
      return undefined;

    case 'TT_UPDATE_STEP_NOTE':
      void handleUpdateStepNote(message as Record<string, unknown>, sendResponse);
      return true;

    // Session started from the in-page floating panel (guided mode, origin already registered)
    case 'TT_SESSION_START_FROM_PAGE':
      void withLifecycleLock(() => handleSessionStartFromPage(message as Record<string, unknown>, sender, sendResponse));
      return true;

    // Popup queries pending unrecognized origins found during an active session
    case 'TT_GET_PENDING_ORIGINS':
      void (async () => {
        sendResponse({ origins: await getPendingOrigins() });
      })();
      return true;

    // Popup has granted permission for a pending origin → activate it
    case 'TT_PERMIT_ORIGIN':
      void handlePermitOrigin(message as Record<string, unknown>);
      return undefined;

    // Content script bootstrap: "is there an active session for my origin?"
    // Fires on every page load so the panel self-heals after refresh/navigation.
    case 'TT_QUERY_SESSION':
      void handleQuerySession(message as Record<string, unknown>, sender, sendResponse);
      return true;

    default:
      return undefined;
  }
}

function handleCommand(command: string): void {
  void (async () => {
    const sessionId = await getActiveSessionId();
    if (!sessionId) return;

    if (command === 'capture-evidence') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      void requestCapture({ sessionId, tabId: tab.id, trigger: 'manual', priority: 'high' });
    }
    if (command === 'toggle-pause') {
      const paused = await isPaused();
      if (paused) {
        await resumeSession(sessionId, -1);
        notifyIndicator('TT_CONTENT_RESUME');
      } else {
        await pauseSession(sessionId, -1);
        notifyIndicator('TT_CONTENT_PAUSE');
      }
    }
  })();
}

async function handleTabUpdated(
  tabId: number,
  changeInfo: chrome.tabs.ChangeInfo,
): Promise<void> {
  if (changeInfo.status !== 'complete') return;

  let tab: chrome.tabs.Tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  const url = tab.url ?? '';
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) return;

  const { extractOrigin, originToPattern } = await import('../core/url.js');
  const origin = extractOrigin(url);
  if (!origin) return;

  const sessionId = await getActiveSessionId();

  if (sessionId) {
    // ── Determine if this tab is in session scope ──────────────────────────
    const knownTab = await isSessionTab(tabId);
    // Catch child tabs we might have missed if SW restarted between onCreated and onUpdated
    const openerIsSession = !knownTab && tab.openerTabId
      ? await isSessionTab(tab.openerTabId)
      : false;

    if (knownTab || openerIsSession) {
      // ── This tab is in scope ───────────────────────────────────────────────
      if (openerIsSession && !knownTab) {
        await addSessionTab({ tabId, windowId: tab.windowId, origin, openerTabId: tab.openerTabId, addedAt: Date.now() });
      } else {
        await updateSessionTabOrigin(tabId, origin, tab.windowId);
      }

      const pattern = originToPattern(origin);
      const hasBroadAccess = await new Promise<boolean>((res) =>
        chrome.permissions.contains({ origins: BROAD_HOST_PATTERNS }, res),
      );
      const hasPerm = hasBroadAccess || (pattern ? await new Promise<boolean>((res) =>
        chrome.permissions.contains({ origins: [pattern] }, res),
      ) : false);

      if (hasPerm) {
        // ── Full capture: inject content script, DOM observation ─────────────
        await addScopeOrigin(origin);
        // Clear any stale pendingOrigin (e.g., OAuth page that has now redirected)
        await removePendingOrigin(origin);
        await syncActionBadge();

        const sessionStartedAt = await getSessionStartedAt();
        await injectIntoTab(tabId).catch(() => {});
        await new Promise<void>((r) => setTimeout(r, 150));
        const sendActivate = () =>
          chrome.tabs.sendMessage(tabId, { type: 'TT_CONTENT_ACTIVATE', sessionId, sessionStartedAt }).catch(() => {});
        sendActivate();
        setTimeout(sendActivate, 400);
        // TT_CONTENT_READY (from content script) and handleTabActivated both drive capture
        pendingCaptureTabs.add(tabId);

      } else {
        // ── No permission for this origin (OAuth, SSO, redirect intermediary) ──
        // Keep cross-tab continuity by tracking the origin and surfacing an
        // in-session permission prompt path in popup/panel.
        await addPendingOrigin({
          origin,
          tabId,
          openerTabId: tab.openerTabId ?? -1,
          discoveredAt: Date.now(),
        });
        await syncActionBadge();

        await broadcastToSession({ type: 'TT_NEW_ORIGIN_DISCOVERED', origin });

        if (tab.active) {
          // Tab is visible right now — capture after a short settle
          setTimeout(() => {
            void requestCapture({ sessionId, tabId, trigger: 'session_start', priority: 'normal' });
          }, 600);
        } else {
          // Tab is in background — capture when user switches to it
          pendingCaptureTabs.add(tabId);
        }
      }
      return;
    }
    // Tab is not in session scope — fall through to "no active session" logic
  }

  // ── No active session (or not a session tab): show "Ready to test" ─────────
  const pattern = originToPattern(origin);
  const hasBroadAccess = await new Promise<boolean>((res) =>
    chrome.permissions.contains({ origins: BROAD_HOST_PATTERNS }, res),
  );
  const hasPerm = hasBroadAccess || (pattern ? await new Promise<boolean>((res) =>
    chrome.permissions.contains({ origins: [pattern] }, res),
  ) : false);
  if (!hasPerm) return;

  await injectIntoTab(tabId).catch(() => {});
  await new Promise<void>((r) => setTimeout(r, 150));
  const sendReady = () =>
    chrome.tabs.sendMessage(tabId, { type: 'TT_CONTENT_SHOW_READY', origin }).catch(() => {});
  sendReady();
  setTimeout(sendReady, 400);
}

// Content script ready ping: capture from the same SW wake cycle.
async function handleContentReady(sender: chrome.runtime.MessageSender): Promise<void> {
  const sessionId = await getActiveSessionId();
  if (!sessionId) return;

  const tabId = sender.tab?.id;
  if (!tabId) return;

  // Self-heal: after SW restart + page reload, TT_CONTENT_READY can arrive
  // before this tab is rehydrated into the session roster.
  let inSession = await isSessionTab(tabId);
  if (!inSession) {
    const tab = sender.tab;
    const url = tab?.url ?? '';
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const { extractOrigin } = await import('../core/url.js');
      const origin = extractOrigin(url);
      const scopeOrigins = await getScopeOrigins();
      if (origin && scopeOrigins.includes(origin) && tab) {
        await addSessionTab({
          tabId,
          windowId: tab.windowId ?? 0,
          origin,
          addedAt: Date.now(),
        });
        inSession = true;
      }
    }
  }

  if (!inSession) return;

  // Remove from pending set if it was queued there
  pendingCaptureTabs.delete(tabId);

  const firstAttempt = await requestCaptureWithResult({
    sessionId,
    tabId,
    trigger: 'session_start',
    priority: 'high',
  });

  if (firstAttempt.ok) return;

  // Reload/connect races can briefly leave the tab "not active" or still
  // repainting. Retry once after a short settle window.
  if (firstAttempt.reason === 'tab_not_active' || firstAttempt.reason === 'capture_failed') {
    setTimeout(() => {
      void requestCapture({ sessionId, tabId, trigger: 'session_start', priority: 'high' });
    }, 700);
  }
}

// Query session on each page load so panel survives refresh/navigation.
async function handleQuerySession(
  msg: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  const { extractOrigin, originToPattern } = await import('../core/url.js');
  const tabId   = sender.tab?.id;
  const rawUrl  = msg['origin'] as string | undefined ?? sender.tab?.url ?? '';
  const origin  = rawUrl.startsWith('http') ? extractOrigin(rawUrl) : rawUrl;
  if (!origin) { sendResponse(null); return; }

  const sessionId = await getActiveSessionId();

  if (sessionId) {
    const tabInSession   = tabId ? await isSessionTab(tabId) : false;
    const scopeOrigins   = await getScopeOrigins();
    const originInScope  = scopeOrigins.includes(origin);

    if (tabInSession || originInScope) {
      // Auto-register the tab if SW restarted and lost the in-memory roster entry
      if (tabId && !tabInSession && sender.tab) {
        await addSessionTab({
          tabId,
          windowId: sender.tab.windowId ?? 0,
          origin,
          addedAt: Date.now(),
        });
      }
      const sessionStartedAt = await getSessionStartedAt();
      sendResponse({ sessionId, sessionStartedAt });
      return;
    }
  }

  // No active session — check if origin is registered (show "ready to test")
  const pattern = originToPattern(origin);
  const hasBroadAccess = await new Promise<boolean>((res) =>
    chrome.permissions.contains({ origins: BROAD_HOST_PATTERNS }, res),
  );
  const hasPerm = hasBroadAccess || (pattern ? await new Promise<boolean>((res) =>
    chrome.permissions.contains({ origins: [pattern] }, res),
  ) : false);
  sendResponse(hasPerm ? { showReady: true } : null);
}

// captureVisibleTab only works for the visible tab.
async function handleTabActivated({ tabId }: chrome.tabs.TabActiveInfo): Promise<void> {
  const sessionId = await getActiveSessionId();
  if (!sessionId) return;
  if (!await isSessionTab(tabId)) return;

  // Always attempt a capture — throttle (MIN_INTERVAL_NORMAL_MS = 2000ms)
  // silently drops duplicates if TT_CONTENT_READY already fired within 2s.
  pendingCaptureTabs.delete(tabId);
  setTimeout(() => {
    void requestCapture({ sessionId, tabId, trigger: 'dom_change', priority: 'normal' });
  }, 300);
}

// ── Multi-tab: handle newly created tab ───────────────────────────────────────
// Fires as soon as the browser creates the tab, before navigation completes.
// We pre-register it so handleTabUpdated (fired on load-complete) can find it.
async function handleTabCreated(tab: chrome.tabs.Tab): Promise<void> {
  const sessionId = await getActiveSessionId();
  if (!sessionId || !tab.id || !tab.openerTabId) return;

  // Only auto-associate if the opener belongs to the current session
  if (!await isSessionTab(tab.openerTabId)) return;

  // Pre-register with empty origin; handleTabUpdated fills in the real origin
  await addSessionTab({
    tabId: tab.id,
    windowId: tab.windowId,
    origin: '',          // not known yet
    openerTabId: tab.openerTabId,
    addedAt: Date.now(),
  });
}

// ── Multi-tab: handle tab closed ─────────────────────────────────────────────
async function handleTabRemoved(tabId: number): Promise<void> {
  await removeSessionTab(tabId);
  pendingCaptureTabs.delete(tabId); // clean up if it was queued
  cleanupTabState(tabId);           // clean up nav-aware per-tab state
  // Leave the session running even if this tab closes — tester may have others
}

// ── Helper: inject content script + send ACTIVATE ────────────────────────────
// Includes sessionStartedAt so every tab's timer shows the same running duration.
async function activateTab(tabId: number, sessionId: string): Promise<void> {
  const sessionStartedAt = await getSessionStartedAt();
  await injectIntoTab(tabId).catch(() => {});
  await new Promise<void>((r) => setTimeout(r, 150));
  const send = () =>
    chrome.tabs.sendMessage(tabId, { type: 'TT_CONTENT_ACTIVATE', sessionId, sessionStartedAt }).catch(() => {});
  send();
  setTimeout(send, 400);
}

// ── Helper: send a message to all session tabs ────────────────────────────────
async function broadcastToSession(msg: Record<string, unknown>): Promise<void> {
  const tabs = await getSessionTabs();
  for (const [tid] of tabs) {
    chrome.tabs.sendMessage(tid, msg).catch(() => {});
  }
}

// ─── Message handlers ─────────────────────────────────────────────────────────

async function handleGetStatus(sendResponse: (r?: unknown) => void): Promise<void> {
  const sessionId = await getActiveSessionId();
  const paused = sessionId ? await isPaused() : false;
  const sessionStartedAt = sessionId ? await getSessionStartedAt() : 0;
  let testResult = 'in_progress';
  if (sessionId) {
    const { getSession } = await import('../storage/db.js');
    const session = await getSession(sessionId);
    if (session) testResult = session.testResult;
  }
  sendResponse({ type: 'TT_STATUS', sessionId, paused, testResult, sessionStartedAt });
}

async function handleAuthGetStatus(
  msg: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  try {
    const refreshIfNeeded = msg['refreshIfNeeded'] !== false;
    const status = await authEntitlementManager.getStatus(refreshIfNeeded);
    sendResponse({ ok: true, status });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleAuthSignIn(
  msg: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  try {
    const email = typeof msg['email'] === 'string' ? msg['email'] : '';
    const password = typeof msg['password'] === 'string' ? msg['password'] : '';
    const status = await authEntitlementManager.signIn(email, password);
    sendResponse({ ok: true, status });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleAuthSignUp(
  msg: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  try {
    const email = typeof msg['email'] === 'string' ? msg['email'] : '';
    const password = typeof msg['password'] === 'string' ? msg['password'] : '';
    const status = await authEntitlementManager.signUp(email, password);
    sendResponse({ ok: true, status });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleAuthForgotPassword(
  msg: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  try {
    const email = typeof msg['email'] === 'string' ? msg['email'] : '';
    const result = await authEntitlementManager.requestPasswordReset(email);
    sendResponse({ ok: true, data: result });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleAuthSignOut(sendResponse: (r?: unknown) => void): Promise<void> {
  try {
    const status = await authEntitlementManager.signOut();
    sendResponse({ ok: true, status });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleAuthRefresh(sendResponse: (r?: unknown) => void): Promise<void> {
  try {
    const status = await authEntitlementManager.refreshEntitlement(true);
    sendResponse({ ok: true, status });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleAuthSetBackendUrl(
  msg: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  try {
    const backendBaseUrl = typeof msg['backendBaseUrl'] === 'string' ? msg['backendBaseUrl'] : '';
    const status = await authEntitlementManager.setBackendBaseUrl(backendBaseUrl);
    sendResponse({ ok: true, status });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleBillingGetCatalog(sendResponse: (r?: unknown) => void): Promise<void> {
  try {
    const catalog = await authEntitlementManager.getBillingCatalog();
    sendResponse({ ok: true, catalog });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleBillingCreateCheckout(
  msg: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  try {
    const planKey = typeof msg['planKey'] === 'string' ? msg['planKey'] : '';
    const checkout = await authEntitlementManager.createCheckout(planKey);
    sendResponse({ ok: true, checkout });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleBillingCreatePortal(sendResponse: (r?: unknown) => void): Promise<void> {
  try {
    const portal = await authEntitlementManager.createCustomerPortal();
    sendResponse({ ok: true, portal });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleGetFeatures(sendResponse: (r?: unknown) => void): Promise<void> {
  const { getDistinctFeatureNames } = await import('../storage/db.js');
  const features = await getDistinctFeatureNames();
  sendResponse(features);
}

async function handleGetFeatureSummaries(sendResponse: (r?: unknown) => void): Promise<void> {
  const { getFeatureSummaries } = await import('../storage/db.js');
  const summaries = await getFeatureSummaries();
  sendResponse(summaries);
}

async function handleCreateFeature(
  msg: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  const featureName = typeof msg['featureName'] === 'string' ? msg['featureName'].trim() : '';
  if (!featureName) {
    sendResponse({ ok: false, error: 'Invalid featureName' });
    return;
  }

  const { createFeatureStub } = await import('../storage/db.js');
  const created = await createFeatureStub(featureName);
  sendResponse({ ok: true, created });
}

async function handleGetFeatureNetworkStats(
  msg: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  const featureName = typeof msg['featureName'] === 'string' ? msg['featureName'].trim() : '';
  if (!featureName) {
    sendResponse({
      totalRequests: 0,
      successCount: 0,
      warnCount: 0,
      errorCount: 0,
      fastRequests: 0,
      avgRequests: 0,
      slowRequests: 0,
      avgLatency: 0,
      topSlowest: [],
    });
    return;
  }

  const { getFeatureNetworkStats } = await import('../storage/db.js');
  const stats = await getFeatureNetworkStats(featureName);
  sendResponse(stats);
}

async function handleGetTestCases(
  msg: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  const featureName = typeof msg['featureName'] === 'string' ? msg['featureName'].trim() : '';
  if (!featureName) {
    sendResponse([]);
    return;
  }
  const { getDistinctTestCases } = await import('../storage/db.js');
  const testCases = await getDistinctTestCases(featureName);
  sendResponse(testCases);
}

async function handleGetSessionsByFeature(
  msg: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  const featureName = typeof msg['featureName'] === 'string' ? msg['featureName'].trim() : '';
  if (!featureName) {
    sendResponse([]);
    return;
  }
  const { getAllSessions } = await import('../storage/db.js');
  const sessions = await getAllSessions();
  const filtered = sessions
    .filter((session) => (session.featureName ?? '').trim() === featureName)
    .sort((a, b) => b.startedAt - a.startedAt);
  sendResponse(filtered);
}

async function handleDeleteFeature(
  msg: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  const featureName = typeof msg['featureName'] === 'string' ? msg['featureName'].trim() : '';
  if (!featureName) {
    sendResponse({ ok: false, error: 'Invalid featureName' });
    return;
  }

  const { deleteFeature } = await import('../storage/db.js');
  const deletedSessions = await deleteFeature(featureName);
  sendResponse({ ok: true, deletedSessions });
}

async function handleRenameFeature(
  msg: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  const oldName = typeof msg['oldName'] === 'string' ? msg['oldName'].trim() : '';
  const newName = typeof msg['newName'] === 'string' ? msg['newName'].trim() : '';
  if (!oldName || !newName) {
    sendResponse({ ok: false, error: 'Invalid payload' });
    return;
  }

  const { renameFeature } = await import('../storage/db.js');
  const updatedSessions = await renameFeature(oldName, newName);
  sendResponse({ ok: true, updatedSessions });
}

async function handleRenameTestCase(
  msg: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  const featureName = typeof msg['featureName'] === 'string' ? msg['featureName'].trim() : '';
  const oldTestCaseName = typeof msg['oldTestCaseName'] === 'string' ? msg['oldTestCaseName'].trim() : '';
  const newTestCaseName = typeof msg['newTestCaseName'] === 'string' ? msg['newTestCaseName'].trim() : '';
  if (!featureName || !oldTestCaseName || !newTestCaseName) {
    sendResponse({ ok: false, error: 'Invalid payload' });
    return;
  }

  const { renameTestCase } = await import('../storage/db.js');
  const updatedSessions = await renameTestCase(featureName, oldTestCaseName, newTestCaseName);
  sendResponse({ ok: true, updatedSessions });
}

async function handleDeleteSession(
  msg: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  const sessionId = typeof msg['sessionId'] === 'string' ? msg['sessionId'] : '';
  if (!sessionId) {
    sendResponse({ ok: false, error: 'Invalid sessionId' });
    return;
  }

  const { deleteSession } = await import('../storage/db.js');
  await deleteSession(sessionId);
  sendResponse({ ok: true });
}

async function handleMoveTestCase(
  msg: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  const oldFeature = typeof msg['oldFeature'] === 'string' ? msg['oldFeature'].trim() : '';
  const newFeature = typeof msg['newFeature'] === 'string' ? msg['newFeature'].trim() : '';
  const testCaseName = typeof msg['testCaseName'] === 'string' ? msg['testCaseName'].trim() : '';
  if (!oldFeature || !newFeature || !testCaseName) {
    sendResponse({ ok: false, error: 'Invalid payload' });
    return;
  }

  const { getDistinctFeatureNames, moveTestCase } = await import('../storage/db.js');
  const existingFeatures = await getDistinctFeatureNames();
  const destinationExists = existingFeatures.some((feature) => feature.trim().toLowerCase() === newFeature.toLowerCase());
  if (!destinationExists) {
    sendResponse({ ok: false, error: 'Destination feature does not exist' });
    return;
  }

  const updatedSessions = await moveTestCase(oldFeature, newFeature, testCaseName);
  sendResponse({ ok: true, updatedSessions });
}

async function handleGetSessionSteps(
  msg: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  const sessionId = typeof msg['sessionId'] === 'string' ? msg['sessionId'] : '';
  if (!sessionId) {
    sendResponse([]);
    return;
  }
  const { getStepsForSession } = await import('../storage/db.js');
  const steps = await getStepsForSession(sessionId);
  sendResponse(steps);
}

async function handleGetNetworkLogs(
  msg: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  const sessionId = typeof msg['sessionId'] === 'string' ? msg['sessionId'] : '';
  if (!sessionId) {
    sendResponse([]);
    return;
  }
  const { getNetworkLogs } = await import('../storage/db.js');
  const logs = await getNetworkLogs(sessionId);
  sendResponse(logs);
}

async function handleUpdateSession(
  msg: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  const sessionId = typeof msg['sessionId'] === 'string' ? msg['sessionId'] : '';
  const updates = isRec(msg['updates']) ? (msg['updates'] as Record<string, unknown>) : null;
  if (!sessionId || !updates) {
    sendResponse({ ok: false, error: 'Invalid payload' });
    return;
  }

  const { updateSession } = await import('../storage/db.js');
  const updated = await updateSession(sessionId, updates);
  sendResponse({ ok: Boolean(updated), session: updated });
}

async function handleUpdateStep(
  msg: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  const stepId = typeof msg['stepId'] === 'string' ? msg['stepId'] : '';
  const updates = isRec(msg['updates']) ? (msg['updates'] as Record<string, unknown>) : null;
  if (!stepId || !updates) {
    sendResponse({ ok: false, error: 'Invalid payload' });
    return;
  }

  const { updateStep } = await import('../storage/db.js');
  const updated = await updateStep(stepId, updates);
  sendResponse({ ok: Boolean(updated), step: updated });
}

async function handleSessionStart(
  msg: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  const existing = await getActiveSessionId();
  if (existing) { sendResponse({ type: 'TT_SESSION_START_ERR', error: 'Session already active' }); return; }

  const origins = (msg['scopeOrigins'] as string[] | undefined) ?? [];
  if (!origins.length) { sendResponse({ type: 'TT_SESSION_START_ERR', error: 'No origins provided' }); return; }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = activeTab?.id ?? -1;

  // Permission is requested in the popup (user gesture required — can't do it here).
  // The popup sets permissionAlreadyGranted:true when it succeeds.
  // If somehow called without that flag, attempt it anyway (fallback).
  if (!msg['permissionAlreadyGranted']) {
    const granted = await requestOptionalPermission(origins).catch(() => false);
    if (!granted) { sendResponse({ type: 'TT_SESSION_START_ERR', error: 'Permission denied' }); return; }
  }

  const hasAllPerms = await hasCaptureAccessForOrigins(tabId, origins);
  if (!hasAllPerms) {
    console.error('[TestTrace] session_start permission verification failed', { origins, hasAllPerms, tabId });
    sendResponse({ type: 'TT_SESSION_START_ERR', error: 'Permission denied' });
    return;
  }

  // Attach webRequest/nav listeners now that host permissions are granted.
  attachNetListeners();
  attachNavListeners();

  const { getSettings } = await import('../storage/settings.js');
  const settings = await getSettings();
  const configuredSlaSec = Math.min(20, Math.max(1, Math.round(settings.slaSec ?? 3)));
  const effectiveSlaSec = settings.slaEnabled ? configuredSlaSec : 100;

  const session = await startSession({
    testCaseName: String(msg['testCaseName'] ?? 'Untitled'),
    featureName: typeof msg['featureName'] === 'string' ? msg['featureName'].trim() : undefined,
    testCaseId: msg['testCaseId'] as string | undefined,
    mode: (msg['mode'] as 'guided' | 'aware' | 'automatic') ?? 'guided',
    negativeTest: (msg['negativeTest'] as 'yes' | 'no' | 'unknown') ?? 'unknown',
    scopeOrigins: origins,
    tabId,
    apiSlaSec: typeof msg['apiSlaSec'] === 'number' ? msg['apiSlaSec'] : effectiveSlaSec,
    negativeExpectations: (msg['negativeExpectations'] as Session['negativeExpectations'] | undefined),
  });

  // Persist session start time so all tabs show the same running timer
  await setSessionStartedAt(session.startedAt);

  // Inject content scripts
  await injectIntoMatchingTabs(origins);

  // Notify content scripts to activate
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  for (const tab of tabs) {
    if (!tab.id) continue;
    chrome.tabs.sendMessage(tab.id, {
      type: 'TT_CONTENT_ACTIVATE',
      sessionId: session.id,
      sessionStartedAt: session.startedAt,
    }).catch(() => {});
    chrome.tabs.sendMessage(tab.id, { type: 'TT_SESSION_STARTED', sessionId: session.id }).catch(() => {});
  }

  // ── Register the starting tab in the session-tab roster ─────────────────
  if (tabId > 0) {
    try {
      const startTab = await chrome.tabs.get(tabId);
      await addSessionTab({
        tabId,
        windowId: startTab.windowId,
        origin: origins[0] ?? '',
        addedAt: Date.now(),
      });
    } catch { /* tab may already be gone */ }
  }

  // Baseline screenshot — delay 800ms so the popup has time to close and the
  // browser tab regains OS focus before captureVisibleTab is called.
  if (tabId > 0) {
    setTimeout(() => {
      void requestCapture({ sessionId: session.id, tabId, trigger: 'session_start', priority: 'high' });
    }, 800);
  }

  await syncActionBadge();

  // Ensure the side panel is enabled + points at the panel doc for the starting
  // tab, then best-effort open it. open() requires a user gesture; when this
  // handler is invoked from the panel's own Start button the gesture still
  // holds. When invoked from a non-gesture path we swallow the failure —
  // openPanelOnActionClick keeps the icon-click fallback working.
  if (tabId > 0) {
    chrome.sidePanel.setOptions({ tabId, path: 'ui/panel.html', enabled: true }).catch(() => {});
    chrome.sidePanel.open({ tabId }).catch(() => {});
  }

  sendResponse({ type: 'TT_SESSION_STARTED', session });
}

async function handleSessionStop(sendResponse: (r?: unknown) => void): Promise<void> {
  const sessionId = await getActiveSessionId();
  if (!sessionId) { sendResponse({ type: 'TT_SESSION_STOP_ERR', error: 'No active session' }); return; }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab?.id ?? -1;

  let finalCapture: Awaited<ReturnType<typeof requestCaptureWithResult>> | null = null;
  if (tabId > 0) {
    try {
      finalCapture = await requestCaptureWithResult({ sessionId, tabId, trigger: 'session_end', priority: 'high' });
    } catch (error) {
      finalCapture = {
        ok: false,
        reason: 'capture_failed',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const origins = await getScopeOrigins();
  await stopSession(sessionId, tabId);
  await deactivateInAllTabs(origins);

  const cleanupSummary = await runDeferredStepCleanup(sessionId);
  if (cleanupSummary.updatedSteps > 0) {
    console.log('[TestTrace] deferred-stop-cleanup complete', {
      sessionId,
      ...cleanupSummary,
    });
  }

  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  for (const t of tabs) {
    if (!t.id) continue;
    chrome.tabs.sendMessage(t.id, { type: 'TT_SESSION_STOPPED', sessionId }).catch(() => {});
  }

  clearSessionCounts(sessionId);

  // Clean up multi-tab tracking state
  await clearSessionTabs();
  await clearPendingOrigins();

  // Detach webRequest/nav listeners — no active session means no need to observe.
  detachNetListeners();
  detachNavListeners();

  const { getEventsForSession, getStepsForSession } = await import('../storage/db.js');
  const [events, steps] = await Promise.all([
    getEventsForSession(sessionId),
    getStepsForSession(sessionId),
  ]);

  const integrity = summarizeRecordingIntegrity(events, steps);
  const warnings: string[] = [];
  if (finalCapture && !finalCapture.ok) {
    warnings.push(`Final screenshot failed (${finalCapture.reason ?? 'capture_failed'}).`);
  }
  if (hasEvidenceIntegrityRisk(integrity)) {
    warnings.push('One or more evidence captures failed or are incomplete. Review step cards before sharing this run.');
  }

  await syncActionBadge();

  sendResponse({
    type: 'TT_SESSION_STOPPED',
    sessionId,
    integrity,
    cleanupSummary,
    warnings,
    ...(finalCapture ? { finalCapture } : {}),
  });
}

async function handlePause(sendResponse: (r?: unknown) => void): Promise<void> {
  const sessionId = await getActiveSessionId();
  if (!sessionId) { sendResponse({ ok: false }); return; }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await pauseSession(sessionId, tab?.id ?? -1);
  notifyIndicator('TT_CONTENT_PAUSE');
  await syncActionBadge();
  sendResponse({ ok: true });
}

async function handleResume(sendResponse: (r?: unknown) => void): Promise<void> {
  const sessionId = await getActiveSessionId();
  if (!sessionId) { sendResponse({ ok: false }); return; }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await resumeSession(sessionId, tab?.id ?? -1);
  notifyIndicator('TT_CONTENT_RESUME');
  await syncActionBadge();
  sendResponse({ ok: true });
}

async function handleCaptureEvidence(
  msg: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  const sessionId = await getActiveSessionId();
  if (!sessionId) { sendResponse({ ok: false }); return; }
  // Content scripts provide sender.tab. Extension pages (side panel/popup)
  // don't, so we also accept an explicit tabId from the caller.
  const fromSender = sender.tab?.id;
  const fromMessage = typeof msg['tabId'] === 'number' ? msg['tabId'] : -1;
  const tabId = typeof fromSender === 'number' ? fromSender : fromMessage;
  if (tabId < 0) { sendResponse({ ok: false }); return; }
  const startedAt = Date.now();

  const isContentOrigin = Boolean(sender.tab?.id);
  if (isContentOrigin) {
    const steps = await getStepsForSession(sessionId);
    const latestStep = [...steps]
      .sort((a, b) => b.index - a.index)
      .find((s) => s.tabId === tabId && Boolean(s.beforeEvidenceEventId) && !s.afterEvidenceEventId);

    if (latestStep) {
      const attached = await requestCaptureWithResult({
        sessionId,
        tabId,
        trigger: 'manual',
        note: msg['note'] as string | undefined,
        priority: 'high',
        stepId: latestStep.id,
        stepFrame: 'after',
        pageUrl: sender.tab?.url,
      });

      if (attached.ok) {
        sendResponse({ ok: true, stepId: latestStep.id, evidenceEventId: attached.evidenceEventId, attachedToExistingStep: true });
        return;
      }
    }
  }

  const index = await nextStepIndex(sessionId);
  const step: Step = {
    id: newStepId(),
    sessionId,
    tabId,
    index,
    ts: startedAt,
    seq: await nextSeq(),
    label: 'Manual capture',
    semanticLabel: 'Manual capture',
    pageUrl: sender.tab?.url,
    clickEventIds: [],
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

  let captureResult = await requestCaptureWithResult({
    sessionId,
    tabId,
    trigger: 'manual',
    note: msg['note'] as string | undefined,
    priority: 'high',
    stepId: step.id,
    stepFrame: 'before',
    pageUrl: sender.tab?.url,
  });

  if (!captureResult.ok && (captureResult.reason === 'tab_not_active' || captureResult.reason === 'capture_failed')) {
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    captureResult = await requestCaptureWithResult({
      sessionId,
      tabId,
      trigger: 'manual',
      note: msg['note'] as string | undefined,
      priority: 'high',
      stepId: step.id,
      stepFrame: 'before',
      pageUrl: sender.tab?.url,
    });
  }

  if (!captureResult.ok) {
    sendResponse({
      ok: false,
      stepId: step.id,
      reason: captureResult.reason ?? 'capture_failed',
      detail: captureResult.detail,
    });
    return;
  }

  sendResponse({ ok: true, stepId: step.id, evidenceEventId: captureResult.evidenceEventId });
}

async function handleUpdateStepNote(
  msg: Record<string, unknown>,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  const stepId = typeof msg['stepId'] === 'string' ? msg['stepId'] : '';
  const noteText = typeof msg['noteText'] === 'string' ? msg['noteText'] : '';
  if (!stepId) { sendResponse({ ok: false, error: 'Missing stepId' }); return; }
  const res = await updateStepNote(stepId, noteText);
  sendResponse(res);
}


// ─── Session start from in-page panel ────────────────────────────────────────
// The content script's floating panel sends this when the tester clicks "Start".
// Identical flow to handleSessionStart except the tab is already known from sender.

async function handleSessionStartFromPage(
  msg: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r?: unknown) => void,
): Promise<void> {
  await handleSessionStartFromPageImpl(msg, sender, sendResponse, { syncActionBadge });
}

// ─── Permit a new origin discovered mid-session ───────────────────────────────
// Called after the popup's chrome.permissions.request() succeeds.
// Injects the content script and activates recording in the waiting tab.

async function handlePermitOrigin(msg: Record<string, unknown>): Promise<void> {
  await handlePermitOriginImpl(msg, {
    pendingCaptureTabs,
    activateTab,
    syncActionBadge,
  });
}

const REDACTED_VALUE = '[REDACTED]';
const SENSITIVE_KEY_REGEX = /(password|token|secret|authorization|credit_?card)/i;

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_REGEX.test(k) ? REDACTED_VALUE : redactValue(v);
    }
    return out;
  }
  return value;
}

function redactSensitiveBody(body: string | undefined): string | undefined {
  if (!body) return body;
  const trimmed = body.trim();
  if (!trimmed) return body;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return JSON.stringify(redactValue(parsed)).slice(0, 5_000);
  } catch {
    // Fallback for form/query-like payloads
    return body.replace(
      /((?:password|token|secret|authorization|credit_?card)[^=:\n\r]{0,32}[=:]\s*)([^&\n\r,\s]+)/gi,
      `$1${REDACTED_VALUE}`,
    ).slice(0, 5_000);
  }
}

async function shouldStoreNetworkBodies(status: number): Promise<boolean> {
  const isFailure = status === 0 || status >= 400;
  if (!isFailure) return false;
  const { getSettings } = await import('../storage/settings.js');
  const settings = await getSettings().catch(() => null);
  return Boolean(settings?.captureNetworkErrorBodies);
}

function handleNetworkLog(msg: Record<string, unknown>, sender: chrome.runtime.MessageSender): void {
  const payload = msg['payload'];
  if (!isNetworkPayload(payload)) return;
  void (async () => {
    const sessionId = await getActiveSessionId();
    if (!sessionId) return;
    if (await isPaused()) return;

    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number' || tabId < 0) return;
    if (!await isSessionTab(tabId)) return;

    const scopeOrigins = await getScopeOrigins();
    if (!urlMatchesScope(payload.url, scopeOrigins)) return;

    const allowBodies = await shouldStoreNetworkBodies(payload.status);
    const requestBody = allowBodies ? redactSensitiveBody(payload.requestBody) : undefined;
    const responseBody = allowBodies ? redactSensitiveBody(payload.responseBody) : undefined;

    const { addNetworkLog } = await import('../storage/db.js');
    await addNetworkLog({
      id: crypto.randomUUID(),
      sessionId,
      url: redactUrl(payload.url),
      method: payload.method,
      status: payload.status,
      requestBody,
      responseBody,
      timestamp: payload.timestamp,
      durationMs: payload.durationMs,
    });
  })();
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNetworkPayload(v: unknown): v is NetworkPayload {
  if (!isRec(v)) return false;
  if (typeof v['url'] !== 'string' || typeof v['method'] !== 'string') return false;
  if (typeof v['status'] !== 'number' || typeof v['timestamp'] !== 'number') return false;
  if (v['requestBody'] != null && typeof v['requestBody'] !== 'string') return false;
  if (v['responseBody'] != null && typeof v['responseBody'] !== 'string') return false;
  if (v['durationMs'] != null && typeof v['durationMs'] !== 'number') return false;
  return true;
}

async function notifyIndicator(type: 'TT_CONTENT_PAUSE' | 'TT_CONTENT_RESUME'): Promise<void> {
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  for (const tab of tabs) {
    if (tab.id) chrome.tabs.sendMessage(tab.id, { type }).catch(() => {});
  }
}
