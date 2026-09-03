// Fast ephemeral state in chrome.storage — survives SW restart, cleared on browser exit.
// For durable data use IDB (db.ts).

const K_ACTIVE   = 'tt:activeSessionId';
const K_SEQ      = 'tt:seq';
const K_PAUSED   = 'tt:paused';
const K_SCOPE    = 'tt:scopeOrigins';
const K_LAST_SS  = 'tt:lastScreenshotTs'; // per-tab throttle map
const K_TABS     = 'tt:sessionTabs';      // multi-tab tracking
const K_PENDING  = 'tt:pendingOrigins';   // new origins awaiting permission
const K_START_TS = 'tt:sessionStartedAt'; // unix ms — so all tabs show the same timer

// Serialize mutable storage operations to avoid lost updates under concurrent async calls.
let _stateQueue: Promise<void> = Promise.resolve();

async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const prev = _stateQueue;
  _stateQueue = prev.then(() => gate);
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function getActiveSessionId(): Promise<string | null> {
  const r = await chrome.storage.local.get(K_ACTIVE);
  return typeof r[K_ACTIVE] === 'string' ? (r[K_ACTIVE] as string) : null;
}

export async function setActiveSessionId(id: string | null): Promise<void> {
  if (id === null) await chrome.storage.local.remove(K_ACTIVE);
  else await chrome.storage.local.set({ [K_ACTIVE]: id });
}

export async function isPaused(): Promise<boolean> {
  const r = await chrome.storage.local.get(K_PAUSED);
  return r[K_PAUSED] === true;
}

export async function setPaused(v: boolean): Promise<void> {
  await chrome.storage.local.set({ [K_PAUSED]: v });
}

export async function getScopeOrigins(): Promise<string[]> {
  const r = await chrome.storage.local.get(K_SCOPE);
  return Array.isArray(r[K_SCOPE]) ? (r[K_SCOPE] as string[]) : [];
}

export async function setScopeOrigins(origins: string[]): Promise<void> {
  await chrome.storage.local.set({ [K_SCOPE]: origins });
}

/** Monotonic sequence counter — persists across SW restarts. */
export async function nextSeq(): Promise<number> {
  return withStateLock(async () => {
    const r = await chrome.storage.local.get(K_SEQ);
    const cur = typeof r[K_SEQ] === 'number' ? (r[K_SEQ] as number) : 0;
    const next = cur + 1;
    await chrome.storage.local.set({ [K_SEQ]: next });
    return next;
  });
}

/** Check and update per-tab screenshot throttle. Returns true if screenshot is allowed. */
export async function checkScreenshotThrottle(tabId: number, minIntervalMs: number): Promise<boolean> {
  return withStateLock(async () => {
    const r = await chrome.storage.local.get(K_LAST_SS);
    const map: Record<number, number> = (r[K_LAST_SS] as Record<number, number>) ?? {};
    const last = map[tabId] ?? 0;
    const now = Date.now();
    if (now - last < minIntervalMs) return false;
    map[tabId] = now;
    await chrome.storage.local.set({ [K_LAST_SS]: map });
    return true;
  });
}

export async function resetScreenshotThrottle(tabId: number): Promise<void> {
  const r = await chrome.storage.local.get(K_LAST_SS);
  const map: Record<number, number> = (r[K_LAST_SS] as Record<number, number>) ?? {};
  delete map[tabId];
  await chrome.storage.local.set({ [K_LAST_SS]: map });
}

export async function getSessionStartedAt(): Promise<number> {
  const r = await chrome.storage.local.get(K_START_TS);
  return typeof r[K_START_TS] === 'number' ? (r[K_START_TS] as number) : Date.now();
}

export async function setSessionStartedAt(ts: number): Promise<void> {
  await chrome.storage.local.set({ [K_START_TS]: ts });
}

export async function clearAllState(): Promise<void> {
  await chrome.storage.local.remove([K_ACTIVE, K_PAUSED, K_SCOPE, K_LAST_SS, K_TABS, K_PENDING, K_START_TS]);
}

