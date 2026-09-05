import type { TestEvent } from '../core/types.js';
import { newEventId } from '../core/ids.js';
import { redactUrl, urlMatchesScope } from '../core/url.js';
import { appendEvent } from '../storage/db.js';
import { getActiveSessionId, getScopeOrigins, nextSeq } from '../storage/session-state.js';
import { requestCapture } from './screenshot.js';
import { resetTabApiShotBudget, getInFlightRequestCount } from './net-observer.js';
import { incrementCounter } from './session.js';
import {
  getClickContextForTab,
  isActiveStepForTab,
  markStepAwaitingNav,
  clearStepNavPending,
  isScriptableUrl,
} from './content-events.js';
import { evaluateAfterCaptureDecision, markAfterQueued } from './after-capture-policy.js';

const CLICK_CAUSED_NAV_WINDOW_MS = 1200;

// Phase 1: navigation-settled (handles multi-hop redirects like SSO/SAML).
// Wait until onCompleted has been quiet for NAV_QUIET_MS on the tab. Each
// new onCompleted resets the timer, so 302 → SAML → 302 → app all collapse
// into a single "settled" event, and we capture the final destination.
const NAV_QUIET_MS = 500;
const NAV_MAX_WAIT_MS = 12_000;         // hard ceiling incl. slow VPN + SSO

// Phase 2: paint-ready wait after navigation settled.
// onCompleted fires when the HTML shell is loaded, not when SPA UI is painted.
// We poll the page context for a minimal paint signal and hard-timeout at 4s.
const POST_NAV_PAINT_MAX_WAIT_MS = 4_000;
const POST_NAV_POLL_MS = 200;

// SPA route changes (history.pushState) don't fire onCompleted. Use a shorter
// fixed wait — enough for React/Vue/Angular to render the new route + first
// data fetch, but not so long that the after-frame lags visibly.
const SPA_ROUTE_RENDER_MS = 1200;
const AFTER_NETWORK_QUIET_MS = 260;
const AFTER_NETWORK_MAX_WAIT_MS = 1400;
const AFTER_NETWORK_POLL_MS = 80;

// Persistent per-tab tracking of the last webNavigation.onCompleted timestamp.
// Populated by a top-level listener attached in attachNavListeners so
// waitForNavigationSettled can observe redirect chains without racing.
const lastOnCompletedAtByTab = new Map<number, number>();
// Tabs known to have been removed — aborts in-flight waits so we don't try
// to screenshot a dead tab or hold a step in pending state.
const closedTabIds = new Set<number>();

let navCommittedCb: ((d: chrome.webNavigation.FrameNavDetails) => void) | null = null;
let historyUpdatedCb: ((d: chrome.webNavigation.FrameNavDetails) => void) | null = null;
let tabUpdatedCb: ((tabId: number, ci: chrome.tabs.ChangeInfo, tab: chrome.tabs.Tab) => void) | null = null;
let beforeNavigateCb: ((d: chrome.webNavigation.FrameNavDetails) => void) | null = null;
let createdTargetCb: ((d: chrome.webNavigation.CreatedNavigationTargetDetails) => void) | null = null;
let onCompletedTrackerCb: ((d: chrome.webNavigation.FrameNavDetails) => void) | null = null;
let tabRemovedTrackerCb: ((tabId: number) => void) | null = null;

