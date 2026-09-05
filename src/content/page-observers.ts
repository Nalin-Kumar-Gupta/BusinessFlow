type IndicatorState = 'recording' | 'paused';

interface PageObserverDeps {
  isActive: () => boolean;
  getSessionId: () => string | null;
  openObservationWindow: (label: string) => void;
  suppressAutoCapture: () => void;
}

export interface PageObservers {
  handleClick: (e: MouseEvent) => void;
  handleChange: (e: Event) => void;
  attachMutationObserver: () => void;
  detachMutationObserver: () => void;
  attachIntersectionObserver: () => void;
  detachIntersectionObserver: () => void;
  captureDomMetrics: () => void;
  scrollToComponent: (componentName: string) => { scrolled: boolean; originalScrollY: number };
  showIndicator: () => void;
  removeIndicator: () => void;
  updateIndicator: (state: IndicatorState) => void;
  hideOverlay: () => void;
  showOverlay: () => void;
  setIndicatorVisible: (visible: boolean) => void;
}

const MAX_TEXT_LEN = 100;
const SEMANTIC_LABEL_MAX_LEN = 30;
const DOM_DEBOUNCE_MS = 600;
const AFTER_STABILIZE_MS = 600;
const AFTER_HARD_TIMEOUT_MS = 2000;

const RAGE_CLICK_THRESHOLD = 3;
const RAGE_CLICK_WINDOW_MS = 1000;

const IGNORED_ATTRS = new Set(['style', 'class', 'aria-selected', 'aria-expanded', 'aria-checked', 'data-tooltip', 'title', 'tabindex', 'data-v-', 'data-reactid']);
const ANIMATION_CLASSES = /anim|transition|hover|focus|active|ripple|pulse|spin|fade|slide/i;

const CONTENT_SELECTORS = [
  'table', '[role="grid"]', '[role="table"]',
  '[data-testid]', '[aria-label]',
  'section', 'article', 'main > div',
  '[class*="card"]', '[class*="panel"]', '[class*="widget"]',
  '[class*="chart"]', '[class*="table"]', '[class*="grid"]',
].join(', ');

