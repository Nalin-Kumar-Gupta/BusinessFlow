// BusinessFlow Side Panel — primary control surface.
// Replaces the popup. Persistent, resizable, always-on-tab UI.
// Reads active session state from the background service worker via
// chrome.runtime messages, and reacts to chrome.storage changes so the UI
// updates without polling when pending origins are discovered mid-session.

import { render } from 'preact';
import { useState, useEffect, useCallback, useMemo, useRef } from 'preact/hooks';
import type { JSX } from 'preact/jsx-runtime';
import type { EvidenceStoredEvent } from '../../core/types.js';
import type { AuthStatusPayload } from '../../core/auth.js';
import { extractOrigin, originToPattern } from '../../core/url.js';
import { getAllSessions, getEventsForSession, getStepsForSession } from '../../storage/db.js';
import { getSettings } from '../../storage/settings.js';

type PanelState = 'loading' | 'no-permission' | 'unsupported' | 'idle' | 'recording' | 'paused';

interface PendingOriginInfo {
  origin: string;
  tabId: number;
  openerTabId: number;
  discoveredAt: number;
}

interface LiveStepCard {
  id: string;
  index: number;
  ts: number;
  hasAfter: boolean;
  noAfterNeeded: boolean;
  hasHttp500: boolean;
  hasConsoleError: boolean;
}

// Keys that session-state.ts writes to chrome.storage.local. When these
// change we re-pull status so the panel stays live without polling.
const REACTIVE_STORAGE_KEYS = new Set([
  'tt:activeSessionId',
  'tt:paused',
  'tt:pendingOrigins',
  'tt:sessionStartedAt',
]);

const BROAD_OPTIONAL_ORIGINS = ['<all_urls>'];

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function canScriptTab(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => true,
    });
    return true;
  } catch {
    return false;
  }
}

async function hasCaptureAccessForOrigin(origin: string): Promise<boolean> {
  const activeTab = await getActiveTab().catch(() => undefined);
  if (activeTab?.id && await canScriptTab(activeTab.id)) return true;

  const hasAllUrls = await chrome.permissions.contains({ origins: BROAD_OPTIONAL_ORIGINS }).catch(() => false);
  if (hasAllUrls) return true;

  const originPattern = originToPattern(origin);
  if (!originPattern) return false;
  return chrome.permissions.contains({ origins: [originPattern] }).catch(() => false);
}

async function ensureCaptureAccessForOrigin(origin: string): Promise<boolean> {
  if (await hasCaptureAccessForOrigin(origin)) return true;

  const originPattern = originToPattern(origin);
  if (originPattern) {
    const grantedOrigin = await chrome.permissions.request({ origins: [originPattern] }).catch(() => false);
    if (grantedOrigin) return true;
  }

  const grantedAll = await chrome.permissions.request({ origins: BROAD_OPTIONAL_ORIGINS }).catch(() => false);
  if (grantedAll) return true;

  return hasCaptureAccessForOrigin(origin);
}

function openDashboard(view: 'dashboard' | 'pricing', reason?: string, modal?: 'account'): void {
  const url = new URL(chrome.runtime.getURL('ui/dashboard/dashboard.html'));
  if (view !== 'dashboard') url.searchParams.set('view', view);
  if (modal) url.searchParams.set('modal', modal);
  if (reason) url.searchParams.set('source', reason);
  chrome.tabs.create({ url: url.toString() });
}

// ─── App ──────────────────────────────────────────────────────────────────────