// ─── Scope origins helpers ────────────────────────────────────────────────────

/** Add an origin to the current session scope (mid-session expansion). */
export async function addScopeOrigin(origin: string): Promise<void> {
  const current = await getScopeOrigins();
  if (current.includes(origin)) return;
  await chrome.storage.local.set({ [K_SCOPE]: [...current, origin] });
}

// ─── Multi-tab session tracking ───────────────────────────────────────────────
//
// A "session tab" is any browser tab whose activity belongs to the active test
// session.  The set is keyed by tabId and stored in chrome.storage.local so it
// survives service-worker restarts (MV3 SW can be terminated at any time).
//
// Lifecycle:
//   • Added when: session starts (initial tab) OR a session tab opens a new tab.
//   • Updated when: the tab navigates and its origin becomes known.
//   • Removed when: the tab is closed.
//   • Cleared entirely when: the session is stopped.

export interface SessionTab {
  tabId: number;
  windowId: number;
  /** Origin of the tab's current page.  Empty string while the tab is still loading. */
  origin: string;
  /** tabId of the tab that opened this one, if applicable. */
  openerTabId?: number;
  addedAt: number;
}

async function _getTabs(): Promise<Record<string, SessionTab>> {
  const r = await chrome.storage.local.get(K_TABS);
  return (r[K_TABS] as Record<string, SessionTab> | undefined) ?? {};
}

export async function getSessionTabs(): Promise<Map<number, SessionTab>> {
  const raw = await _getTabs();
  return new Map(Object.entries(raw).map(([k, v]) => [Number(k), v]));
}

export async function addSessionTab(tab: SessionTab): Promise<void> {
  const raw = await _getTabs();
  raw[String(tab.tabId)] = tab;
  await chrome.storage.local.set({ [K_TABS]: raw });
}

export async function updateSessionTabOrigin(tabId: number, origin: string, windowId: number): Promise<void> {
  const raw = await _getTabs();
  if (raw[String(tabId)]) {
    raw[String(tabId)]!.origin = origin;
    raw[String(tabId)]!.windowId = windowId;
    await chrome.storage.local.set({ [K_TABS]: raw });
  }
}

export async function removeSessionTab(tabId: number): Promise<void> {
  const raw = await _getTabs();
  delete raw[String(tabId)];
  await chrome.storage.local.set({ [K_TABS]: raw });
}

export async function clearSessionTabs(): Promise<void> {
  await chrome.storage.local.remove(K_TABS);
}

export async function isSessionTab(tabId: number): Promise<boolean> {
  const raw = await _getTabs();
  return String(tabId) in raw;
}

// ─── Pending origins (new tabs/origins awaiting user permission) ──────────────
//
// When a session tab opens a tab on an origin we haven't captured before,
// we can't silently inject (no permission) and we can't call
// chrome.permissions.request() from the SW (no user gesture).
// Instead we record the origin here and surface it in the popup UI.

export interface PendingOrigin {
  origin: string;
  tabId: number;     // the new tab that triggered discovery
  openerTabId: number;
  discoveredAt: number;
}

export async function getPendingOrigins(): Promise<PendingOrigin[]> {
  const r = await chrome.storage.local.get(K_PENDING);
  return Array.isArray(r[K_PENDING]) ? (r[K_PENDING] as PendingOrigin[]) : [];
}

export async function addPendingOrigin(p: PendingOrigin): Promise<void> {
  const current = await getPendingOrigins();
  if (current.some((x) => x.origin === p.origin)) return; // already pending
  await chrome.storage.local.set({ [K_PENDING]: [...current, p] });
}

export async function removePendingOrigin(origin: string): Promise<void> {
  const current = await getPendingOrigins();
  await chrome.storage.local.set({ [K_PENDING]: current.filter((x) => x.origin !== origin) });
}

export async function clearPendingOrigins(): Promise<void> {
  await chrome.storage.local.remove(K_PENDING);
}