export function createPageObservers(deps: PageObserverDeps): PageObservers {
  let indicatorEl: HTMLElement | null = null;

  let mutationObserver: MutationObserver | null = null;
  let domChangeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastChangeSignature = '';

  let pendingAfterCapture: {
    clickCorrelationId: string;
    startedAt: number;
    majorShiftResets: number;
    timer: ReturnType<typeof setTimeout>;
    hardTimer: ReturnType<typeof setTimeout>;
  } | null = null;

  let intersectionObserver: IntersectionObserver | null = null;
  const visibleComponents = new Set<Element>();
  const recentClicks: { selector: string; tagName: string; ts: number }[] = [];

  const componentRegistry = new Map<string, Element>();
  let runtimeInvalidated = false;

  function isContextInvalidatedError(err: unknown): boolean {
    return String(err).toLowerCase().includes('extension context invalidated');
  }

  /**
   * DOM events can target text nodes (e.g. clicking text inside <a>). Normalize
   * to the nearest Element so selector/tag extraction doesn't fail.
   */
  function eventTargetElement(target: EventTarget | null): Element | null {
    if (!target) return null;
    if (target instanceof Element) return target;
    if (target instanceof Node) return target.parentElement;
    return null;
  }

  function safeSendContentEvent(event: Record<string, unknown>): void {
    if (runtimeInvalidated) return;
    const eventKind = String(event['kind'] ?? 'unknown');
    try {
      chrome.runtime.sendMessage({ type: 'TT_CONTENT_EVENT', event }).catch((err) => {
        if (isContextInvalidatedError(err)) {
          runtimeInvalidated = true;
          console.warn('[TestTrace] content runtime invalidated; stopping event sends');
          return;
        }
        // Non-invalidation failures (e.g. page teardown mid-transmit) — always log.
        console.error('[TestTrace]', eventKind, 'message dropped:', err);
      });
    } catch (err) {
      if (isContextInvalidatedError(err)) {
        runtimeInvalidated = true;
        console.warn('[TestTrace] content runtime invalidated (sync); stopping event sends');
        return;
      }
      console.error('[TestTrace]', eventKind, 'message dropped (sync):', err);
    }
  }

  function handleClick(e: MouseEvent): void {
    console.log('[TestTrace] handleClick entered, event type:', e.type, 'target:', e.target, 'button=', e.button);
    try {
      // Only primary mouse button. Ignore right/middle-click so context menus
      // and open-in-new-tab don't spawn steps. Skip for click events — they
      // don't reliably expose e.button on all frameworks.
      if (e.type !== 'click' && e.button !== 0) return;
      if ((e.target as Element)?.closest('#__tt_recorder__, #__tt_indicator__')) return;

      const sessionId = deps.getSessionId();
      if (!deps.isActive() || !sessionId) {
        console.log('[TestTrace] mousedown skipped:', { active: deps.isActive(), sessionId });
        return;
      }

      const target = eventTargetElement(e.target);
      if (!target) return;
      if (target instanceof HTMLInputElement && (target.type === 'password' || target.type === 'hidden')) return;

      const tag = target.tagName.toLowerCase();
      const role = target.getAttribute('role') ?? undefined;
      const ariaLabel = target.getAttribute('aria-label') ?? undefined;
      const selector = getRobustSelector(target);
      const semanticLabel = getSemanticLabel(target);
      const text = getVisibleText(target, tag);
      const accessibleName = buildAccessibleName({ ariaLabel, text: semanticLabel ?? text, role, tag });
      const elementRect = buildElementRect(target);

      const clickCorrelationId = newClickCorrelationId();
      const clickTs = Date.now();
      console.log('[TestTrace] click->capture pipeline: user_click emit', {
        clickCorrelationId,
        eventType: e.type,
        tag,
        selector,
        pageUrl: location.href,
      });

      safeSendContentEvent({
        kind: 'user_click',
        clickCorrelationId,
        clickTs,
        selector,
        robustSelector: selector,
        semanticLabel,
        tagName: tag,
        role,
        ariaLabel,
        text,
        accessibleName,
        elementRect,
        pageUrl: location.href,
      });

      startAfterCaptureTimer(clickCorrelationId);

      const actionLabel = accessibleName ?? `<${tag}>`;
      deps.openObservationWindow(actionLabel.slice(0, 50));

      const now = Date.now();
      recentClicks.push({ selector, tagName: tag, ts: now });
      while (recentClicks.length > 0 && now - (recentClicks[0]?.ts ?? 0) > RAGE_CLICK_WINDOW_MS) recentClicks.shift();
      const sameSelector = recentClicks.filter((c) => c.selector === selector);
      if (sameSelector.length >= RAGE_CLICK_THRESHOLD) {
        safeSendContentEvent({ kind: 'rage_click', selector, tagName: tag, clickCount: sameSelector.length, windowMs: RAGE_CLICK_WINDOW_MS, pageUrl: location.href });
        recentClicks.length = 0;
      }
    } catch (err) {
      if (isContextInvalidatedError(err)) {
        runtimeInvalidated = true;
        console.warn('[TestTrace] page-observers click handler disabled after context invalidation');
        return;
      }
      throw err;
    }
  }

  function attachMutationObserver(): void {
    mutationObserver = new MutationObserver(handleMutations);
    mutationObserver.observe(document.body ?? document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-live', 'aria-invalid', 'aria-errormessage', 'hidden', 'disabled', 'open'],
      characterData: false,
    });
  }

  function detachMutationObserver(): void {
    mutationObserver?.disconnect();
    mutationObserver = null;
    if (domChangeDebounceTimer) clearTimeout(domChangeDebounceTimer);
    domChangeDebounceTimer = null;
    clearAfterCaptureTimer();
  }

  function handleMutations(mutations: MutationRecord[]): void {
    if (!deps.isActive()) return;

    let meaningful = false;
    let summary = '';

    for (const m of mutations) {
      if (m.type === 'childList') {
        if (m.addedNodes.length === 0 && m.removedNodes.length === 0) continue;
        const addedElements = Array.from(m.addedNodes).filter((n) => n.nodeType === 1);
        const removedElements = Array.from(m.removedNodes).filter((n) => n.nodeType === 1);
        if (addedElements.length || removedElements.length) {
          const tags = [...addedElements, ...removedElements].map((n) => (n as Element).tagName?.toLowerCase() ?? '');
          if (tags.every((t) => ['span', 'i', 'svg', 'path'].includes(t))) continue;
          meaningful = true;
          summary = `DOM: +${addedElements.length} -${removedElements.length} elements`;
        }
      } else if (m.type === 'attributes') {
        const attr = m.attributeName ?? '';
        if (IGNORED_ATTRS.has(attr)) continue;
        if (attr === 'class') {
          const el = m.target as Element;
          if (ANIMATION_CLASSES.test(el.className)) continue;
        }
        meaningful = true;
        summary = `Attr change: ${m.attributeName} on ${(m.target as Element).tagName?.toLowerCase() ?? 'element'}`;
      }
    }

    if (!meaningful) return;

    if (pendingAfterCapture && hasMajorLayoutShift(mutations)) {
      pendingAfterCapture.majorShiftResets += 1;
      resetAfterCaptureTimer();
    }

    setTimeout(updateComponentRegistry, 500);
    if (domChangeDebounceTimer) clearTimeout(domChangeDebounceTimer);
    domChangeDebounceTimer = setTimeout(() => {
      const sig = computeChangeSignature();
      if (sig === lastChangeSignature) return;
      lastChangeSignature = sig;
      safeSendContentEvent({ kind: 'dom_change', summary, changeSignature: sig, pageUrl: location.href });
    }, DOM_DEBOUNCE_MS);
  }

  function startAfterCaptureTimer(clickCorrelationId: string): void {
    // A new click before the previous click stabilized would otherwise cancel
    // the pending after-capture entirely and leave Step N-1 with no "after"
    // frame. Flush the prior one first so Step N-1 gets a best-effort snapshot
    // of the state right before Step N.
    if (pendingAfterCapture) {
      flushAfterCapture('preempted');
    }
    pendingAfterCapture = {
      clickCorrelationId,
      startedAt: Date.now(),
      majorShiftResets: 0,
      timer: setTimeout(() => flushAfterCapture('stabilized'), AFTER_STABILIZE_MS),
      hardTimer: setTimeout(() => flushAfterCapture('hard-timeout'), AFTER_HARD_TIMEOUT_MS),
    };
    console.log('[TestTrace] click->capture pipeline: after timer armed', {
      clickCorrelationId,
      stabilizeMs: AFTER_STABILIZE_MS,
      hardTimeoutMs: AFTER_HARD_TIMEOUT_MS,
    });
  }

  function resetAfterCaptureTimer(): void {
    if (!pendingAfterCapture) return;
    if (Date.now() - pendingAfterCapture.startedAt >= AFTER_HARD_TIMEOUT_MS) {
      flushAfterCapture('hard-timeout');
      return;
    }
    clearTimeout(pendingAfterCapture.timer);
    pendingAfterCapture.timer = setTimeout(() => flushAfterCapture('stabilized'), AFTER_STABILIZE_MS);
  }

  function clearAfterCaptureTimer(): void {
    if (!pendingAfterCapture) return;
    clearTimeout(pendingAfterCapture.timer);
    clearTimeout(pendingAfterCapture.hardTimer);
    pendingAfterCapture = null;
  }

  function flushAfterCapture(reason: 'stabilized' | 'hard-timeout' | 'preempted'): void {
    const pending = pendingAfterCapture;
    pendingAfterCapture = null;
    if (!pending || !deps.isActive()) return;

    clearTimeout(pending.timer);
    clearTimeout(pending.hardTimer);

    console.log('[TestTrace] click->capture pipeline: after timer flush', {
      clickCorrelationId: pending.clickCorrelationId,
      reason,
      elapsedMs: Date.now() - pending.startedAt,
      majorShiftResets: pending.majorShiftResets,
    });

    safeSendContentEvent({
      kind: 'user_action_stable',
      clickCorrelationId: pending.clickCorrelationId,
      majorShiftResets: pending.majorShiftResets,
      stableReason: reason,
      pageUrl: location.href,
    });
  }

  function attachIntersectionObserver(): void {
    try {
      intersectionObserver = new IntersectionObserver(
        (entries) => {
          if (!deps.isActive()) return;
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            if (visibleComponents.has(entry.target)) continue;
            const el = entry.target as HTMLElement;
            const hasContent =
              (el.textContent?.trim().length ?? 0) > 80 ||
              el.querySelectorAll('tr, li, [role="row"]').length > 2;
            if (!hasContent) continue;
            const label =
              el.getAttribute('aria-label') ||
              el.querySelector('h1,h2,h3,[role="heading"]')?.textContent?.trim().slice(0, 60) ||
              el.getAttribute('data-testid')?.replace(/-/g, ' ') ||
              '';
            visibleComponents.add(entry.target);
            safeSendContentEvent({ kind: 'dom_change', summary: `Component visible: ${label || 'section'}`, changeSignature: `visible:${label}:${location.pathname}`, pageUrl: location.href });
          }
        },
        { threshold: 0.4, rootMargin: '0px' },
      );
      for (const el of document.querySelectorAll(CONTENT_SELECTORS)) intersectionObserver.observe(el);
    } catch {
      /* not available */
    }
  }

  function detachIntersectionObserver(): void {
    intersectionObserver?.disconnect();
    intersectionObserver = null;
    visibleComponents.clear();
  }

  function captureDomMetrics(): void {
    if (!deps.isActive()) return;
    try {
      const allNodes = document.querySelectorAll('*');
      const nodeCount = allNodes.length;
      let maxDepth = 0;
      const stack: [Element, number][] = [[document.documentElement, 0]];
      while (stack.length > 0) {
        const item = stack.pop();
        if (!item) break;
        const [el, depth] = item;
        if (depth > maxDepth) maxDepth = depth;
        for (const child of el.children) stack.push([child, depth + 1]);
      }
      const ariaInvalidCount = document.querySelectorAll('[aria-invalid="true"]').length;
      const missingAltCount = document.querySelectorAll('img:not([alt])').length;
      const unlabelledInteractiveCount = document.querySelectorAll(
        'button:not([aria-label]):not([title]):not([aria-labelledby]), a:not([aria-label]):not([title]):not([aria-labelledby])',
      ).length;
      safeSendContentEvent({ kind: 'dom_metrics', nodeCount, maxDepth, ariaInvalidCount, missingAltCount, unlabelledInteractiveCount, pageUrl: location.href });
    } catch {
      /* DOM traversal failed */
    }
  }

  function scrollToComponent(componentName: string): { scrolled: boolean; originalScrollY: number } {
    const originalScrollY = window.scrollY;
    const nameLower = componentName.toLowerCase();
    updateComponentRegistry();
    let target: Element | null = null;
    for (const [key, el] of componentRegistry.entries()) {
      if (key === nameLower || key.includes(nameLower) || nameLower.includes(key)) {
        if ((el.textContent?.trim().length ?? 0) > 20) { target = el; break; }
      }
    }
    if (!target) {
      document.querySelectorAll('h1,h2,h3,[role="heading"]').forEach((el) => {
        const text = (el as HTMLElement).innerText?.toLowerCase() ?? '';
        if (!target && (text.includes(nameLower) || nameLower.includes(text.replace(/\s+/g, ' ')))) {
          target = el.closest('section,article,div') ?? el;
        }
      });
    }
    if (!target) return { scrolled: false, originalScrollY };

    const rect = target.getBoundingClientRect();
    const isVisible = rect.top >= 0 && rect.bottom <= window.innerHeight && rect.height > 0;
    if (!isVisible && rect.height > 0) {
      target.scrollIntoView({ behavior: 'instant', block: 'start' });
      if (window.scrollY > 80) window.scrollBy({ top: -70, behavior: 'instant' });
    }

    const el = target as HTMLElement;
    const prevOutline = el.style.outline;
    const prevOutlineOffset = el.style.outlineOffset;
    el.style.outline = '3px solid rgba(233,69,96,0.8)';
    el.style.outlineOffset = '2px';
    setTimeout(() => {
      el.style.outline = prevOutline;
      el.style.outlineOffset = prevOutlineOffset;
    }, 1500);

    return { scrolled: !isVisible && rect.height > 0, originalScrollY };
  }

  function showIndicator(): void {
    if (indicatorEl) return;
    const el = document.createElement('div');
    el.id = '__tt_indicator__';
    el.className = 'tt-indicator';
    el.innerHTML = '<span class="tt-indicator__dot"></span><span class="tt-indicator__label">Recording</span>';
    document.body?.appendChild(el);
    indicatorEl = el;
  }

  function removeIndicator(): void {
    indicatorEl?.remove();
    indicatorEl = null;
  }

  function updateIndicator(state: IndicatorState): void {
    if (!indicatorEl) return;
    const label = indicatorEl.querySelector('.tt-indicator__label');
    if (label) label.textContent = state === 'paused' ? 'Paused' : 'Recording';
    indicatorEl.classList.toggle('tt-indicator--paused', state === 'paused');
  }

  function hideOverlay(): void {
    indicatorEl?.classList.add('tt-hidden');
  }

  function showOverlay(): void {
    indicatorEl?.classList.remove('tt-hidden');
  }

  function updateComponentRegistry(): void {
    document.querySelectorAll('h1,h2,h3,[role="heading"]').forEach((el) => {
      const text = (el as HTMLElement).innerText?.trim();
      if (text && text.length > 2 && text.length < 80) {
        const container = el.closest('section,article,[class*="card"],[class*="panel"],[class*="content"]') ?? el.parentElement;
        if (container) componentRegistry.set(text.toLowerCase(), container);
      }
    });
    document.querySelectorAll('[data-testid]').forEach((el) => {
      const tid = el.getAttribute('data-testid') ?? '';
      if (tid) componentRegistry.set(tid.toLowerCase().replace(/-/g, ' '), el);
    });
    document.querySelectorAll('[aria-label]').forEach((el) => {
      const label = (el.getAttribute('aria-label') ?? '').toLowerCase();
      if (label.length > 3) componentRegistry.set(label, el);
    });
    document.querySelectorAll('table,[role="grid"],[role="table"]').forEach((el, i) => {
      const label = (el as HTMLElement).getAttribute('aria-label') ?? `table-${i}`;
      componentRegistry.set(label.toLowerCase(), el);
    });
  }

  function setIndicatorVisible(visible: boolean): void {
    if (!indicatorEl) return;
    indicatorEl.style.display = visible ? '' : 'none';
  }

  /**
   * Native <select> commits a value via `change`, not `click` — picking an
   * option from the OS-rendered dropdown fires no click on the page. Without
   * this the state transition is invisible to the recorder.
   */
  function handleChange(e: Event): void {
    try {
      const target = eventTargetElement(e.target);
      if (!target) return;
      if (target.closest('#__tt_recorder__, #__tt_indicator__')) return;

      const sessionId = deps.getSessionId();
      if (!deps.isActive() || !sessionId) return;

      const tag = target.tagName.toLowerCase();
      // Clicks already cover checkbox/radio; text inputs are noise on every keystroke.
      if (tag !== 'select') return;

      const select = target as HTMLSelectElement;

      const chosen = select.options[select.selectedIndex]?.text?.trim() ?? select.value;
      const role = target.getAttribute('role') ?? undefined;
      const ariaLabel = target.getAttribute('aria-label') ?? undefined;
      const selector = getRobustSelector(target);
      const semanticLabel = getSemanticLabel(target);
      const accessibleName = buildAccessibleName({ ariaLabel, text: semanticLabel, role, tag });
      const elementRect = buildElementRect(target);

      const clickCorrelationId = newClickCorrelationId();

      safeSendContentEvent({
        kind: 'user_click',
        clickCorrelationId,
        clickTs: Date.now(),
        selector,
        robustSelector: selector,
        semanticLabel,
        tagName: tag,
        role,
        ariaLabel,
        text: chosen,
        accessibleName: accessibleName ?? `Select "${chosen}"`,
        elementRect,
        pageUrl: location.href,
      });

      startAfterCaptureTimer(clickCorrelationId);
      deps.openObservationWindow(`Select "${chosen}"`.slice(0, 50));
    } catch (err) {
      if (isContextInvalidatedError(err)) {
        runtimeInvalidated = true;
        return;
      }
      console.warn('[TestTrace] change handler error', err);
    }
  }

  return {
    handleClick,
    handleChange,
    attachMutationObserver,
    detachMutationObserver,
    attachIntersectionObserver,
    detachIntersectionObserver,
    captureDomMetrics,
    scrollToComponent,
    showIndicator,
    removeIndicator,
    updateIndicator,
    hideOverlay,
    showOverlay,
    setIndicatorVisible,
  };
}

