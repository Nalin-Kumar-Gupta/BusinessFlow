import { attachNavListeners } from './nav-observer.js';
import { attachNetListeners } from './net-observer.js';
import { injectIntoMatchingTabs, requestOptionalPermission, getSessionScopePermissionPatterns } from './inject.js';

import { requestCapture } from './screenshot.js';
import { startSession } from './session.js';
import {
  addScopeOrigin,
  addSessionTab,
  getActiveSessionId,
  removePendingOrigin,
} from '../storage/session-state.js';
import { setSessionStartedAt } from '../storage/session-state.js';
import type { Session } from '../core/types.js';

export async function handleSessionStartFromPage(
  msg: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r?: unknown) => void,
  deps: { syncActionBadge: () => Promise<void> },
): Promise<void> {
  const existing = await getActiveSessionId();
  if (existing) { sendResponse({ type: 'TT_SESSION_START_ERR', error: 'Session already active' }); return; }

  const origins = (msg['scopeOrigins'] as string[] | undefined) ?? [];
  if (!origins.length) { sendResponse({ type: 'TT_SESSION_START_ERR', error: 'No origins provided' }); return; }

  const patterns = getSessionScopePermissionPatterns(origins);
  const hasPerm = await chrome.permissions.contains({ origins: patterns }).catch(() => false);
  if (!hasPerm) {
    const granted = await requestOptionalPermission(origins).catch(() => false);
    if (!granted) {
      sendResponse({ type: 'TT_SESSION_START_ERR', error: 'Permission denied' });
      return;
    }
  }

  const hasAllPerms = await chrome.permissions.contains({ origins: patterns }).catch(() => false);
  if (!hasAllPerms) {
    console.error('[TestTrace] session_start_from_page permission verification failed', { origins, hasAllPerms });
    sendResponse({ type: 'TT_SESSION_START_ERR', error: 'Permission denied' });
    return;
  }

  attachNetListeners();
  attachNavListeners();

  const tabId = sender.tab?.id ?? -1;

  const session = await startSession({
    testCaseName: String(msg['testCaseName'] ?? 'Untitled'),
    featureName: typeof msg['featureName'] === 'string' ? msg['featureName'].trim() : undefined,
    mode: 'guided',
    negativeTest: (msg['negativeTest'] as 'yes' | 'no' | 'unknown') ?? 'unknown',
    scopeOrigins: origins,
    tabId,
    apiSlaSec: typeof msg['apiSlaSec'] === 'number' ? msg['apiSlaSec'] : 3,
    negativeExpectations: (msg['negativeExpectations'] as Session['negativeExpectations'] | undefined),
  });

  await setSessionStartedAt(session.startedAt);

  if (tabId > 0) {
    try {
      const startTab = await chrome.tabs.get(tabId);
      await addSessionTab({ tabId, windowId: startTab.windowId, origin: origins[0] ?? '', addedAt: Date.now() });
    } catch { /* tab may already be gone */ }
  }

  if (tabId > 0) {
    chrome.tabs.sendMessage(tabId, { type: 'TT_CONTENT_ACTIVATE', sessionId: session.id, sessionStartedAt: session.startedAt }).catch(() => {});
    setTimeout(() => {
      void requestCapture({ sessionId: session.id, tabId, trigger: 'session_start', priority: 'high' });
    }, 600);
  }

  await injectIntoMatchingTabs(origins);
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  for (const tab of tabs) {
    if (tab.id && tab.id !== tabId) {
      chrome.tabs.sendMessage(tab.id, { type: 'TT_CONTENT_ACTIVATE', sessionId: session.id, sessionStartedAt: session.startedAt }).catch(() => {});
    }
  }

  await deps.syncActionBadge();

  // Open the side panel for the starting tab (best-effort; open() requires a
  // user gesture and this handler runs off a content-script message so it may
  // be denied — openPanelOnActionClick keeps the icon-click fallback working).
  if (tabId > 0) {
    chrome.sidePanel.setOptions({ tabId, path: 'ui/panel.html', enabled: true }).catch(() => {});
    chrome.sidePanel.open({ tabId }).catch(() => {});
  }

  sendResponse({ type: 'TT_SESSION_STARTED', session });
}

export async function handlePermitOrigin(
  msg: Record<string, unknown>,
  deps: {
    pendingCaptureTabs: Set<number>;
    activateTab: (tabId: number, sessionId: string) => Promise<void>;
    syncActionBadge: () => Promise<void>;
  },
): Promise<void> {
  const origin = msg['origin'] as string | undefined;
  const tabId = msg['tabId'] as number | undefined;
  if (!origin || !tabId) return;

  const sessionId = await getActiveSessionId();
  if (!sessionId) return;

  await addScopeOrigin(origin);
  await removePendingOrigin(origin);

  try {
    const tab = await chrome.tabs.get(tabId);
    await addSessionTab({ tabId, windowId: tab.windowId, origin, addedAt: Date.now() });
  } catch { /* tab may be gone */ }

  await deps.activateTab(tabId, sessionId);

  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.active) {
      setTimeout(() => void requestCapture({ sessionId, tabId, trigger: 'session_start', priority: 'high' }), 700);
    } else {
      deps.pendingCaptureTabs.add(tabId);
    }
  } catch { /* tab may be gone */ }

  await deps.syncActionBadge();
}
