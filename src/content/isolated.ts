// Isolated world content script.
// Compiled as IIFE - self-contained, no dynamic imports.
//
// Surface A - Tiny in-page recorder:
//   Small fixed pill in the bottom-right showing a pulsing red dot,
//   "Recording active", and a Pause/Resume button. That is IT.
//   All start/stop/settings/session-management lives in the Chrome side panel.
//
// Also owns:
//   - page-observers (clicks, mutations, intersection, rage-clicks, DOM metrics)
//   - step-engine (deterministic stabilise -> capture)
//   - overlay hide/show cycle around screenshot capture (P0 invariant)
//   - scroll-to-component helper for the screenshot pipeline
//   - CSP-violation forwarding
//
// NEVER reads input values, passwords, or any typed content.

import { createPageObservers } from './page-observers.js';
import { createStepEngine } from './step-engine.js';
import { getIndicatorHost, mountIndicator, setIndicatorMode, unmountIndicator } from './indicator.js';

(function () {
  'use strict';

  // Guard: content scripts can be re-injected when a tab navigates.
  const win = window as Window & {
    __tt_injected__?: boolean;
    __tt_guard_version__?: string;
  };
  if (win.__tt_injected__) return;
  win.__tt_injected__ = true;
  win.__tt_guard_version__ = 'ctx-guard-2026-08-30-4';
  console.info('[TestTrace] isolated injected', { guardVersion: win.__tt_guard_version__, href: location.href });

  const isTopFrame = window.top === window;

  // ---- State ---------------------------------------------------------------

  let _active = false;
  let _sessionId: string | null = null;
  let _contextInvalidated = false;

  const _pageObservers = createPageObservers({
    isActive: () => _active,
    getSessionId: () => _sessionId,
    openObservationWindow,
    suppressAutoCapture,
  });
  const _stepEngine = createStepEngine({ isActive: () => _active });

  // Overlay hide/restore bookkeeping
  const _overlayPrevVisibility = new Map<HTMLElement, string>();


  // ---- Listener registration ----------------------------------------------

  // Defensive multi-listener strategy: some UI libraries (React Aria, Radix,
  // shadcn Slot, MUI base) call preventDefault() on pointerdown, which suppresses
  // the browser's mousedown emulation. Others block mousedown but let click
  // through. We listen to all three phases and dedupe within a 150ms window —
  // one physical click never spans that window; two distinct clicks always exceed
  // it (human motor limit). This guarantees we capture every real interaction.
  let _lastHandledClickTs = 0;
  let _lastHandledTarget: EventTarget | null = null;
  const CLICK_SEQUENCE_DEDUP_MS = 120;

  function onInteraction(e: MouseEvent, source: string): void {
    if (_contextInvalidated) return;
    const now = performance.now();
    // Dedupe duplicate listener phases for the same physical click, but allow
    // rapid consecutive clicks when the target changed (dropdown open -> option).
    if (now - _lastHandledClickTs < CLICK_SEQUENCE_DEDUP_MS && e.target === _lastHandledTarget) return;
    _lastHandledClickTs = now;
    _lastHandledTarget = e.target;
    console.log('[TestTrace] interaction fired via', source, e.target);
    try {
      handleClick(e);
    } catch (err) {
      markContextInvalidated(err, `document-${source}-listener`);
    }
  }

  function onDocumentPointerdown(e: PointerEvent): void { onInteraction(e, 'pointerdown'); }
  function onDocumentMousedown(e: MouseEvent): void { onInteraction(e, 'mousedown'); }
  function onDocumentClick(e: MouseEvent): void { onInteraction(e, 'click'); }

  function onDocumentChange(e: Event): void {
    if (_contextInvalidated) return;
    try {
      _pageObservers.handleChange(e);
    } catch (err) {
      markContextInvalidated(err, 'document-change-listener');
    }
  }


  chrome.runtime.onMessage.addListener(handleMessage);
  document.addEventListener('pointerdown', onDocumentPointerdown, { capture: true, passive: true });
  document.addEventListener('mousedown', onDocumentMousedown, { capture: true, passive: true });
  document.addEventListener('click', onDocumentClick, { capture: true, passive: true });
  document.addEventListener('change', onDocumentChange, { capture: true, passive: true });

  function isContextInvalidatedError(err: unknown): boolean {
    return String(err).toLowerCase().includes('extension context invalidated');
  }

  function markContextInvalidated(err: unknown, source: string): void {
    if (!isContextInvalidatedError(err)) return;
    if (_contextInvalidated) return;
    _contextInvalidated = true;
    _active = false;
    _sessionId = null;
    try { chrome.runtime.onMessage.removeListener(handleMessage); } catch {}
    try { document.removeEventListener('pointerdown', onDocumentPointerdown, true); } catch {}
    try { document.removeEventListener('mousedown', onDocumentMousedown, true); } catch {}
    try { document.removeEventListener('click', onDocumentClick, true); } catch {}
    try { document.removeEventListener('change', onDocumentChange, true); } catch {}
    try { _pageObservers.detachMutationObserver(); } catch {}
    try { _pageObservers.detachIntersectionObserver(); } catch {}
    try { _stepEngine.destroy(); } catch {}
    unmountIndicator();
    console.warn('[TestTrace] extension context invalidated; disabled content handlers', { source });
  }

  function safeRuntimeSendMessage(message: Record<string, unknown>): Promise<unknown | null> {
    if (_contextInvalidated) return Promise.resolve(null);
    try {
      return chrome.runtime.sendMessage(message)
        .then((resp) => resp)
        .catch((err) => {
          markContextInvalidated(err, `send:${String(message['type'] ?? 'unknown')}`);
          return null;
        });
    } catch (err) {
      markContextInvalidated(err, `send-sync:${String(message['type'] ?? 'unknown')}`);
      return Promise.resolve(null);
    }
  }

  document.addEventListener('securitypolicyviolation', (e: SecurityPolicyViolationEvent) => {
    if (!_active) return;
    void safeRuntimeSendMessage({
      type: 'TT_CONTENT_EVENT',
      event: {
        kind: 'csp_violation',
        violatedDirective: e.violatedDirective,
        blockedURI: e.blockedURI,
        originalPolicy: e.originalPolicy.slice(0, 300),
        pageUrl: location.href,
      },
    });
  });

  function handleMessage(msg: unknown, _sender: unknown, sendResponse: (r?: unknown) => void): boolean | undefined {
    if (!isRec(msg)) return;
    const type = msg['type'];

    if (type === 'TT_CONTENT_ACTIVATE') {
      _sessionId = (msg['sessionId'] as string) ?? null;
      activate();
      return undefined;
    }

    if (type === 'TT_SESSION_STARTED') {
      _sessionId = (msg['sessionId'] as string) ?? _sessionId;
      activate();
      return undefined;
    }

    if (type === 'TT_CONTENT_DEACTIVATE') {
      deactivate();
      return undefined;
    }

    if (type === 'TT_SESSION_STOPPED') {
      deactivate();
      return undefined;
    }

    if (type === 'TT_CONTENT_PAUSE') {
      setIndicatorMode('paused');
      return undefined;
    }

    if (type === 'TT_CONTENT_RESUME') {
      setIndicatorMode('recording');
      return undefined;
    }

    if (type === 'TT_HIDE_OVERLAY') {
      // P0: hide every scrap of TestTrace UI before captureVisibleTab fires
      _pageObservers.hideOverlay();
      if (isTopFrame) _stepEngine.hideOverlay();
      hideExtensionUiForCapture();
      return undefined;
    }

    if (type === 'TT_SHOW_OVERLAY') {
      _pageObservers.showOverlay();
      if (isTopFrame) _stepEngine.showOverlay();
      restoreExtensionUiAfterCapture();
      return undefined;
    }

    if (type === 'TT_SCROLL_TO_COMPONENT') {
      const componentName = msg['componentName'] as string;
      const result = _pageObservers.scrollToComponent(componentName);
      sendResponse({ ok: result.scrolled, originalScrollY: result.originalScrollY });
      return true;
    }

    if (type === 'TT_CAPTURE_DEBUG') {
      console.log('[TestTrace] capture-debug', msg['payload']);
      return undefined;
    }

    return undefined;
  }

  // ---- Overlay hide/restore (P0: floater must never appear in screenshots)

  function setUiElementHidden(el: HTMLElement | null): void {
    if (!el) return;
    if (!_overlayPrevVisibility.has(el)) {
      _overlayPrevVisibility.set(el, el.style.visibility);
    }
    el.style.visibility = 'hidden';
  }

  function hideExtensionUiForCapture(): void {
    setUiElementHidden(getIndicatorHost());
  }

  function restoreExtensionUiAfterCapture(): void {
    for (const [el, prev] of _overlayPrevVisibility.entries()) {
      el.style.visibility = prev;
    }
    _overlayPrevVisibility.clear();
  }

  // ---- Lifecycle -----------------------------------------------------------

  function activate(): void {
    if (_active) {
      if (isTopFrame) {
        mountIndicator();
        setIndicatorMode('recording');
      }
      return;
    }
    _active = true;

    if (isTopFrame) {
      _stepEngine.init();
      mountIndicator();
      setIndicatorMode('recording');
    }

    _pageObservers.attachMutationObserver();
    _pageObservers.attachIntersectionObserver();
    setTimeout(_pageObservers.captureDomMetrics, 2000);

    // Notify background from top frame only to avoid duplicate ready pings.
    if (isTopFrame) {
      // 600ms gives React/SPA time to finish initial render before capture.
      setTimeout(() => {
        void safeRuntimeSendMessage({ type: 'TT_CONTENT_READY', url: location.href });
      }, 600);
    }
  }

  function deactivate(): void {
    if (!_active) return;
    _active = false;
    _sessionId = null;
    _pageObservers.detachMutationObserver();
    _pageObservers.detachIntersectionObserver();
    if (isTopFrame) {
      _stepEngine.destroy();
      unmountIndicator();
    }
  }

  // ---- Delegated to page-observers -----------------------------------------

  function handleClick(e: MouseEvent): void {
    if (_contextInvalidated) return;
    try {
      _pageObservers.handleClick(e);
    } catch (err) {
      markContextInvalidated(err, 'handleClick');
    }
  }

  function suppressAutoCapture(): void {
    if (!isTopFrame) return;
    _stepEngine.suppressAutoCapture();
  }

  function openObservationWindow(label: string): void {
    if (!isTopFrame) return;
    _stepEngine.openObservationWindow(label);
  }

  // ---- Utilities -----------------------------------------------------------

  function isRec(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }


  // ---- Bootstrap: self-heal on every page load ----------------------------
  // Ask the SW "is there an active session for my origin?" so the recorder
  // re-appears automatically after F5, cross-tab navigation, OAuth redirects -
  // without waiting for handleTabUpdated to push a message.

  const QUERY_SESSION_RETRY_DELAYS_MS = [0, 250, 600, 1200];

  async function bootstrapSessionState(): Promise<void> {
    for (const delayMs of QUERY_SESSION_RETRY_DELAYS_MS) {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }

      const resp = await safeRuntimeSendMessage({ type: 'TT_QUERY_SESSION', origin: location.origin });
      if (!isRec(resp)) continue;

      const sid = resp['sessionId'];
      if (typeof sid === 'string' && sid) {
        _sessionId = sid;
        activate();
      }
      // Note: the `showReady` branch is intentionally NOT handled here.
      // The Chrome side panel is the sole "ready to test" surface now.
      return;
    }
  }

  void bootstrapSessionState();
})();