export function attachNavListeners(): void {
  if (navCommittedCb) return;

  navCommittedCb = (d) => void handleNavCommitted(d, false);
  historyUpdatedCb = (d) => void handleNavCommitted(d, true);
  tabUpdatedCb = (tabId, ci, tab) => void handleTabUpdated(tabId, ci, tab);
  beforeNavigateCb = (d) => void handleBeforeNavigate(d);
  createdTargetCb = (d) => void handleCreatedNavigationTarget(d);
  onCompletedTrackerCb = (d) => {
    if (d.frameId !== 0) return;
    lastOnCompletedAtByTab.set(d.tabId, Date.now());
    // If tab was previously marked closed but reappears (rare), unmark
    closedTabIds.delete(d.tabId);
  };
  tabRemovedTrackerCb = (tabId) => {
    closedTabIds.add(tabId);
    lastOnCompletedAtByTab.delete(tabId);
    // Bounded cleanup so closedTabIds doesn't grow forever in long sessions
    if (closedTabIds.size > 500) {
      const arr = Array.from(closedTabIds);
      for (const id of arr.slice(0, 250)) closedTabIds.delete(id);
    }
  };

  chrome.webNavigation.onCommitted.addListener(navCommittedCb);
  chrome.webNavigation.onHistoryStateUpdated.addListener(historyUpdatedCb);
  chrome.webNavigation.onBeforeNavigate.addListener(beforeNavigateCb);
  chrome.webNavigation.onCreatedNavigationTarget.addListener(createdTargetCb);
  chrome.webNavigation.onCompleted.addListener(onCompletedTrackerCb);
  chrome.tabs.onUpdated.addListener(tabUpdatedCb);
  chrome.tabs.onRemoved.addListener(tabRemovedTrackerCb);
}

export function detachNavListeners(): void {
  if (navCommittedCb) chrome.webNavigation.onCommitted.removeListener(navCommittedCb);
  if (historyUpdatedCb) chrome.webNavigation.onHistoryStateUpdated.removeListener(historyUpdatedCb);
  if (beforeNavigateCb) chrome.webNavigation.onBeforeNavigate.removeListener(beforeNavigateCb);
  if (createdTargetCb) chrome.webNavigation.onCreatedNavigationTarget.removeListener(createdTargetCb);
  if (onCompletedTrackerCb) chrome.webNavigation.onCompleted.removeListener(onCompletedTrackerCb);
  if (tabUpdatedCb) chrome.tabs.onUpdated.removeListener(tabUpdatedCb);
  if (tabRemovedTrackerCb) chrome.tabs.onRemoved.removeListener(tabRemovedTrackerCb);
  navCommittedCb = null;
  historyUpdatedCb = null;
  beforeNavigateCb = null;
  createdTargetCb = null;
  onCompletedTrackerCb = null;
  tabUpdatedCb = null;
  tabRemovedTrackerCb = null;
  lastOnCompletedAtByTab.clear();
  closedTabIds.clear();
}

async function handleNavCommitted(d: chrome.webNavigation.FrameNavDetails, isSpa: boolean): Promise<void> {
  if (d.frameId !== 0) return; // main frame only
  const sessionId = await getActiveSessionId();
  if (!sessionId) return;
  const scopeOrigins = await getScopeOrigins();
  if (!urlMatchesScope(d.url, scopeOrigins)) return;

  const seq = await nextSeq();
  const ev: TestEvent = {
    id: newEventId(),
    sessionId,
    ts: d.timeStamp,
    seq,
    kind: 'navigation',
    tabId: d.tabId,
    frameId: d.frameId,
    confidence: 'observed',
    url: redactUrl(d.url),
    isSpaRouteChange: isSpa,
    transitionType: d.transitionType,
  };
  await appendEvent(ev);
  await incrementCounter(sessionId, 'events');

  resetTabApiShotBudget(d.tabId);

  // ── SPA route change: click-caused after-frame hijack ──
  // SPA nav fires onHistoryStateUpdated → handleNavCommitted(isSpa=true).
  // If it happened within the click window, own the after-frame timing so
  // we don't capture the mid-transition white flash.
  if (isSpa) {
    const ctx = getClickContextForTab(d.tabId);
    if (ctx.clickTs && ctx.stepId) {
      const sinceClick = Date.now() - ctx.clickTs;
      if (sinceClick <= CLICK_CAUSED_NAV_WINDOW_MS) {
        console.log('[TestTrace] nav-aware after-frame: SPA route change', {
          tabId: d.tabId, stepId: ctx.stepId, sinceClickMs: sinceClick, destination: d.url,
        });
        markStepAwaitingNav(ctx.stepId);
        void awaitSpaRenderAndCapture(sessionId, d.tabId, ctx.stepId, d.url, ctx.generation ?? 0);
        return; // don't fire the standard nav screenshot — the SPA after-frame handles it
      }
    }
  }

  // Standard navigation screenshot (non-click-driven or hard nav on new tab).
  const delay = isSpa ? 300 : 600;
  const capturedEvId = ev.id;
  setTimeout(() => {
    void requestCapture({
      sessionId,
      tabId: d.tabId,
      trigger: 'navigation',
      triggerEventId: capturedEvId,
      pageUrl: d.url,
      priority: 'high',
    });
  }, delay);
}