function computeChangeSignature(): string {
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
    .map((h) => (h as HTMLElement).innerText?.slice(0, 30) ?? '')
    .join('|');
  const alerts = Array.from(document.querySelectorAll('[role="alert"],[aria-live]'))
    .map((a) => (a as HTMLElement).innerText?.slice(0, 50) ?? '')
    .join('|');
  const errorEls = document.querySelectorAll('.error,.alert,.warning,[aria-invalid="true"]').length;
  return `${headings}///${alerts}///${errorEls}`;
}

function getSemanticLabel(el: Element): string | undefined {
  const chain: Element[] = [];
  let cur: Element | null = el;
  for (let i = 0; i < 4 && cur; i++) {
    chain.push(cur);
    cur = cur.parentElement;
  }

  for (const node of chain) {
    const aria = cleanLabel(node.getAttribute('aria-label'));
    if (aria) return aria;
  }
  for (const node of chain) {
    if (node instanceof HTMLImageElement) {
      const alt = cleanLabel(node.getAttribute('alt'));
      if (alt) return alt;
    }
    const altAny = cleanLabel(node.getAttribute('alt'));
    if (altAny) return altAny;
  }
  for (const node of chain) {
    const title = cleanLabel(node.getAttribute('title'));
    if (title) return title;
  }
  for (const node of chain) {
    const text = cleanLabel((node as HTMLElement).innerText ?? node.textContent ?? '');
    if (text) return text;
  }
  return undefined;
}

