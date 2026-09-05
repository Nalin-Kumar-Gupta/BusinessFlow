import type { Session, SessionMode, NegativeTest, TestEvent } from '../core/types.js';


import { newSessionId, newEventId } from '../core/ids.js';
import { putSession, getSession, appendEvent, getAllSessions, deleteSession } from '../storage/db.js';
import { getSettings } from '../storage/settings.js';
import {
  setActiveSessionId, setScopeOrigins, setPaused, clearAllState, nextSeq,
} from '../storage/session-state.js';

const counterLocks = new Map<string, Promise<void>>();


async function withSessionCounterLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prior = counterLocks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const chained = prior.then(() => gate);
  counterLocks.set(sessionId, chained);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (counterLocks.get(sessionId) === chained) {
      counterLocks.delete(sessionId);
    }
  }
}


export interface StartSessionParams {
  testCaseName: string;
  featureName?: string;
  testCaseId?: string;
  mode: SessionMode;
  negativeTest: NegativeTest;
  scopeOrigins: string[];
  tabId: number;
  apiSlaSec?: number;
  negativeExpectations?: Session['negativeExpectations'];
}

async function enforceRunRetention(featureName: string | undefined, testCaseName: string): Promise<void> {
  const settings = await getSettings().catch(() => null);
  const maxRuns = Math.max(2, Math.min(15, Math.round(settings?.maxRunsPerTestCase ?? 10)));
  const featureKey = featureName?.trim().toLowerCase() ?? '';
  const testKey = testCaseName.trim().toLowerCase();
  if (!testKey) return;

  const runs = (await getAllSessions())
    .filter((session) => (session.featureName?.trim().toLowerCase() ?? '') === featureKey)
    .filter((session) => (session.testCaseName?.trim().toLowerCase() ?? '') === testKey)
    .sort((a, b) => b.startedAt - a.startedAt);

  const stale = runs.slice(maxRuns);
  for (const run of stale) {
    await deleteSession(run.id);
  }
}

async function registerNetworkInterceptor(): Promise<void> {
  const script: chrome.scripting.RegisteredContentScript = {
    id: 'tt-network-interceptor',
    js: ['content/interceptor.js'],
    matches: ['<all_urls>'],
    world: 'MAIN',
    runAt: 'document_start',
  };

  try {
    await chrome.scripting.registerContentScripts([script]);
  } catch {
    await chrome.scripting.updateContentScripts([script]).catch(() => {});
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id) {
    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: ['content/interceptor.js'],
      world: 'MAIN',
    }).catch(console.warn);
  }
}

export async function startSession(params: StartSessionParams): Promise<Session> {
  const manifest = chrome.runtime.getManifest() as { version: string };
  const nav = navigator as Navigator & { userAgentData?: { brands?: {brand:string; version:string}[]; platform?: string } };
  const chromeVersion = nav.userAgentData?.brands?.find((b) => b.brand === 'Google Chrome')?.version ?? '';

  // Capture viewport from the active tab via scripting
  let viewport: Session['environment']['viewport'];
  if (params.tabId > 0) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: params.tabId },
        func: () => ({
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
        }),
      });
      const vp = results[0]?.result as { width: number; height: number; devicePixelRatio: number } | undefined;
      if (vp) viewport = vp;
    } catch { /* tab may not allow scripting yet */ }
  }

  const session: Session = {
    id: newSessionId(),
    testCaseName: params.testCaseName,
    featureName: params.featureName,
    status: 'draft',
    testCaseId: params.testCaseId,
    mode: params.mode,
    negativeTest: params.negativeTest,
    negativeTestSource: params.negativeTest !== 'unknown' ? 'user' : 'default',
    ...(params.negativeExpectations ? { negativeExpectations: params.negativeExpectations } : {}),
    recordingState: 'active',
    testResult: 'in_progress',
    apiSlaSec: params.apiSlaSec ?? 3,
    startedAt: Date.now(),
    scopeOrigins: params.scopeOrigins,
    environment: {
      userAgent: navigator.userAgent,
      chromeVersion,
      platform: nav.userAgentData?.platform ?? navigator.platform ?? '',
      extVersion: manifest.version,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      viewport,
    },
    counters: {
      events: 0, networkRequests: 0, httpErrors: 0, networkErrors: 0,
      consoleErrors: 0, consoleWarns: 0, pageErrors: 0,
      screenshots: 0, manualCaptures: 0, rageClicks: 0, steps: 0,
    },
    schemaVersion: 1,
  };

  await putSession(session);
  await setActiveSessionId(session.id);
  await setScopeOrigins(params.scopeOrigins);
  await setPaused(false);
  await enforceRunRetention(session.featureName, session.testCaseName ?? 'Untitled Test Case');

  try {
    await registerNetworkInterceptor();
  } catch {
    // Never fail session start on interceptor registration.
  }

  const startEvent: TestEvent = {
    id: newEventId(),
    sessionId: session.id,
    ts: session.startedAt,
    seq: await nextSeq(),
    kind: 'session_start',
    tabId: params.tabId,
    confidence: 'observed',
  };
  await appendEvent(startEvent);
  await incrementCounter(session.id, 'events');

  return session;
}

