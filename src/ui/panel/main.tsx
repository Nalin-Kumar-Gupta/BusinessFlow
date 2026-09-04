// BusinessFlow Side Panel — primary control surface.
// Replaces the popup. Persistent, resizable, always-on-tab UI.
// Reads active session state from the background service worker via
// chrome.runtime messages, and reacts to chrome.storage changes so the UI
// updates without polling when pending origins are discovered mid-session.

import { render } from 'preact';
import { useState, useEffect, useCallback, useMemo, useRef } from 'preact/hooks';
import type { JSX } from 'preact/jsx-runtime';
import type { Step, EvidenceStoredEvent } from '../../core/types.js';
import type { AuthStatusPayload } from '../../core/auth.js';
import { extractOrigin, originToPattern } from '../../core/url.js';
import { getAllSessions, getBlob, getEventsForSession, getStepsForSession } from '../../storage/db.js';
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
  title: string;
  ts: number;
  beforeThumbUrl?: string;
  afterThumbUrl?: string;
  hasBefore: boolean;
  hasAfter: boolean;
  noAfterNeeded: boolean;
  transitionBadge?: string;
  hasHttp500: boolean;
  hasConsoleError: boolean;
  note?: string;
}

function buildTransitionBadge(beforeUrl: string | undefined, afterUrl: string | undefined): string | undefined {
  if (!beforeUrl || !afterUrl) return undefined;
  try {
    const before = new URL(beforeUrl);
    const after = new URL(afterUrl);
    if (before.origin !== after.origin) {
      return `Origin changed: ${before.host} -> ${after.host}`;
    }
    const beforePath = `${before.pathname}${before.search}${before.hash}`;
    const afterPath = `${after.pathname}${after.search}${after.hash}`;
    if (beforePath !== afterPath) {
      return `Navigated: ${beforePath || '/'} -> ${afterPath || '/'}`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// Keys that session-state.ts writes to chrome.storage.local. When these
// change we re-pull status so the panel stays live without polling.
const REACTIVE_STORAGE_KEYS = new Set([
  'tt:activeSessionId',
  'tt:paused',
  'tt:pendingOrigins',
  'tt:sessionStartedAt',
]);

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
  const thumbUrlRef = useRef(new Map<string, string>());

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

  const cleanupThumbUrls = useCallback(() => {
    for (const url of thumbUrlRef.current.values()) URL.revokeObjectURL(url);
    thumbUrlRef.current.clear();
  }, []);

  const buildStepTitle = (step: Step): string => {
    const base = step.labelOverride?.trim() || step.label.trim();
    if (!base) return `Click step ${step.index}`;
    return base.startsWith('Clicked ') ? `Click ${base.slice('Clicked '.length)}` : `Click ${base}`;
  };

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
      const beforeEv = step.beforeEvidenceEventId ? storedById.get(step.beforeEvidenceEventId) : undefined;

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

      let beforeThumbUrl: string | undefined;
      if (beforeEv?.blobKey) {
        const cacheKey = beforeEv.id;
        const existing = thumbUrlRef.current.get(cacheKey);
        if (existing) {
          beforeThumbUrl = existing;
        } else {
          const blobRecord = await getBlob(beforeEv.blobKey);
          if (blobRecord) {
            const arr = blobRecord.data;
            const copied = new Uint8Array(new ArrayBuffer(arr.byteLength));
            copied.set(arr);
            const blob = new Blob([copied], { type: blobRecord.mimeType });
            beforeThumbUrl = URL.createObjectURL(blob);
            thumbUrlRef.current.set(cacheKey, beforeThumbUrl);
          }
        }
      }

      let afterThumbUrl: string | undefined;
      if (afterEv?.blobKey) {
        const cacheKey = afterEv.id;
        const existing = thumbUrlRef.current.get(cacheKey);
        if (existing) {
          afterThumbUrl = existing;
        } else {
          const blobRecord = await getBlob(afterEv.blobKey);
          if (blobRecord) {
            const arr = blobRecord.data;
            const copied = new Uint8Array(new ArrayBuffer(arr.byteLength));
            copied.set(arr);
            const blob = new Blob([copied], { type: blobRecord.mimeType });
            afterThumbUrl = URL.createObjectURL(blob);
            thumbUrlRef.current.set(cacheKey, afterThumbUrl);
          }
        }
      }

      const beforeUrl = beforeEv?.pageUrl ?? step.pageUrl;
      const afterUrl = afterEv?.pageUrl;
      const transitionBadge = buildTransitionBadge(beforeUrl, afterUrl);

      cards.push({
        id: step.id,
        index: step.index,
        title: buildStepTitle(step),
        ts: step.ts,
        beforeThumbUrl,
        afterThumbUrl,
        hasBefore: Boolean(step.beforeEvidenceEventId),
        hasAfter: Boolean(step.afterEvidenceEventId),
        noAfterNeeded: Boolean(step.noChangeDetected && !step.afterEvidenceEventId),
        transitionBadge,
        hasHttp500,
        hasConsoleError,
        note: step.note,
      });
    }

    // Revoke URLs for evidence events that are no longer referenced by any live step.
    // Cache keys are evidenceEventIds, so build the keep-set from live steps'
    // before + after evidence IDs.
    const keepEvidenceIds = new Set<string>();
    for (const step of recent) {
      if (step.beforeEvidenceEventId) keepEvidenceIds.add(step.beforeEvidenceEventId);
      if (step.afterEvidenceEventId) keepEvidenceIds.add(step.afterEvidenceEventId);
    }
    for (const [evidenceId, url] of thumbUrlRef.current.entries()) {
      if (keepEvidenceIds.has(evidenceId)) continue;
      URL.revokeObjectURL(url);
      thumbUrlRef.current.delete(evidenceId);
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

      // No active session — check whether we have permission for the current tab's origin
      chrome.permissions.contains({ origins: [originToPattern(origin)] }, (has) => {
        setActiveSessionId(null);
        cleanupThumbUrls();
        setLiveSteps([]);
        setState(has ? 'idle' : 'no-permission');
        setSessionNotice('');
        setPendingOrigins([]);
        setSessionStartMs(0);
      });
    });
  }, []);

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

  // Live step-feed updates from background.
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

  useEffect(() => {
    return () => cleanupThumbUrls();
  }, [cleanupThumbUrls]);

  const handleAllow = () => {
    chrome.permissions.request({ origins: [originToPattern(currentOrigin)] }, (granted) => {
      if (granted) setState('idle');
    });
  };


  // Grant permission for a new origin found mid-session. chrome.permissions.request()
  // MUST be called from the side panel / popup (user gesture).
  const handleGrantOrigin = (pending: PendingOriginInfo) => {
    chrome.permissions.request({ origins: [originToPattern(pending.origin)] }, (granted) => {
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
        setSessionNotice('Could not stop recording cleanly. Reload extension and verify run state in dashboard.');
        return;
      }

      if (!isRec(response) || response['type'] !== 'TT_SESSION_STOPPED') {
        setSessionNotice('Stop recording failed. Please try again.');
        return;
      }

      const warnings = Array.isArray(response['warnings'])
        ? (response['warnings'] as unknown[]).filter((item): item is string => typeof item === 'string')
        : [];

      setState('idle');
      setActiveSessionId(null);
      setPendingOrigins([]);
      setLiveSteps([]);
      setCaptureState('idle');
      if (warnings.length > 0) {
        setSessionNotice(warnings[0] ?? 'Recording stopped with warnings. Review dashboard before sharing.');
      }
    });
  };

  const handleManualCapture = () => {
    if (captureState === 'capturing') return;
    setCaptureState('capturing');
    setSessionNotice('');

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
              : 'capture_failed';
            setCaptureState('failed');
            setSessionNotice(`Couldn’t capture evidence (${reason}).`);
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

  const openSettings = () => chrome.runtime.openOptionsPage();

  const renderAuthStrip = (): JSX.Element => {
    const state = authStatus?.state ?? 'checking_access';
    const title = state === 'signed_out'
      ? 'Signed out'
      : state === 'signed_in'
        ? 'Signed in'
        : state === 'checking_access'
          ? 'Checking access'
          : state === 'access_active'
            ? 'Access active'
            : state === 'session_expired'
              ? 'Session expired'
              : 'Access unavailable';

    const tone = state === 'access_active'
      ? 'is-good'
      : state === 'checking_access' || state === 'signed_in'
        ? 'is-neutral'
        : state === 'signed_out'
          ? 'is-muted'
          : 'is-warn';

    return (
      <div class={`account-status-strip ${tone}`} role="status" aria-live="polite">
        <span class="account-status-strip__dot" aria-hidden="true" />
        <div class="account-status-strip__copy">
          <strong>{title}</strong>
          <span>{authStatus?.message ?? 'Validating entitlement with backend.'}</span>
        </div>
        <span class="account-status-strip__plan">{authStatus?.entitlement?.plan ?? 'n/a'}</span>
      </div>
    );
  };

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
      {renderAuthStrip()}
      {/* ── Unsupported page (chrome://, about:) ── */}
      {state === 'unsupported' && (
        <>
          <div class="tt-header">
            <img class="tt-brand-icon" src="../logo/Logo.png" alt="BusinessFlow" />
          </div>
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
          <div class="tt-header">
            <img class="tt-brand-icon" src="../logo/Logo.png" alt="BusinessFlow" />
          </div>
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
          <div class="tt-header">
            <div>
              <img class="tt-brand-wordmark" src="../logo/Brand_Name.png" alt="BusinessFlow" />
            </div>
            <div class="tt-header-actions">
              <button class="btn-icon" onClick={openSettings} aria-label="Open settings" title="Settings">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M19.14 12.94a7.2 7.2 0 0 0 .05-.94 7.2 7.2 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.3 7.3 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.49-.42h-3.84a.5.5 0 0 0-.49.42l-.36 2.54a7.3 7.3 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.7 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.2 7.2 0 0 0-.05.94c0 .32.02.63.05.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.38 1.05.7 1.63.94l.36 2.54a.5.5 0 0 0 .49.42h3.84a.5.5 0 0 0 .49-.42l.36-2.54c.58-.24 1.13-.56 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z" fill="currentColor" />
                </svg>
              </button>
            </div>
          </div>
          <div class="recording-status-strip recording-status-strip--idle" role="status" aria-live="polite">
            <span class="recording-status-strip__dot is-idle" aria-hidden="true" />
            <div class="recording-status-strip__copy">
              <strong>Not recording</strong>
              <span>Set feature + test case, then start when you’re ready.</span>
            </div>
            <span class="recording-status-strip__timer">Ready</span>
          </div>

          <StartForm origin={currentOrigin} onStarted={refresh} />
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

          <div class="tt-header tt-header--recording">
            <div>
              <img class="tt-brand-wordmark" src="../logo/Brand_Name.png" alt="BusinessFlow" />
            </div>
            <div class="tt-header-actions">
              <button class="btn-icon" onClick={openSettings} aria-label="Open settings" title="Settings">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M19.14 12.94a7.2 7.2 0 0 0 .05-.94 7.2 7.2 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.3 7.3 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.49-.42h-3.84a.5.5 0 0 0-.49.42l-.36 2.54a7.3 7.3 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.7 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.2 7.2 0 0 0-.05.94c0 .32.02.63.05.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.38 1.05.7 1.63.94l.36 2.54a.5.5 0 0 0 .49.42h3.84a.5.5 0 0 0 .49-.42l.36-2.54c.58-.24 1.13-.56 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z" fill="currentColor" />
                </svg>
              </button>
            </div>
          </div>

          <div class={`recording-status-strip ${isStopping || isCanceling ? 'recording-status-strip--stopping' : paused ? 'recording-status-strip--paused' : 'recording-status-strip--active'}`} role="status" aria-live="polite">
            <span class={`recording-status-strip__dot ${isStopping || isCanceling ? 'is-stopping' : paused ? 'is-paused' : 'is-active'}`} aria-hidden="true" />
            <div class="recording-status-strip__copy">
              <strong>{isStopping || isCanceling ? 'Finishing recording…' : paused ? 'Recording paused' : 'Recording active'}</strong>
              <span>{isStopping || isCanceling ? 'Saving run data and final evidence.' : paused ? 'Auto-capture is paused until you resume.' : 'Capturing evidence as you test this page.'}</span>
            </div>
            <span class="recording-status-strip__timer">{isStopping || isCanceling ? 'Saving…' : elapsed}</span>
          </div>

          {pendingOrigins.length > 0 && (
            <div class="pending-block">
              <div class="pending-title">New site{pendingOrigins.length > 1 ? 's' : ''} found in this run</div>
              {pendingOrigins.map((p) => (
                <div key={p.origin} class="pending-row">
                  <span class="pending-origin">{p.origin}</span>
                  <button class="pending-btn" onClick={() => handleGrantOrigin(p)}>Allow this site</button>
                </div>
              ))}
            </div>
          )}

          <div class="step-feed">
            <div class="step-feed__head">Live evidence</div>
            <div class="step-feed__list">
              {liveSteps.length === 0 && (
                <div class="step-feed__empty">Interact with the page to capture your first step.</div>
              )}
              {liveSteps.map((step) => (
                <div key={step.id} class="step-card card">
                  <div class="step-card__row">
                    <div class="step-card__title">{step.title}</div>
                    <div class="step-card__index">#{step.index}</div>
                  </div>
                  <div class="step-card__meta">
                    {step.hasAfter
                      ? 'After screenshot saved'
                      : step.noAfterNeeded
                        ? 'No visible page transition — after screenshot skipped'
                        : 'Waiting for stable after screenshot…'}
                  </div>
                  <div class="step-card__footer">
                    {step.hasBefore && step.hasAfter ? (
                      <div class="step-card__pair" aria-label="Before and after evidence">
                        <div class="step-card__frame">
                          <div class="step-card__frame-label">[ BEFORE ]</div>
                          {step.beforeThumbUrl
                            ? <img src={step.beforeThumbUrl} alt="Before evidence thumbnail" class="step-card__thumb screenshot-thumb" />
                            : <div class="step-card__thumb step-card__thumb--empty">No image</div>}
                        </div>
                        <div class="step-card__pair-arrow" aria-hidden="true"></div>
                        <div class="step-card__frame">
                          <div class="step-card__frame-label">[ AFTER ]</div>
                          {step.afterThumbUrl
                            ? <img src={step.afterThumbUrl} alt="After evidence thumbnail" class="step-card__thumb screenshot-thumb" />
                            : <div class="step-card__thumb step-card__thumb--empty">No image</div>}
                        </div>
                      </div>
                    ) : (
                      <div class="step-card__frame step-card__frame--single">
                        <div class="step-card__frame-label">[ BEFORE ]</div>
                        {step.beforeThumbUrl
                          ? <img src={step.beforeThumbUrl} alt="Before evidence thumbnail" class="step-card__thumb screenshot-thumb" />
                          : <div class="step-card__thumb step-card__thumb--empty">No image</div>}
                      </div>
                    )}
                    <div class="step-card__badges">
                      {step.hasHttp500 && <span class="step-badge step-badge--err badge badge-danger">HTTP 500</span>}
                      {step.hasConsoleError && <span class="step-badge step-badge--warn badge badge-danger">Console error</span>}
                    </div>
                  </div>
                  {step.hasBefore && step.hasAfter && step.transitionBadge && (
                    <div class="step-transition-badge badge">{step.transitionBadge}</div>
                  )}
                  {step.note && <div class="step-card__saved-note"> {step.note}</div>}
                </div>
              ))}
            </div>
          </div>

          <div class="recording-controls card">
            <div class="recording-controls__head">
              <div class="recording-controls__title">Manual evidence capture</div>
              <div class="recording-controls__hint">Use Capture Evidence when you want to intentionally save proof for this exact moment.</div>
            </div>
            <div class="recording-controls__actions recording-controls__actions--stacked">
              <button
                class="btn-pill btn-pill--capture btn btn-primary btn-pill--big"
                onClick={handleManualCapture}
                disabled={captureState === 'capturing' || isStopping || isCanceling || isPauseToggling}
                title="Manually capture current evidence as a new step"
              >
                <span class="recording-controls__btn-content">
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M9 4.5c.35-.9 1.2-1.5 2.16-1.5h1.68c.96 0 1.81.6 2.16 1.5l.46 1.17H18A3 3 0 0 1 21 8.67v8.83a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8.67a3 3 0 0 1 3-3h2.54L9 4.5Zm3 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" fill="currentColor" />
                  </svg>
                  <span>{captureState === 'capturing' ? 'Capturing evidence...' : 'Capture Evidence'}</span>
                </span>
              </button>
              <div class={`recording-controls__capture-feedback ${captureState}`} role="status" aria-live="polite">
                {captureState === 'done'
                  ? 'Evidence captured and saved to this run.'
                  : captureState === 'failed'
                    ? 'Capture failed. Try again in a moment.'
                    : 'BusinessFlow auto-captures while you test. This adds a manual evidence step.'}
              </div>
              <div class="recording-controls__secondary">
                <button class="btn-pill btn-pill--secondary btn" onClick={handlePauseResume} disabled={isPauseToggling || isStopping || isCanceling}>
                  <span class="recording-controls__btn-content">
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      {paused
                        ? <path d="M8 5.5v13l10-6.5-10-6.5Z" fill="currentColor" />
                        : <path d="M7 5h3v14H7V5Zm7 0h3v14h-3V5Z" fill="currentColor" />}
                    </svg>
                    <span>{isPauseToggling ? (paused ? 'Resuming...' : 'Pausing...') : (paused ? 'Resume' : 'Pause')}</span>
                  </span>
                </button>
                <button class="btn-pill btn-pill--stop btn" onClick={handleStop} disabled={isStopping || isCanceling || isPauseToggling}>
                  <span class="recording-controls__btn-content">
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path d="M7 7h10v10H7V7Z" fill="currentColor" />
                    </svg>
                    <span>{isStopping ? 'Stopping...' : 'Stop recording'}</span>
                  </span>
                </button>
                <button class="btn-pill btn-pill--danger btn" onClick={handleCancelRecording} disabled={isStopping || isCanceling || isPauseToggling}>
                  <span class="recording-controls__btn-content">
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path d="M6 7h12l-1 13H7L6 7Zm3-3h6l1 2H8l1-2Z" fill="currentColor" />
                    </svg>
                    <span>{isCanceling ? 'Canceling...' : 'Cancel recording'}</span>
                  </span>
                </button>
              </div>
            </div>
          </div>

          <p class="helper-text">
            {paused
              ? 'Recording is paused. Resume when you want auto-capture back on.'
              : 'Recording is active. Interactions on the page are captured automatically.'}
          </p>
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

function StartForm({ origin, onStarted }: { origin: string; onStarted: () => void }): JSX.Element {
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

  const performSessionStart = async (): Promise<void> => {
    if (starting) return;
    const feature = featureName.trim();
    const testCase = testCaseName.trim();

    setStarting(true);
    setError('');

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
          ? 'Permission denied — grant site access to BusinessFlow and try again.'
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
      setError('Feature is required');
      return;
    }
    if (!testCase) {
      setError('Test case name is required');
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
                {starting ? 'Starting…' : 'Continue and replace oldest run'}
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