function cleanLabel(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const cleaned = v.replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, SEMANTIC_LABEL_MAX_LEN);
}

function getRobustSelector(el: Element): string {
  const testAttrs = ['data-testid', 'data-qa', 'data-cy'] as const;
  for (const attr of testAttrs) {
    const value = el.getAttribute(attr);
    if (value) return `[${attr}="${CSS.escape(value)}"]`;
  }

  if (el.id) return `#${CSS.escape(el.id)}`;

  const classSelector = buildClassSelector(el);
  if (classSelector) return classSelector;

  const path = buildTagPath(el, 4);
  return path || el.tagName.toLowerCase();
}

function buildClassSelector(el: Element): string | null {
  const classes = Array.from(el.classList)
    .map((c) => c.trim())
    .filter((c) => c.length >= 2 && c.length <= 30)
    .filter((c) => !/^\d+$/.test(c))
    .filter((c) => !/(active|focus|hover|selected|disabled|enabled)/i.test(c))
    .slice(0, 3);
  if (classes.length === 0) return null;

  const selector = `${el.tagName.toLowerCase()}.${classes.map((c) => CSS.escape(c)).join('.')}`;
  try {
    if (document.querySelectorAll(selector).length === 1) return selector;
  } catch {
    return null;
  }
  return null;
}