function App(): JSX.Element {
  const [state, setState] = useState<PanelState>('loading');
  const [currentOrigin, setCurrentOrigin] = useState('');
  const [sessionStartMs, setSessionStartMs] = useState(0);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState('0:00');
  const [pendingOrigins, setPendingOrigins] = useState<PendingOriginInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [liveSteps, setLiveSteps] = useState<LiveStepCard[]>([]);
  const [captureState, setCaptureState] = useState<'idle' | 'capturing' | 'done' | 'failed'>('idle');
  const [sessionNotice, setSessionNotice] = useState<string>('');
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isCanceling, setIsCanceling] = useState(false);
  const [isPauseToggling, setIsPauseToggling] = useState(false);
  const [authStatus, setAuthStatus] = useState<AuthStatusPayload | null>(null);
  const cancelDialogRef = useRef<HTMLDivElement | null>(null);
  const keepRecordingButtonRef = useRef<HTMLButtonElement | null>(null);

  // Live timer while recording
  useEffect(() => {
    if (state !== 'recording' || !sessionStartMs) return;
    const tick = () => {
      const s = Math.floor((Date.now() - sessionStartMs) / 1000);
      setElapsed(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [state, sessionStartMs]);

  useEffect(() => {
    if (!showCancelConfirm) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    keepRecordingButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !isCanceling) {
        event.preventDefault();
        setShowCancelConfirm(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const container = cancelDialogRef.current;
      if (!container) return;
      const focusables = Array.from(container.querySelectorAll<HTMLElement>('button:not([disabled])'));
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [showCancelConfirm, isCanceling]);

  const loadLiveSteps = useCallback(async (sessionId: string) => {
    const [steps, events] = await Promise.all([
      getStepsForSession(sessionId),
      getEventsForSession(sessionId),
    ]);

    const storedById = new Map<string, EvidenceStoredEvent>();
    for (const ev of events) {
      if (ev.kind === 'evidence_stored') storedById.set(ev.id, ev);
    }

    const cards: LiveStepCard[] = [];
    const recent = steps.slice(-25).reverse();

    for (const step of recent) {
      const afterEv = step.afterEvidenceEventId ? storedById.get(step.afterEvidenceEventId) : undefined;
      const startTs = step.ts;
      const endTs = afterEv?.ts ?? (step.ts + 10_000);
      const hasHttp500 = events.some((ev) =>
        ev.tabId === step.tabId
        && ev.ts >= startTs
        && ev.ts <= endTs
        && ev.kind === 'net_phase'
        && (ev.statusCode ?? 0) >= 500,
      );
      const hasConsoleError = events.some((ev) =>
        ev.tabId === step.tabId
        && ev.ts >= startTs
        && ev.ts <= endTs
        && ev.kind === 'console_error',
      );

      cards.push({
        id: step.id,
        index: step.index,
        ts: step.ts,
        hasAfter: Boolean(step.afterEvidenceEventId),
        noAfterNeeded: Boolean(step.noChangeDetected && !step.afterEvidenceEventId),
        hasHttp500,
        hasConsoleError,
      });
    }

    setLiveSteps(cards);
  }, []);

  const refresh = useCallback(async () => {
    chrome.runtime.sendMessage({ type: 'TT_AUTH_GET_STATUS', refreshIfNeeded: true }, (authResp: unknown) => {
      if (!isRec(authResp)) return;
      const ok = authResp['ok'] === true;
      if (!ok) return;
      const status = authResp['status'];
      if (isRec(status)) {
        setAuthStatus(status as unknown as AuthStatusPayload);
      }
    });

    const tabs = await new Promise<chrome.tabs.Tab[]>((res) =>
      chrome.tabs.query({ active: true, currentWindow: true }, res),
    );
    const tab = tabs[0];
    const url = tab?.url ?? '';

    if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) {
      setState('unsupported');
      return;
    }

    const origin = extractOrigin(url);
    setCurrentOrigin(origin);

    // We need to know session state even when we don't yet have origin permission
    // (a session may be recording on another origin — we shouldn't block the UI).
    chrome.runtime.sendMessage({ type: 'TT_GET_STATUS' }, (r: unknown) => {
      const resp = isRec(r) ? (r as Record<string, unknown>) : null;
      const sid = resp?.['sessionId'] as string | null | undefined;

      if (sid) {
        setActiveSessionId(sid);
        const p = Boolean(resp?.['paused']);
        setPaused(p);
        setState(p ? 'paused' : 'recording');
        setSessionNotice('');
        setSessionStartMs(Number(resp?.['sessionStartedAt'] ?? 0));
        void loadLiveSteps(sid);
        chrome.runtime.sendMessage({ type: 'TT_GET_PENDING_ORIGINS' }, (pr: unknown) => {
          if (isRec(pr)) setPendingOrigins((pr as Record<string, unknown>)['origins'] as PendingOriginInfo[] ?? []);
        });
        return;
      }

      // No active session — check whether we can capture on current tab.
      void (async () => {
        const hasAccess = await hasCaptureAccessForOrigin(origin);
        setActiveSessionId(null);
        setLiveSteps([]);
        setState(hasAccess ? 'idle' : 'no-permission');
        setSessionNotice('');
        setPendingOrigins([]);
        setSessionStartMs(0);
      })();
    });
  }, [loadLiveSteps]);

  useEffect(() => { void refresh(); }, [refresh]);

  // React to chrome.storage.local changes so pending origins / pause state
  // update immediately when background writes them.
  useEffect(() => {
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      for (const key of Object.keys(changes)) {
        if (REACTIVE_STORAGE_KEYS.has(key)) { void refresh(); return; }
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [refresh]);

  // React to tab switches / URL changes so the panel reflects the active tab
  useEffect(() => {
    const onActivated = () => void refresh();
    const onUpdated = (_tabId: number, changeInfo: chrome.tabs.ChangeInfo) => {
      if (changeInfo.status === 'complete' || changeInfo.url) void refresh();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [refresh]);

  // Live session metrics update from background step events.
  useEffect(() => {
    const onRuntimeMessage = (msg: unknown): void => {
      if (!isRec(msg) || typeof msg['type'] !== 'string') return;
      const type = msg['type'] as string;
      if (type !== 'TT_STEP_CREATED' && type !== 'TT_STEP_UPDATED') return;
      const sid = typeof msg['sessionId'] === 'string' ? msg['sessionId'] : '';
      if (!sid || !activeSessionId || sid !== activeSessionId) return;
      void loadLiveSteps(sid);
    };
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    return () => chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  }, [activeSessionId, loadLiveSteps]);


  const handleAllow = () => {
    void (async () => {
      const granted = await ensureCaptureAccessForOrigin(currentOrigin);
      if (granted) setState('idle');
    })();
  };


  // Grant permission for a new origin found mid-session. chrome.permissions.request()
  // MUST be called from the side panel / popup (user gesture).
  const handleGrantOrigin = (pending: PendingOriginInfo) => {
    const pattern = originToPattern(pending.origin);
    if (!pattern) return;
    chrome.permissions.request({ origins: [pattern] }, (granted) => {
      if (!granted) return;
      chrome.runtime.sendMessage({ type: 'TT_PERMIT_ORIGIN', origin: pending.origin, tabId: pending.tabId });
      setPendingOrigins((prev) => prev.filter((p) => p.origin !== pending.origin));
    });
  };

  const handleStop = () => {
    if (isStopping) return;
    setIsStopping(true);
    setSessionNotice('');
    chrome.runtime.sendMessage({ type: 'TT_SESSION_STOP' }, (response: unknown) => {
      setIsStopping(false);

      if (chrome.runtime.lastError) {
        setSessionNotice('BusinessFlow could not stop recording cleanly. Reload the extension, then verify run status in the dashboard.');
        return;
      }

      if (!isRec(response) || response['type'] !== 'TT_SESSION_STOPPED') {
        setSessionNotice('Stop recording failed. Please try again.');
        return;
      }

      const warnings = Array.isArray(response['warnings'])
        ? (response['warnings'] as unknown[]).filter((item): item is string => typeof item === 'string')
        : [];
      const cleanupSummary = isRec(response['cleanupSummary']) ? response['cleanupSummary'] : null;

      setState('idle');
      setActiveSessionId(null);
      setPendingOrigins([]);
      setLiveSteps([]);
      setCaptureState('idle');

      const cleanupChanged = cleanupSummary
        && typeof cleanupSummary['updatedSteps'] === 'number'
        && (cleanupSummary['updatedSteps'] as number) > 0;

      if (warnings.length > 0) {
        setSessionNotice(warnings[0] ?? 'Recording stopped with warnings. Review dashboard before sharing.');
      } else if (cleanupChanged) {
        setSessionNotice('Recording finalized. Cleaning pass complete — opening dashboard report.');
      } else {
        setSessionNotice('Recording finalized. Opening dashboard report…');
      }

      openDashboard('dashboard', 'panel-stop-report');
    });
  };

  const handleManualCapture = async () => {
    if (captureState === 'capturing') return;
    setCaptureState('capturing');
    setSessionNotice('');

    const hasAccess = await ensureCaptureAccessForOrigin(currentOrigin);
    if (!hasAccess) {
      setCaptureState('failed');
      setSessionNotice('BusinessFlow needs site access to capture evidence on this page. Update Site access in Chrome extension settings, then try again.');
      window.setTimeout(() => setCaptureState('idle'), 1800);
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      chrome.runtime.sendMessage(
        {
          type: 'TT_CAPTURE_EVIDENCE',
          tabId,
          note: 'Manual evidence capture from side panel',
          confidence: 'manual',
        },
        (response) => {
          if (chrome.runtime.lastError || !isRec(response) || response['ok'] !== true) {
            const reason = isRec(response) && typeof response['reason'] === 'string'
              ? response['reason']
              : '';
            const humanMessage = reason === 'permission_denied'
              ? 'BusinessFlow needs site access to capture evidence on this page. Update Site access in Chrome extension settings, then try again.'
              : reason === 'no_active_tab'
                ? 'No active tab detected. Focus the page you’re testing and try again.'
                : reason === 'no_session'
                  ? 'Recording is not active. Start a recording before capturing evidence.'
                  : 'Couldn’t capture evidence. Try again in a moment.';
            setCaptureState('failed');
            setSessionNotice(humanMessage);
            window.setTimeout(() => setCaptureState('idle'), 1800);
            return;
          }
          setCaptureState('done');
          window.setTimeout(() => setCaptureState('idle'), 1200);
        },
      );
    });
  };

  const handlePauseResume = () => {
    if (isPauseToggling || isStopping || isCanceling) return;
    setIsPauseToggling(true);
    setSessionNotice('');

    chrome.runtime.sendMessage({ type: paused ? 'TT_RESUME' : 'TT_PAUSE' }, (response: unknown) => {
      setIsPauseToggling(false);
      const ok = isRec(response) && response['ok'] === true;
      if (chrome.runtime.lastError || !ok) {
        setSessionNotice(paused ? 'Could not resume recording. Try again.' : 'Could not pause recording. Try again.');
        return;
      }
      void refresh();
    });
  };

  const handleCancelRecording = () => {
    if (!activeSessionId) {
      handleStop();
      return;
    }
    setShowCancelConfirm(true);
  };

  const confirmCancelRecording = () => {
    if (isCanceling) return;
    if (!activeSessionId) {
      setShowCancelConfirm(false);
      handleStop();
      return;
    }

    setIsCanceling(true);
    setSessionNotice('');
    const sessionId = activeSessionId;
    chrome.runtime.sendMessage({ type: 'TT_SESSION_STOP' }, (stopResponse: unknown) => {
      if (chrome.runtime.lastError || !isRec(stopResponse) || stopResponse['type'] !== 'TT_SESSION_STOPPED') {
        setIsCanceling(false);
        setSessionNotice('Could not cancel recording cleanly. Try again.');
        return;
      }

      chrome.runtime.sendMessage({ type: 'TT_DELETE_SESSION', sessionId }, (deleteResponse: unknown) => {
        const deleted = isRec(deleteResponse) && deleteResponse['ok'] === true;
        setIsCanceling(false);
        if (!deleted) {
          setSessionNotice('Recording stopped, but cleanup failed. Remove this run from dashboard.');
          return;
        }
        setState('idle');
        setActiveSessionId(null);
        setPendingOrigins([]);
        setLiveSteps([]);
        setCaptureState('idle');
        setShowCancelConfirm(false);
      });
    });
  };

  const openMyAccount = () => openDashboard('dashboard', 'panel-header-account', 'account');

  const stepMetrics = useMemo(() => {
    const total = liveSteps.length;
    const settled = liveSteps.filter((step) => step.hasAfter || step.noAfterNeeded).length;
    const waiting = Math.max(total - settled, 0);
    const issues = liveSteps.filter((step) => step.hasHttp500 || step.hasConsoleError).length;
    return { total, settled, waiting, issues };
  }, [liveSteps]);

  const renderPanelHeader = () => (
    <div class="tt-header">
      <div class="tt-brand-lockup" aria-label="BusinessFlow">
        <img class="tt-brand-icon" src="../logo/Logo.png" alt="" aria-hidden="true" />
        <div class="tt-brand-copy">
          <strong>BusinessFlow</strong>
          <span>QA Recorder</span>
        </div>
      </div>
      <div class="tt-header-actions">
        <button class="btn-account" onClick={openMyAccount} aria-label="Open my account" title="My account">
          My account
        </button>
      </div>
    </div>
  );

  if (state === 'loading') {
    return (
      <div class="tt-card card loading-state-card" role="status" aria-live="polite">
        <div class="loading-dot" aria-hidden="true"></div>
        <p class="loading-copy">Loading BusinessFlow…</p>
      </div>
    );
  }

  return (
    <div class="tt-card card">
      {sessionNotice && <p class="err mb" role="status" aria-live="polite">{sessionNotice}</p>}
      {/* ── Unsupported page (chrome://, about:) ── */}
      {state === 'unsupported' && (
        <>
          {renderPanelHeader()}
          <div class="empty">
            <div class="empty-icon" aria-hidden="true">
              <svg viewBox="0 0 32 32" width="28" height="28" focusable="false">
                <circle cx="16" cy="16" r="13" fill="none" stroke="#1f3864" stroke-width="2" />
                <circle cx="16" cy="16" r="5" fill="#1f3864" />
              </svg>
            </div>
            <div class="empty-title">Not supported here</div>
            <p class="empty-sub">BusinessFlow can't record on <kbd>chrome://</kbd> pages or the New Tab. Open the web page you want to test in this window.</p>
          </div>
        </>
      )}

      {/* ── No permission for current tab's origin ── */}
      {state === 'no-permission' && (
        <>
          {renderPanelHeader()}
          <div class="empty">
            <div class="empty-icon" aria-hidden="true">
              <svg viewBox="0 0 32 32" width="28" height="28" focusable="false">
                <circle cx="16" cy="16" r="13" fill="none" stroke="#1f3864" stroke-width="2" />
                <circle cx="16" cy="16" r="5" fill="#1f3864" />
              </svg>
            </div>
            <div class="empty-title">Permission required</div>
            <p class="empty-sub">
              To capture evidence on this page, BusinessFlow needs temporary access while your test is running.
            </p>
            {currentOrigin && (
              <div class="origin-chip" style="margin: 4px auto 0">
                <span class="origin-dot" />
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{currentOrigin}</span>
              </div>
            )}
            <button class="btn-primary mt" onClick={handleAllow} aria-label="Allow site access for current origin">Allow access</button>
            <p class="hint">BusinessFlow captures only during active QA sessions, and exports are always manual.</p>
          </div>
        </>
      )}

      {/* ── Idle: start form ── */}
      {state === 'idle' && (
        <>
          {renderPanelHeader()}
          <div class="recording-status-strip recording-status-strip--idle" role="status" aria-live="polite">
            <span class="recording-status-strip__dot is-idle" aria-hidden="true" />
            <div class="recording-status-strip__copy">
              <strong>Not recording</strong>
              <span>Select a feature and test case, then start recording.</span>
            </div>
            <span class="recording-status-strip__timer">Ready</span>
          </div>

          <StartForm
            origin={currentOrigin}
            authStatus={authStatus}
            onStarted={refresh}
          />
        </>
      )}

      {/* ── Recording / Paused ── */}
      {(state === 'recording' || state === 'paused') && (
        <>
          {showCancelConfirm && (
            <div class="panel-modal-backdrop" role="presentation" onClick={() => (!isCanceling ? setShowCancelConfirm(false) : undefined)}>
              <div
                class="panel-modal"
                ref={cancelDialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="cancel-recording-title"
                aria-describedby="cancel-recording-body"
                onClick={(event) => event.stopPropagation()}
              >
                <div id="cancel-recording-title" class="panel-modal__title">Cancel recording?</div>
                <p id="cancel-recording-body" class="panel-modal__body">This will stop the current recording and remove all captured evidence from this run.</p>
                <div class="panel-modal__actions">
                  <button ref={keepRecordingButtonRef} class="btn btn-outline" onClick={() => setShowCancelConfirm(false)} disabled={isCanceling}>Keep recording</button>
                  <button class="btn btn-danger" onClick={confirmCancelRecording} disabled={isCanceling}>
                    {isCanceling ? 'Canceling…' : 'Cancel recording'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {renderPanelHeader()}

          <div class={`recording-status-strip ${isStopping || isCanceling ? 'recording-status-strip--stopping' : paused ? 'recording-status-strip--paused' : 'recording-status-strip--active'}`} role="status" aria-live="polite">
            <span class={`recording-status-strip__dot ${isStopping || isCanceling ? 'is-stopping' : paused ? 'is-paused' : 'is-active'}`} aria-hidden="true" />
            <div class="recording-status-strip__copy">
              <strong>{isStopping || isCanceling ? 'Finalizing recording…' : paused ? 'Recording paused' : 'Recording active'}</strong>
              <span>{isStopping || isCanceling ? 'Running deferred cleanup and preparing your dashboard report.' : paused ? 'Auto-capture is paused until you resume.' : 'Capturing evidence as you test this page.'}</span>
            </div>
            <span class="recording-status-strip__timer">{isStopping || isCanceling ? 'Finalizing…' : elapsed}</span>
          </div>

          <div class="recording-controls">
            <button
              class="rec-capture-btn"
              onClick={handleManualCapture}
              disabled={captureState === 'capturing' || isStopping || isCanceling || isPauseToggling}
              title="Manually capture current evidence as a new step"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M9 4.5c.35-.9 1.2-1.5 2.16-1.5h1.68c.96 0 1.81.6 2.16 1.5l.46 1.17H18A3 3 0 0 1 21 8.67v8.83a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8.67a3 3 0 0 1 3-3h2.54L9 4.5Zm3 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" fill="currentColor" />
              </svg>
              <span>{captureState === 'capturing' ? 'Capturing evidence…' : 'Capture Evidence'}</span>
            </button>
            <p class="rec-capture-support">Save a critical UI state instantly when you need explicit proof.</p>
            <div class={`rec-capture-feedback is-${captureState}`} role="status" aria-live="polite">
              {captureState === 'done'
                ? 'Evidence captured and attached to this recording run.'
                : captureState === 'failed'
                  ? 'Capture failed. Check site access and try again.'
                  : 'Automatic capture is active. Use this for moments you want guaranteed in the report.'}
            </div>

            <div class="rec-secondary-row">
              <button
                class="rec-secondary-btn"
                onClick={handlePauseResume}
                disabled={isPauseToggling || isStopping || isCanceling}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  {paused
                    ? <path d="M8 5.5v13l10-6.5-10-6.5Z" fill="currentColor" />
                    : <path d="M7 5h3v14H7V5Zm7 0h3v14h-3V5Z" fill="currentColor" />}
                </svg>
                <span>{isPauseToggling ? (paused ? 'Resuming…' : 'Pausing…') : (paused ? 'Resume recording' : 'Pause recording')}</span>
              </button>
              <button
                class="rec-secondary-btn rec-secondary-btn--danger"
                onClick={handleStop}
                disabled={isStopping || isCanceling || isPauseToggling}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M7 7h10v10H7V7Z" fill="currentColor" />
                </svg>
                <span>{isStopping ? 'Finalizing…' : 'Stop recording'}</span>
              </button>
            </div>

            <button
              class="rec-cancel-link"
              onClick={handleCancelRecording}
              disabled={isStopping || isCanceling || isPauseToggling}
            >
              {isCanceling ? 'Canceling…' : 'Cancel recording'}
            </button>
          </div>

          <section class="recording-meta" aria-label="Recording session status">
            <div class="recording-meta__grid">
              <div class="recording-meta__item">
                <span class="recording-meta__label">Steps captured</span>
                <strong>{stepMetrics.total}</strong>
              </div>
              <div class="recording-meta__item">
                <span class="recording-meta__label">Steps stabilized</span>
                <strong>{stepMetrics.settled}</strong>
              </div>
              <div class="recording-meta__item">
                <span class="recording-meta__label">Stabilizing</span>
                <strong>{stepMetrics.waiting}</strong>
              </div>
              <div class="recording-meta__item">
                <span class="recording-meta__label">Issues flagged</span>
                <strong>{stepMetrics.issues}</strong>
              </div>
            </div>

            {pendingOrigins.length > 0 ? (
              <div class="recording-meta__pending" role="status" aria-live="polite">
                <div class="recording-meta__pending-title">Site access needed for {pendingOrigins.length} new {pendingOrigins.length === 1 ? 'site' : 'sites'}.</div>
                {pendingOrigins.map((p) => (
                  <div key={p.origin} class="recording-meta__pending-row">
                    <span>{p.origin}</span>
                    <button class="recording-meta__allow" onClick={() => handleGrantOrigin(p)}>Allow</button>
                  </div>
                ))}
              </div>
            ) : (
              <div class="recording-meta__foot">BusinessFlow is currently scoped to: <span>{currentOrigin || 'this tab'}</span></div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

interface SearchCreateComboboxProps {
  inputId?: string;
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
  placeholder: string;
  requestPayload: Record<string, unknown> | null;
  disabled?: boolean;
}

function SearchCreateCombobox({
  inputId,
  value,
  onChange,
  onEnter,
  placeholder,
  requestPayload,
  disabled = false,
}: SearchCreateComboboxProps): JSX.Element {
  const [options, setOptions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  useEffect(() => {
    if (!requestPayload) {
      setOptions([]);
      return;
    }
    chrome.runtime.sendMessage(requestPayload, (resp: unknown) => {
      if (!Array.isArray(resp)) {
        setOptions([]);
        return;
      }
      const names = (resp as unknown[])
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
      setOptions([...new Set(names)]);
    });
  }, [requestPayload]);

  const query = value.trim();
  const filtered = useMemo(() => {
    if (!query) return options;
    const lower = query.toLowerCase();
    return options.filter((item) => item.toLowerCase().includes(lower));
  }, [options, query]);

  const hasExact = useMemo(
    () => options.some((item) => item.toLowerCase() === query.toLowerCase()),
    [options, query],
  );
  const showCreate = query.length > 0 && !hasExact;

  const selectValue = (next: string) => {
    onChange(next);
    setOpen(false);
    setActiveIndex(-1);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (disabled) return;
    const total = filtered.length + (showCreate ? 1 : 0);

    if (e.key === 'ArrowDown') {
      if (total === 0) return;
      e.preventDefault();
      setOpen(true);
      setActiveIndex((prev) => (prev + 1 + total) % total);
      return;
    }

    if (e.key === 'ArrowUp') {
      if (total === 0) return;
      e.preventDefault();
      setOpen(true);
      setActiveIndex((prev) => (prev - 1 + total) % total);
      return;
    }

    if (e.key === 'Enter') {
      if (open && total > 0 && activeIndex >= 0) {
        e.preventDefault();
        if (activeIndex < filtered.length) {
          selectValue(filtered[activeIndex] ?? query);
        } else if (showCreate) {
          selectValue(query);
        }
        return;
      }
      if (query) {
        e.preventDefault();
        selectValue(query);
      }
      onEnter();
      return;
    }

    if (e.key === 'Escape') {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  const listboxId = `${inputId ?? 'search-create'}-listbox`;
  const activeOptionId = activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined;

  return (
    <div class="dropdown-container">
      <input
        id={inputId}
        type="text"
        class="input-field"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open && (filtered.length > 0 || showCreate)}
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        aria-haspopup="listbox"
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onFocus={() => {
          if (!disabled) setOpen(true);
        }}
        onInput={(e) => {
          if (disabled) return;
          onChange((e.target as HTMLInputElement).value);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => handleKeyDown(e as KeyboardEvent)}
      />

      {!disabled && open && (filtered.length > 0 || showCreate) && (
        <div id={listboxId} class="dropdown-menu" role="listbox">
          {filtered.map((item, idx) => (
            <div
              id={`${listboxId}-option-${idx}`}
              key={item}
              class={`dropdown-item ${idx === activeIndex ? 'active' : ''}`}
              role="option"
              aria-selected={idx === activeIndex}
              onMouseDown={(e) => {
                e.preventDefault();
                selectValue(item);
              }}
            >
              {item}
            </div>
          ))}
          {showCreate && (
            <div
              id={`${listboxId}-option-${filtered.length}`}
              class={`dropdown-item dropdown-item-create ${activeIndex === filtered.length ? 'active' : ''}`}
              role="option"
              aria-selected={activeIndex === filtered.length}
              onMouseDown={(e) => {
                e.preventDefault();
                selectValue(query);
              }}
            >
              Create {query}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface StartFormProps {
  origin: string;
  authStatus: AuthStatusPayload | null;
  onStarted: () => void;
}

function StartForm({ origin, authStatus, onStarted }: StartFormProps): JSX.Element {
  const [featureName, setFeatureName] = useState('');
  const [testCaseName, setTestCaseName] = useState('');
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [maxRunsPerTestCase, setMaxRunsPerTestCase] = useState(10);
  const [existingRunCount, setExistingRunCount] = useState(0);
  const [showRunRetentionPrompt, setShowRunRetentionPrompt] = useState(false);
  const skipTestCaseResetRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { prefillFeature, prefillTestCase } = await chrome.storage.local.get(['prefillFeature', 'prefillTestCase']);
      if (cancelled) return;

      const nextFeature = typeof prefillFeature === 'string' ? prefillFeature.trim() : '';
      const nextTestCase = typeof prefillTestCase === 'string' ? prefillTestCase.trim() : '';
      if (!nextFeature || !nextTestCase) return;

      skipTestCaseResetRef.current = true;
      setFeatureName(nextFeature);
      setTestCaseName(nextTestCase);
      await chrome.storage.local.remove(['prefillFeature', 'prefillTestCase']);
    })();

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (featureName.trim()) return;
      const sessions = await getAllSessions();
      const latestFeature = sessions[0]?.featureName?.trim();
      if (!cancelled && latestFeature) setFeatureName(latestFeature);
    })();
    return () => { cancelled = true; };
  }, [featureName]);

  useEffect(() => {
    if (skipTestCaseResetRef.current) {
      skipTestCaseResetRef.current = false;
      return;
    }
    setTestCaseName('');
  }, [featureName]);

  useEffect(() => {
    void getSettings()
      .then((settings) => setMaxRunsPerTestCase(Math.max(2, Math.min(15, Math.round(settings.maxRunsPerTestCase ?? 10)))))
      .catch(() => setMaxRunsPerTestCase(10));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const feature = featureName.trim().toLowerCase();
      const testCase = testCaseName.trim().toLowerCase();
      if (!feature || !testCase) {
        if (!cancelled) setExistingRunCount(0);
        return;
      }

      const sessions = await getAllSessions();
      const count = sessions
        .filter((session) => (session.featureName?.trim().toLowerCase() ?? '') === feature)
        .filter((session) => (session.testCaseName?.trim().toLowerCase() ?? '') === testCase)
        .length;

      if (!cancelled) setExistingRunCount(count);
    })();

    return () => { cancelled = true; };
  }, [featureName, testCaseName]);

  const canStart = Boolean(featureName.trim() && testCaseName.trim());
  const willReplaceOldestRun = canStart && existingRunCount >= maxRunsPerTestCase;
  const featureRequestPayload = useMemo(() => ({ type: 'TT_GET_FEATURES' }), []);
  const testCaseRequestPayload = useMemo(
    () => (featureName.trim() ? { type: 'TT_GET_TEST_CASES', featureName: featureName.trim() } : null),
    [featureName],
  );

  const handleOpenDashboard = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('ui/dashboard/dashboard.html') });
  };

  const ensureCapturePermissions = async (): Promise<boolean> => ensureCaptureAccessForOrigin(origin);

  const performSessionStart = async (): Promise<void> => {
    if (starting) return;
    const feature = featureName.trim();
    const testCase = testCaseName.trim();

    setStarting(true);
    setError('');

    const permissionGranted = await ensureCapturePermissions();
    if (!permissionGranted) {
      setStarting(false);
      setError('BusinessFlow needs site access to record this page. Update Site access in Chrome extension settings, then try again.');
      return;
    }

    chrome.runtime.sendMessage({
      type: 'TT_SESSION_START',
      mode: 'guided' as const,
      featureName: feature,
      testCaseName: testCase,
      negativeTest: 'unknown' as const,
      scopeOrigins: [origin],
      permissionAlreadyGranted: true,
    }, (r: unknown) => {
      setStarting(false);
      if (!isRec(r)) {
        setError('Could not start recording. Reload the extension and try again.');
        return;
      }
      const resp = r as Record<string, unknown>;
      if (resp['type'] === 'TT_SESSION_START_ERR') {
        const errText = String(resp['error'] ?? 'Failed');
        setError(errText === 'Permission denied'
          ? 'BusinessFlow needs site access to record this page. Update Site access in Chrome extension settings, then try again.'
          : errText);
        return;
      }
      onStarted();
    });
  };

  const handleStart = async (): Promise<void> => {
    if (starting) return;
    const feature = featureName.trim();
    const testCase = testCaseName.trim();

    if (!feature) {
      setError('Feature name is required.');
      return;
    }
    if (!testCase) {
      setError('Test case name is required.');
      return;
    }

    if (willReplaceOldestRun) {
      setShowRunRetentionPrompt(true);
      return;
    }

    await performSessionStart();
  };

  return (
    <>
      {showRunRetentionPrompt && (
        <div class="panel-modal-backdrop" role="presentation" onClick={() => (!starting ? setShowRunRetentionPrompt(false) : undefined)}>
          <div
            class="panel-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="run-retention-title"
            aria-describedby="run-retention-body"
            onClick={(event) => event.stopPropagation()}
          >
            <div id="run-retention-title" class="panel-modal__title">Run limit reached</div>
            <p id="run-retention-body" class="panel-modal__body">
              This test case already has {existingRunCount} runs. Starting a new recording will delete the oldest run to keep the latest {maxRunsPerTestCase} runs.
            </p>
            <div class="panel-modal__actions">
              <button class="btn btn-outline" onClick={() => setShowRunRetentionPrompt(false)} disabled={starting}>Review first</button>
              <button
                class="btn btn-primary"
                disabled={starting}
                onClick={() => {
                  setShowRunRetentionPrompt(false);
                  void performSessionStart();
                }}
              >
                {starting ? 'Starting…' : 'Start and replace oldest run'}
              </button>
            </div>
          </div>
        </div>
      )}

      <form
        class="card"
        onSubmit={(e) => {
          e.preventDefault();
          void handleStart();
        }}
      >
        <div class="form-group">
          <label class="form-label" for="feature-name">Feature</label>
          <SearchCreateCombobox
            inputId="feature-name"
            value={featureName}
            onChange={setFeatureName}
            onEnter={() => { void handleStart(); }}
            placeholder="Search or create a feature"
            requestPayload={featureRequestPayload}
          />
        </div>

        <div class="form-group">
          <label class="form-label" for="test-case-name">Test Case</label>
          <SearchCreateCombobox
            inputId="test-case-name"
            value={testCaseName}
            onChange={setTestCaseName}
            onEnter={() => { void handleStart(); }}
            placeholder={featureName.trim() ? 'Search, retest, or create a test case' : 'Select a feature first'}
            requestPayload={testCaseRequestPayload}
            disabled={!featureName.trim()}
          />
        </div>

        {willReplaceOldestRun && (
          <div class="retention-warning">
            <strong>Heads up:</strong> this retest will remove the oldest run and keep the latest {maxRunsPerTestCase} runs.
          </div>
        )}

        <div class="origin-chip mb">
          <span class="origin-dot" />
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.8rem">{origin || 'current page'}</span>
        </div>

        {error && <p class="err mb">{error}</p>}

        <button type="submit" class="btn btn-primary" style="width: 100%" disabled={starting || !canStart}>
          {starting ? 'Starting…' : 'Start recording'}
        </button>

        <button
          type="button"
          class="btn btn-secondary"
          style="width: 100%; margin-top: 8px"
          onClick={handleOpenDashboard}
        >
          <span class="btn-secondary__content">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14V3ZM5 5h6v2H7v10h10v-4h2v6H5V5Z" fill="currentColor" />
            </svg>
            <span>Open dashboard</span>
          </span>
        </button>
      </form>
    </>
  );
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const root = document.getElementById('root');
if (root) render(<App />, root);
