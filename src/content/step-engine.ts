import type { ObservedSignal } from '../core/evidence-engine.js';
import { SIGNAL_BASE_SCORES } from '../core/evidence-engine.js';
import type { DOMSnapshot } from '../core/state-fingerprint.js';
import { computeFingerprint } from '../core/state-fingerprint.js';
import type { UserAction } from '../core/signal-pipeline.js';
import { runPipeline, USER_ACTION_WINDOW_MS } from '../core/signal-pipeline.js';
import { getSettings } from '../storage/settings.js';

interface StepEngineDeps {
  isActive: () => boolean;
}

export interface StepEngine {
  init: () => void;
  destroy: () => void;
  openObservationWindow: (label: string) => void;
  suppressAutoCapture: () => void;
  hideOverlay: () => void;
  showOverlay: () => void;
}

interface CandidateState {
  step: number;
  note: string;
  status: 'auto_captured' | 'manually_captured' | 'suggested' | 'dismissed';
}

type IndicatorStatus = 'capturing' | 'captured' | 'suggest';

export function createStepEngine(deps: StepEngineDeps): StepEngine {
  let stepObserver: MutationObserver | null = null;
  let formSubmitListener: ((e: Event) => void) | null = null;
  let stepIndEl: HTMLElement | null = null;
  let stepIndTimer: ReturnType<typeof setTimeout> | null = null;

  let pendingSignals: ObservedSignal[] = [];
  let stabilizeTimer: ReturnType<typeof setTimeout> | null = null;
  const STABILIZE_MS = 300;
  const AUTO_COOLDOWN_MS = 3500;
  let lastAutoCapture = 0;
  let manualCapturedPending = false;

  let stepCount = 0;
  let autoCaptureEnabled = true;

  let lastCaptureFp = '';
  let fpBeforeBurst = '';

  const ariaTextCache = new Map<Element, string>();
  const ariaObservers = new Map<Element, MutationObserver>();

  let userAction: UserAction | undefined;
  let candidate: CandidateState | null = null;
  let runtimeInvalidated = false;

  function isContextInvalidatedError(err: unknown): boolean {
    return String(err).toLowerCase().includes('extension context invalidated');
  }

  function safeRuntimeSendMessage(message: Record<string, unknown>): void {
    if (runtimeInvalidated) return;
    try {
      chrome.runtime.sendMessage(message).catch((err) => {
        if (isContextInvalidatedError(err)) {
          runtimeInvalidated = true;
          console.warn('[TestTrace] step-engine runtime invalidated; message dropped', { type: message['type'] });
        }
      });
    } catch (err) {
      if (isContextInvalidatedError(err)) {
        runtimeInvalidated = true;
        console.warn('[TestTrace] step-engine runtime invalidated (sync); message dropped', { type: message['type'] });
      }
    }
  }

  function init(): void {
    if (stepObserver) return;
    stepCount = 0;
    lastCaptureFp = '';
    fpBeforeBurst = '';
    userAction = undefined;
    candidate = null;

    void getSettings().then((s) => { autoCaptureEnabled = s.autoCaptureEnabled; });

    document.querySelectorAll('[aria-live], [role="alert"], [role="status"]').forEach(trackAriaElement);

    stepObserver = new MutationObserver((mutations) => {
      if (!deps.isActive()) return;
      if (!fpBeforeBurst && !stabilizeTimer) {
        fpBeforeBurst = buildFingerprint();
      }
      processMutations(mutations);
      scheduleStabilization();
    });

    stepObserver.observe(document.body ?? document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['role', 'aria-live', 'aria-invalid', 'aria-busy', 'disabled', 'open'],
      characterData: false,
    });

    formSubmitListener = (e: Event) => {
      if (!deps.isActive()) return;
      const form = e.target as HTMLFormElement;
      const formName = form.getAttribute('aria-label')
        ?? form.querySelector('legend, h1, h2, h3')?.textContent?.trim().slice(0, 40)
        ?? '';
      accumulateSignal({
        kind: 'form_submitted',
        description: formName ? `Form submitted: "${formName}"` : 'Form submitted',
        baseScore: SIGNAL_BASE_SCORES.form_submitted,
        ts: Date.now(),
      });
      recordUserAction({ kind: 'submit', label: formName || 'form', ts: Date.now() });
      scheduleStabilization();
    };
    document.addEventListener('submit', formSubmitListener, { capture: true, passive: true });
  }

  function destroy(): void {
    stepObserver?.disconnect();
    stepObserver = null;
    if (formSubmitListener) {
      document.removeEventListener('submit', formSubmitListener, { capture: true });
      formSubmitListener = null;
    }

    ariaObservers.forEach((obs) => obs.disconnect());
    ariaObservers.clear();
    ariaTextCache.clear();

    if (stabilizeTimer) {
      clearTimeout(stabilizeTimer);
      stabilizeTimer = null;
    }

    pendingSignals = [];
    fpBeforeBurst = '';
    stepCount = 0;
    candidate = null;
    userAction = undefined;
    removeStepIndicator();
  }

  function openObservationWindow(label: string): void {
    recordUserAction({ kind: 'click', label, ts: Date.now() });
  }

  function suppressAutoCapture(): void {
    manualCapturedPending = true;
    if (stabilizeTimer) {
      clearTimeout(stabilizeTimer);
      stabilizeTimer = null;
    }
    pendingSignals = [];
    fpBeforeBurst = '';
  }

  function hideOverlay(): void {
    if (stepIndEl) stepIndEl.style.visibility = 'hidden';
  }

  function showOverlay(): void {
    if (stepIndEl) stepIndEl.style.visibility = '';
  }

  function recordUserAction(action: UserAction): void {
    userAction = action;
    setTimeout(() => { if (userAction === action) userAction = undefined; }, USER_ACTION_WINDOW_MS);
  }

  function scheduleStabilization(): void {
    if (stabilizeTimer) clearTimeout(stabilizeTimer);
    stabilizeTimer = setTimeout(evaluateCandidate, STABILIZE_MS);
  }

  function evaluateCandidate(): void {
    stabilizeTimer = null;

    const signals = pendingSignals;
    const fpBefore = fpBeforeBurst;
    pendingSignals = [];
    fpBeforeBurst = '';

    if (signals.length === 0 || manualCapturedPending) {
      manualCapturedPending = false;
      return;
    }

    const fpAfter = buildFingerprint();

    const result = runPipeline({
      signals,
      userAction: currentUserAction(),
      fingerprintBefore: fpBefore || lastCaptureFp,
      fingerprintAfter: fpAfter,
    });

    if (result.decision === 'ignore') return;

    if (result.routeChanged) {
      pushIntelligenceFeed(`Route → ${result.route.split('/').slice(-2).join('/')}`, 'route');
    }

    if (fpAfter === lastCaptureFp && result.decision === 'auto') {
      showStepIndicator(stepCount + 1, result.captureNote, 'suggest');
      stepCount++;
      candidate = { step: stepCount, note: result.captureNote, status: 'suggested' };
      return;
    }

    const now = Date.now();
    const effectiveDecision = result.decision === 'auto' && !autoCaptureEnabled ? 'suggest' : result.decision;

    if (effectiveDecision === 'auto') {
      if (now - lastAutoCapture >= AUTO_COOLDOWN_MS) {
        stepCount++;
        lastAutoCapture = now;
        candidate = { step: stepCount, note: result.captureNote, status: 'auto_captured' };
        pushIntelligenceFeed(`Step ${stepCount} · Capturing…`, 'capture');
        showStepIndicator(stepCount, result.captureNote, 'capturing');
        safeRuntimeSendMessage({
          type: 'TT_CAPTURE_EVIDENCE',
          note: `Step ${stepCount}: ${result.captureNote}`.slice(0, 120),
          confidence: result.confidence,
        });
        setTimeout(() => {
          lastCaptureFp = fpAfter;
          if (candidate?.status === 'auto_captured') {
            pushIntelligenceFeed(`Step ${stepCount} captured`, 'capture');
            showStepIndicator(stepCount, result.captureNote, 'captured');
          }
        }, 900);
      } else {
        stepCount++;
        candidate = { step: stepCount, note: result.captureNote, status: 'suggested' };
        pushIntelligenceFeed(result.captureNote, 'detect');
        showStepIndicator(stepCount, result.captureNote, 'suggest');
      }
    } else {
      stepCount++;
      candidate = { step: stepCount, note: result.captureNote, status: 'suggested' };
      pushIntelligenceFeed(result.captureNote, 'detect');
      showStepIndicator(stepCount, result.captureNote, 'suggest');
    }
  }

  function currentUserAction(): UserAction | undefined {
    if (!userAction) return undefined;
    return Date.now() - userAction.ts <= USER_ACTION_WINDOW_MS ? userAction : undefined;
  }

  function accumulateSignal(sig: ObservedSignal): void {
    if (!deps.isActive()) return;
    pendingSignals.push(sig);
    if (sig.baseScore >= 65) {
      pushIntelligenceFeed(sig.description, sig.baseScore >= 80 ? 'warn' : 'detect');
    }
    if (!stabilizeTimer) scheduleStabilization();
  }

  function buildFingerprint(): string {
    const snap = buildSnapshot();
    return computeFingerprint(snap);
  }

  function buildSnapshot(): DOMSnapshot {
    const isOwn = (el: Element) => el.id?.startsWith('__tt_') || !!el.closest('[id^="__tt_"]');

    const headings = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
      .filter((el) => !isOwn(el))
      .map((el) => (el as HTMLElement).innerText?.trim() ?? '')
      .filter(Boolean);

    const alertTexts = Array.from(document.querySelectorAll('[role="alert"],[aria-live="assertive"]'))
      .filter((el) => !isOwn(el))
      .map((el) => (el as HTMLElement).innerText?.trim() ?? '')
      .filter(Boolean);

    const statusTexts = Array.from(document.querySelectorAll('[role="status"],[aria-live="polite"]'))
      .filter((el) => !isOwn(el))
      .map((el) => (el as HTMLElement).innerText?.trim() ?? '')
      .filter(Boolean);

    const dialogLabels = Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"]'))
      .filter((el) => !isOwn(el))
      .map((el) => el.getAttribute('aria-label')
        ?? el.getAttribute('aria-labelledby')
        ?? (el as HTMLElement).querySelector('h1,h2,h3')?.textContent?.trim()
        ?? '')
      .filter(Boolean);

    const invalidFieldCount = document.querySelectorAll('[aria-invalid="true"]').length;
    const hasBusyElement = !!document.querySelector('[aria-busy="true"]');

    const primaryButtons: Array<{ label: string; disabled: boolean }> = Array.from(document.querySelectorAll('button,[role="button"]'))
      .filter((el) => !isOwn(el))
      .slice(0, 10)
      .map((el) => ({
        label: (el.getAttribute('aria-label') ?? (el as HTMLElement).innerText?.trim() ?? '').slice(0, 30),
        disabled: (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true',
      }));

    return {
      url: location.href,
      headings,
      alertTexts,
      statusTexts,
      dialogLabels,
      invalidFieldCount,
      hasBusyElement,
      primaryButtons,
    };
  }

  function isOwnElement(el: Element): boolean {
    return el.id?.startsWith('__tt_') || !!el.closest('[id^="__tt_"]');
  }

  function isNoisyText(text: string): boolean {
    if (/^\d{1,3}:\d{2}(:\d{2})?$/.test(text)) return true;
    if (/^\d+$/.test(text) && text.length <= 5) return true;
    return false;
  }

  function isInIgnoredSubtree(el: Element): boolean {
    const tag = el.tagName?.toLowerCase() ?? '';
    return ['script', 'style', 'head', 'noscript', 'template', 'meta'].includes(tag)
      || !!el.closest('script, style, head, noscript, template');
  }

  function labelFor(el: Element): string {
    const aria = el.getAttribute('aria-label') ?? '';
    if (aria) return aria.slice(0, 40);
    const text = (el as HTMLElement).innerText?.trim().slice(0, 40);
    if (text) return `"${text}"`;
    const role = el.getAttribute('role');
    return role ? `[role=${role}]` : el.tagName.toLowerCase();
  }

  function processMutations(mutations: MutationRecord[]): void {
    const now = Date.now();
    for (const m of mutations) {
      if (m.type === 'childList') {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          const el = node as Element;
          if (isOwnElement(el) || isInIgnoredSubtree(el)) continue;
          onElementAdded(el, now);
        }
        for (const node of m.removedNodes) {
          if (node.nodeType !== 1) continue;
          const el = node as Element;
          if (isOwnElement(el) || isInIgnoredSubtree(el)) continue;
          onElementRemoved(el, now);
        }
      } else if (m.type === 'attributes') {
        const el = m.target as Element;
        if (isOwnElement(el) || isInIgnoredSubtree(el)) continue;
        onAttributeChanged(el, m.attributeName ?? '', m.oldValue ?? '', now);
      }
    }
  }

  function onElementAdded(el: Element, now: number): void {
    if (el.matches('[aria-live],[role="alert"],[role="status"]')) trackAriaElement(el);
    el.querySelectorAll('[aria-live],[role="alert"],[role="status"]').forEach(trackAriaElement);

    if (el.matches('[role="dialog"],[role="alertdialog"]')) {
      const name = labelFor(el);
      accumulateSignal({
        kind: 'dialog_opened',
        description: name ? `Dialog opened: ${name}` : 'Dialog opened',
        baseScore: SIGNAL_BASE_SCORES.dialog_opened,
        ts: now,
      });
      return;
    }

    const text = (el as HTMLElement).innerText?.trim() ?? '';
    if (el.matches('[role="alert"]') && text.length > 3) {
      accumulateSignal({
        kind: 'alert_appeared',
        description: `Error: "${text.slice(0, 60)}"`,
        baseScore: SIGNAL_BASE_SCORES.alert_appeared,
        ts: now,
      });
      return;
    }

    if (text.length > 500 && !el.matches('[aria-hidden="true"]')) {
      accumulateSignal({
        kind: 'significant_content_added',
        description: 'Significant content appeared',
        baseScore: SIGNAL_BASE_SCORES.significant_content_added,
        ts: now,
      });
    }
  }

  function onElementRemoved(el: Element, now: number): void {
    const obs = ariaObservers.get(el);
    if (obs) { obs.disconnect(); ariaObservers.delete(el); }
    ariaTextCache.delete(el);

    el.querySelectorAll('[aria-live],[role="alert"],[role="status"]').forEach((child) => {
      const co = ariaObservers.get(child);
      if (co) { co.disconnect(); ariaObservers.delete(child); }
      ariaTextCache.delete(child);
    });

    if (el.matches('[role="dialog"],[role="alertdialog"]')) {
      accumulateSignal({
        kind: 'dialog_closed',
        description: 'Dialog closed',
        baseScore: SIGNAL_BASE_SCORES.dialog_closed,
        ts: now,
      });
    }
  }

  function onAttributeChanged(el: Element, attr: string, oldVal: string, now: number): void {
    const newVal = el.getAttribute(attr) ?? '';
    switch (attr) {
      case 'aria-invalid':
        if (newVal === 'true' && oldVal !== 'true') {
          const hint = el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? el.getAttribute('name') ?? '';
          accumulateSignal({
            kind: 'error_state_changed',
            description: hint ? `Error on "${hint.slice(0, 40)}"` : 'Field validation error',
            baseScore: SIGNAL_BASE_SCORES.error_state_changed,
            ts: now,
          });
        }
        break;
      case 'aria-busy':
        if (newVal === 'false' && oldVal === 'true') {
          accumulateSignal({ kind: 'loading_completed', description: 'Loading finished', baseScore: SIGNAL_BASE_SCORES.loading_completed, ts: now });
        }
        break;
      case 'disabled': {
        const tag = el.tagName.toLowerCase();
        if (!['button', 'input', 'select', 'textarea'].includes(tag)) break;
        const wasDisabled = oldVal === '' || oldVal === 'true' || oldVal === 'disabled';
        const isNowDisabled = newVal === '' || newVal === 'true' || newVal === 'disabled';
        const name = labelFor(el);
        if (wasDisabled && !isNowDisabled) {
          accumulateSignal({ kind: 'button_enabled', description: name ? `"${name}" is now available` : 'Button became available', baseScore: SIGNAL_BASE_SCORES.button_enabled, ts: now });
        } else if (!wasDisabled && isNowDisabled) {
          accumulateSignal({ kind: 'button_disabled', description: name ? `"${name}" is now disabled` : 'Button became unavailable', baseScore: SIGNAL_BASE_SCORES.button_disabled, ts: now });
        }
        break;
      }
      case 'role':
        if ((newVal === 'dialog' || newVal === 'alertdialog') && oldVal !== newVal) {
          accumulateSignal({ kind: 'dialog_opened', description: 'Dialog opened', baseScore: SIGNAL_BASE_SCORES.dialog_opened, ts: now });
        }
        break;
    }
  }

  function trackAriaElement(el: Element): void {
    if (ariaObservers.has(el)) return;
    ariaTextCache.set(el, (el as HTMLElement).innerText?.trim() ?? '');
    const obs = new MutationObserver(() => {
      if (!deps.isActive()) return;
      if (!document.contains(el)) {
        obs.disconnect();
        ariaObservers.delete(el);
        ariaTextCache.delete(el);
        return;
      }
      checkAriaTextChange(el, Date.now());
    });
    obs.observe(el, { childList: true, subtree: true, characterData: true });
    ariaObservers.set(el, obs);
  }

  function checkAriaTextChange(el: Element, now: number): void {
    const oldText = ariaTextCache.get(el) ?? '';
    const newText = (el as HTMLElement).innerText?.trim() ?? '';
    if (newText === oldText || !newText || isNoisyText(newText)) return;
    if (Math.abs(newText.length - oldText.length) < 3 && newText.startsWith(oldText.slice(0, 5))) return;

    ariaTextCache.set(el, newText);
    const role = el.getAttribute('role');
    const live = el.getAttribute('aria-live');
    const val = newText.slice(0, 60);

    if (role === 'alert' || live === 'assertive') {
      accumulateSignal({ kind: 'alert_appeared', description: `Error: "${val}"`, baseScore: SIGNAL_BASE_SCORES.alert_appeared, before: oldText.slice(0, 50), after: val, ts: now });
    } else if (role === 'status') {
      accumulateSignal({ kind: 'status_text_changed', description: `Status changed to "${val}"`, baseScore: SIGNAL_BASE_SCORES.status_text_changed, before: oldText.slice(0, 50), after: val, ts: now });
    } else if (newText.length >= 10) {
      accumulateSignal({ kind: 'aria_live_updated', description: `Page updated: "${val}"`, baseScore: SIGNAL_BASE_SCORES.aria_live_updated, before: oldText.slice(0, 50), after: val, ts: now });
    }
  }

  function showStepIndicator(step: number, desc: string, status: IndicatorStatus): void {
    removeStepIndicator();
    if (!document.body) return;

    const el = document.createElement('div');
    el.id = '__tt_step_ind__';

    const safeDesc = escHtml(desc.slice(0, 80));
    const stepLabel = `Step ${step}`;

    if (status === 'suggest') {
      el.innerHTML =
        `<div style="display:flex;align-items:center;gap:0;margin-bottom:5px">` +
          `<span style="font-weight:700;color:#1f3864;font-size:10px">${escHtml(stepLabel)}</span>` +
          `<span style="color:#ccc;margin:0 5px">•</span>` +
          `<span style="color:#555;font-size:10px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${safeDesc}</span>` +
          `<button id="__tt_si_close__" style="background:none;border:none;cursor:pointer;color:#bbb;font-size:12px;line-height:1;padding:0 0 0 6px;flex-shrink:0"></button>` +
        `</div>` +
        `<button id="__tt_si_capture__" style="width:100%;padding:5px 0;background:#1f3864;color:white;border:none;border-radius:5px;font-size:10px;font-weight:600;cursor:pointer;font-family:inherit">Capture evidence</button>`;
    } else if (status === 'capturing') {
      el.innerHTML =
        `<span style="font-weight:700;color:#1f3864;font-size:10px">${escHtml(stepLabel)}</span>` +
        `<span style="color:#ccc;margin:0 5px">•</span>` +
        `<span style="color:#1565d8;font-size:10px">Capturing evidence…</span>`;
    } else {
      el.innerHTML =
        `<span style="font-weight:700;color:#1f3864;font-size:10px">${escHtml(stepLabel)}</span>` +
        `<span style="color:#ccc;margin:0 5px">•</span>` +
        `<span style="color:#1d6b38;font-size:10px;flex:1"> Evidence captured</span>` +
        `<button id="__tt_si_close__" style="background:none;border:none;cursor:pointer;color:#bbb;font-size:12px;line-height:1;padding:0 0 0 6px;flex-shrink:0"></button>`;
    }

    el.style.cssText = [
      'position:fixed', 'bottom:150px', 'right:16px', 'z-index:2147483645',
      'background:white', 'border:1px solid #d0d3d8', 'border-radius:8px', 'padding:8px 10px',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', 'width:220px',
      'box-shadow:0 2px 10px rgba(0,0,0,.15)', 'pointer-events:auto',
      status === 'suggest' ? 'display:block' : 'display:flex',
      'align-items:center',
    ].join(';');

    document.body.appendChild(el);
    stepIndEl = el;

    el.querySelector('#__tt_si_close__')?.addEventListener('click', () => {
      if (candidate) candidate.status = 'dismissed';
      removeStepIndicator();
    });

    el.querySelector('#__tt_si_capture__')?.addEventListener('click', () => {
      if (candidate) candidate.status = 'manually_captured';
      removeStepIndicator();
      suppressAutoCapture();
      safeRuntimeSendMessage({
        type: 'TT_CAPTURE_EVIDENCE',
        note: `Step ${step}: ${desc}`.slice(0, 120),
        confidence: 'inferred-high',
      });
      lastCaptureFp = buildFingerprint();
      showStepIndicator(step, desc, 'captured');
    });

    const dismissMs = status === 'captured' ? 3500 : status === 'capturing' ? 8000 : 7000;
    stepIndTimer = setTimeout(() => removeStepIndicator(), dismissMs);
  }

  function removeStepIndicator(): void {
    if (stepIndTimer) {
      clearTimeout(stepIndTimer);
      stepIndTimer = null;
    }
    stepIndEl?.remove();
    stepIndEl = null;
  }

  function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function pushIntelligenceFeed(text: string, type: 'detect' | 'capture' | 'route' | 'warn' | 'ignore'): void {
    const feed = document.getElementById('__tt_intel__');
    if (!feed) return;

    const cfg: Record<string, { icon: string; color: string }> = {
      detect: { icon: '', color: 'rgba(255,255,255,0.55)' },
      capture: { icon: '', color: '#7dffc0' },
      route: { icon: '→', color: '#80bfff' },
      warn: { icon: '', color: '#ffd166' },
      ignore: { icon: '–', color: 'rgba(255,255,255,0.3)' },
    };

    const entry = cfg[type] ?? cfg['detect'];
    if (!entry) return;
    const { icon, color } = entry;
    const item = document.createElement('div');
    item.className = 'ttp-intel-item';
    item.style.color = color;
    item.textContent = `${icon} ${text.slice(0, 52)}`;

    feed.prepend(item);
    while (feed.children.length > 3) feed.lastChild?.remove();

    setTimeout(() => {
      item.style.transition = 'opacity 0.4s';
      item.style.opacity = '0';
      setTimeout(() => item.remove(), 400);
    }, 6000);
  }

  return {
    init,
    destroy,
    openObservationWindow,
    suppressAutoCapture,
    hideOverlay,
    showOverlay,
  };
}