function buildTagPath(el: Element, depth: number): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  let remain = depth;

  while (cur && remain > 0) {
    const tag = cur.tagName.toLowerCase();
    if (cur.id) {
      parts.unshift(`#${CSS.escape(cur.id)}`);
      break;
    }

    let part = tag;
    const parent = cur.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur?.tagName);
      if (sameTag.length > 1) {
        const idx = sameTag.indexOf(cur) + 1;
        part += `:nth-of-type(${idx})`;
      }
    }

    parts.unshift(part);
    cur = cur.parentElement;
    remain -= 1;
  }

  return parts.join(' > ');
}

function getVisibleText(el: Element, tag: string): string | undefined {
  if (['input', 'textarea', 'select'].includes(tag)) return undefined;
  const text = (el as HTMLElement).innerText?.trim() ?? el.textContent?.trim() ?? '';
  return text ? text.slice(0, MAX_TEXT_LEN) : undefined;
}

interface AccessibleNameInput {
  ariaLabel?: string;
  text?: string;
  role?: string;
  tag: string;
}

function buildAccessibleName({ ariaLabel, text, role, tag }: AccessibleNameInput): string | undefined {
  const candidate = ariaLabel?.trim() || text?.trim() || role?.trim();
  if (candidate) return candidate.slice(0, MAX_TEXT_LEN);
  return tag ? `<${tag}>` : undefined;
}