async function unregisterNetworkInterceptor(): Promise<void> {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ['tt-network-interceptor'] });
  } catch (error) {
    const msg = String(error ?? '');
    if (msg.includes('Nonexistent script ID tt-network-interceptor')) return;
    console.warn(error);
  }
}

export async function stopSession(sessionId: string, tabId: number): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) return;

  session.recordingState = 'stopped';
  session.endedAt = Date.now();
  await putSession(session);

  const endEvent: TestEvent = {
    id: newEventId(),
    sessionId,
    ts: session.endedAt,
    seq: await nextSeq(),
    kind: 'session_end',
    tabId,
    confidence: 'observed',
    durationMs: session.endedAt - session.startedAt,
  };
  await appendEvent(endEvent);

  const featureParam = encodeURIComponent(session.featureName ?? '');
  const dashboardUrl = chrome.runtime.getURL(`ui/dashboard/dashboard.html?feature=${featureParam}&session=${session.id}`);
  chrome.tabs.create({ url: dashboardUrl }).catch(() => {});

  await clearAllState();
  await unregisterNetworkInterceptor();
}

export async function pauseSession(sessionId: string, tabId: number): Promise<void> {
  await setPaused(true);
  const ev: TestEvent = {
    id: newEventId(), sessionId, ts: Date.now(),
    seq: await nextSeq(), kind: 'capture_paused', tabId, confidence: 'observed',
  };
  await appendEvent(ev);
  await incrementCounter(sessionId, 'events');
}

export async function resumeSession(sessionId: string, tabId: number): Promise<void> {
  await setPaused(false);
  const ev: TestEvent = {
    id: newEventId(), sessionId, ts: Date.now(),
    seq: await nextSeq(), kind: 'capture_resumed', tabId, confidence: 'observed',
  };
  await appendEvent(ev);
  await incrementCounter(sessionId, 'events');
}

export async function updateTestResult(sessionId: string, result: Session['testResult']): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) return;
  session.testResult = result;
  await putSession(session);
}

export async function incrementCounter(
  sessionId: string,
  field: keyof Session['counters'],
): Promise<void> {
  await withSessionCounterLock(sessionId, async () => {
    const session = await getSession(sessionId);
    if (!session) return;
    const current = session.counters[field] ?? 0;
    session.counters[field] = current + 1;
    await putSession(session);
  });
}

/**
 * Atomically increments the step counter and returns the new 1-based step index.
 * Used by the click-driven step pipeline to assign monotonic step numbers.
 */
export async function nextStepIndex(sessionId: string): Promise<number> {
  let next = 0;
  await withSessionCounterLock(sessionId, async () => {
    const session = await getSession(sessionId);
    if (!session) return;
    next = (session.counters.steps ?? 0) + 1;
    session.counters.steps = next;
    await putSession(session);
  });
  return next;
}