async function handleTabUpdated(
  tabId: number,
  changeInfo: chrome.tabs.ChangeInfo,
  tab: chrome.tabs.Tab,
): Promise<void> {
  // We only care about complete loads for tabs in scope
  if (changeInfo.status !== 'complete') return;
  const sessionId = await getActiveSessionId();
  if (!sessionId) return;
  const url = tab.url ?? '';
  if (!url) return;
  const scopeOrigins = await getScopeOrigins();
  if (!urlMatchesScope(url, scopeOrigins)) return;

  // Tab finished loading — this might be a new page load not caught by webNavigation
  // (e.g., redirect chains). We don't double-record if webNavigation already fired.
}

// ─── Nav-aware after-frame (Option A) ────────────────────────────────
// When a click causes navigation (onBeforeNavigate within 750ms of the click),
// the content script dies before it can send user_action_stable. Take over on
// the background side: wait for the destination page to (1) stop redirecting
// then (2) stop mutating, then capture the after-frame.

async function handleBeforeNavigate(
  d: chrome.webNavigation.FrameNavDetails,
): Promise<void> {
  if (d.frameId !== 0) return; // main frame only

  const sessionId = await getActiveSessionId();
  if (!sessionId) return;

  const scopeOrigins = await getScopeOrigins();
  if (!urlMatchesScope(d.url, scopeOrigins)) return;

  const ctx = getClickContextForTab(d.tabId);
  if (!ctx.clickTs || !ctx.stepId) return;

  const sinceClick = Date.now() - ctx.clickTs;
  if (sinceClick > CLICK_CAUSED_NAV_WINDOW_MS) return;

  // Non-scriptable destination (chrome://, PDF, etc.) — content script won't
  // attach, so waiting for dom_change would be pointless. Skip nav-aware; the
  // standard navigation screenshot from handleNavCommitted will still fire.
  if (!isScriptableUrl(d.url)) {
    console.log('[TestTrace] nav-aware after-frame: skipped (non-scriptable URL)', {
      tabId: d.tabId, stepId: ctx.stepId, destination: d.url,
    });
    return;
  }

  console.log('[TestTrace] nav-aware after-frame: click caused navigation', {
    tabId: d.tabId,
    stepId: ctx.stepId,
    sinceClickMs: sinceClick,
    destination: d.url,
  });

  markStepAwaitingNav(ctx.stepId);
  void awaitNavAndCapture(sessionId, d.tabId, ctx.stepId, d.url, ctx.clickTs, ctx.generation ?? 0);
}

// Primitive 1: navigation-settled — waits for onCompleted to be quiet for
// NAV_QUIET_MS on this tab. Handles multi-hop redirect chains (SSO/SAML/302)
// naturally: each new onCompleted resets the quiet timer, and we only proceed
// once the redirect train has actually stopped at its final destination.
// Aborts early if the tab is closed.
async function waitForNavigationSettled(
  tabId: number,
  minCompletedAfterTs: number,
): Promise<'settled' | 'timeout' | 'tab-closed'> {
  const started = Date.now();
  let anySeen = false;

  while (Date.now() - started < NAV_MAX_WAIT_MS) {
    if (closedTabIds.has(tabId)) return 'tab-closed';

    const lastCompleted = lastOnCompletedAtByTab.get(tabId);
    if (lastCompleted !== undefined && lastCompleted >= minCompletedAfterTs) {
      anySeen = true;
      const quietFor = Date.now() - lastCompleted;
      if (quietFor >= NAV_QUIET_MS) return 'settled';
    }

    await new Promise<void>((r) => setTimeout(r, POST_NAV_POLL_MS));
  }
  return anySeen ? 'settled' : 'timeout';
}