function buildElementRect(el: Element): {
  x: number; y: number; width: number; height: number;
  pageScrollX: number; pageScrollY: number;
  viewportWidth: number; viewportHeight: number;
  devicePixelRatio: number;
} | undefined {
  try {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return undefined;

    // Element coordinates are frame-local. For iframe clicks we need top-level
    // viewport coordinates so screenshot highlights land on the right pixels.
    let absX = rect.left;
    let absY = rect.top;
    let pageScrollX = window.scrollX;
    let pageScrollY = window.scrollY;
    let viewportWidth = window.innerWidth;
    let viewportHeight = window.innerHeight;

    try {
      let w: Window = window;
      while (w !== w.top) {
        const frameEl = w.frameElement as Element | null;
        if (!frameEl) break;
        const frameRect = frameEl.getBoundingClientRect();
        absX += frameRect.left;
        absY += frameRect.top;
        w = w.parent;
      }

      if (w === w.top) {
        pageScrollX = w.scrollX;
        pageScrollY = w.scrollY;
        viewportWidth = w.innerWidth;
        viewportHeight = w.innerHeight;
      }
    } catch {
      // Cross-origin parent access can fail; fallback to local-frame rect.
    }

    return {
      x: Math.round(absX),
      y: Math.round(absY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      pageScrollX: Math.round(pageScrollX),
      pageScrollY: Math.round(pageScrollY),
      viewportWidth: Math.round(viewportWidth),
      viewportHeight: Math.round(viewportHeight),
      devicePixelRatio: window.devicePixelRatio || 1,
    };
  } catch {
    return undefined;
  }
}

function newClickCorrelationId(): string {
  return `clk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function hasMajorLayoutShift(mutations: MutationRecord[]): boolean {
  let score = 0;
  for (const m of mutations) {
    if (m.type === 'childList') {
      const added = Array.from(m.addedNodes).filter((n) => n.nodeType === 1).length;
      const removed = Array.from(m.removedNodes).filter((n) => n.nodeType === 1).length;
      score += added + removed;
      continue;
    }
    if (m.type === 'attributes') {
      const attr = m.attributeName ?? '';
      if (attr === 'hidden' || attr === 'open' || attr === 'aria-busy' || attr === 'disabled') {
        score += 1;
      }
    }
  }
  return score >= 3;
}