async function probeTabPaintReady(tabId: number): Promise<boolean> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => {
        const bodyHeight = document.body?.clientHeight ?? 0;
        return document.readyState === 'complete' && bodyHeight > 0;
      },
    });
    return result?.result === true;
  } catch {
    return false;
  }
}

// Phase 2: after navigation settles, wait for a deterministic paint signal.
// Hard stop at 4s so the step never hangs forever on hostile pages.
async function waitForPaintReadyAfterNav(
  tabId: number,
): Promise<'paint-ready' | 'fallback-timeout' | 'tab-closed'> {
  const started = Date.now();
  while (Date.now() - started < POST_NAV_PAINT_MAX_WAIT_MS) {
    if (closedTabIds.has(tabId)) return 'tab-closed';
    if (await probeTabPaintReady(tabId)) return 'paint-ready';
    await new Promise<void>((r) => setTimeout(r, POST_NAV_POLL_MS));
  }
  return 'fallback-timeout';
}

async function getTabUrlSafe(tabId: number): Promise<string | undefined> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.url;
  } catch {
    return undefined;
  }
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

async function awaitNavAndCapture(
  sessionId: string,
  tabId: number,
  stepId: string,
  destinationUrl: string,
  clickTs: number,
  generation: number,
): Promise<void> {
  try {
    if (!isActiveStepForTab(tabId, stepId, generation)) {
      console.log('[TestTrace] nav-aware after-frame skipped — stale step replaced by newer click', {
        tabId,
        staleStepId: stepId,
      });
      return;
    }

    const navResult = await waitForNavigationSettled(tabId, clickTs);
    if (navResult === 'tab-closed') {
      console.warn('[TestTrace] nav-aware after-frame aborted: tab closed', { tabId, stepId });
      return;
    }
    if (navResult === 'timeout') {
      console.warn('[TestTrace] nav-aware after-frame: nav-settled timeout — capturing anyway', {
        tabId, stepId,
      });
    }

    const paintResult = await waitForPaintReadyAfterNav(tabId);
    if (paintResult === 'tab-closed') {
      console.warn('[TestTrace] nav-aware after-frame aborted: tab closed during paint wait', {
        tabId, stepId,
      });
      return;
    }

    // Prefer the tab's live URL so redirect chains are attributed correctly.
    const finalUrl = (await getTabUrlSafe(tabId)) ?? destinationUrl;

    const decision = await evaluateAfterCaptureDecision(sessionId, stepId, tabId, finalUrl, {
      navConfirmed: true,
      hasDomChangeSignal: false,
    });
    if (!decision.shouldCapture) {
      console.log('[TestTrace] nav-aware after-frame skipped', {
        tabId,
        stepId,
        finalUrl,
        reason: decision.reason,
      });
      return;
    }

    console.log('[TestTrace] nav-aware after-frame: capturing', {
      tabId, stepId, nav: navResult, paint: paintResult, finalUrl,
    });

    const networkQuiet = await waitForNetworkQuietOnTab(tabId);

    void requestCapture({
      sessionId,
      tabId,
      trigger: 'user_action_after',
      stepId,
      stepFrame: 'after',
      explicitTabTarget: true,
      priority: 'normal',
      pageUrl: finalUrl,
      note: `after_settle:${decision.reason} nav:${navResult} paint:${paintResult} networkQuiet:${networkQuiet.quiet ? 'yes' : 'timeout'} waitMs:${networkQuiet.waitedMs}`,
    });
    await markAfterQueued(stepId, decision.reason);
  } finally {
    clearStepNavPending(stepId);
  }
}

// SPA route change: no onCompleted event exists. Wait a fixed render budget
// (long enough for React/Vue/Angular to unmount → fetch → render), then capture.
async function awaitSpaRenderAndCapture(
  sessionId: string,
  tabId: number,
  stepId: string,
  destinationUrl: string,
  generation: number,
): Promise<void> {
  try {
    if (!isActiveStepForTab(tabId, stepId, generation)) {
      console.log('[TestTrace] SPA after-frame skipped — stale step replaced by newer click', {
        tabId,
        staleStepId: stepId,
      });
      return;
    }

    await new Promise<void>((r) => setTimeout(r, SPA_ROUTE_RENDER_MS));
    const finalUrl = (await getTabUrlSafe(tabId)) ?? destinationUrl;
    const decision = await evaluateAfterCaptureDecision(sessionId, stepId, tabId, finalUrl, {
      navConfirmed: true,
      hasDomChangeSignal: false,
    });
    if (!decision.shouldCapture) {
      console.log('[TestTrace] SPA after-frame skipped', {
        tabId,
        stepId,
        finalUrl,
        reason: decision.reason,
      });
      return;
    }

    const networkQuiet = await waitForNetworkQuietOnTab(tabId);

    void requestCapture({
      sessionId,
      tabId,
      trigger: 'user_action_after',
      stepId,
      stepFrame: 'after',
      explicitTabTarget: true,
      priority: 'normal',
      pageUrl: finalUrl,
      note: `after_settle:${decision.reason} networkQuiet:${networkQuiet.quiet ? 'yes' : 'timeout'} waitMs:${networkQuiet.waitedMs}`,
    });
    await markAfterQueued(stepId, decision.reason);
  } finally {
    clearStepNavPending(stepId);
  }
}

// ── New-tab-open case (window.open / target="_blank" / SAML redirect) ──
// Click on Apply Leave opens a NEW TAB to Workday. Original tab doesn't nav,
// so onBeforeNavigate/onHistoryStateUpdated never fire. Chrome fires
// onCreatedNavigationTarget with sourceTabId = the clicked tab, tabId = the
// new tab. Detect this, hijack the after-frame to point at the NEW tab, and
// wait for the new tab's onCompleted before capturing.
async function handleCreatedNavigationTarget(
  d: chrome.webNavigation.CreatedNavigationTargetDetails,
): Promise<void> {
  const sessionId = await getActiveSessionId();
  if (!sessionId) return;

  const ctx = getClickContextForTab(d.sourceTabId);
  if (!ctx.clickTs || !ctx.stepId) return;

  const sinceClick = Date.now() - ctx.clickTs;
  if (sinceClick > CLICK_CAUSED_NAV_WINDOW_MS) return;

  // Destination might be about:blank first (window.open pattern) then get
  // its real URL set via JS. Skip only if the *initial* URL is clearly
  // non-scriptable (chrome://, PDF, file://); about:blank will still enter
  // this path and get its real URL captured via waitForNavigationSettled +
  // getTabUrlSafe fallback.
  if (d.url && d.url !== 'about:blank' && !isScriptableUrl(d.url)) {
    console.log('[TestTrace] nav-aware after-frame: skipped new tab (non-scriptable URL)', {
      sourceTabId: d.sourceTabId, newTabId: d.tabId, destination: d.url,
    });
    return;
  }

  console.log('[TestTrace] nav-aware after-frame: click opened new tab', {
    sourceTabId: d.sourceTabId,
    newTabId: d.tabId,
    stepId: ctx.stepId,
    sinceClickMs: sinceClick,
    destination: d.url,
  });

  markStepAwaitingNav(ctx.stepId);
  // Redirect the after-frame to the NEW tab, not the original opener.
  void awaitNavAndCapture(sessionId, d.tabId, ctx.stepId, d.url, ctx.clickTs, ctx.generation ?? 0);
}
