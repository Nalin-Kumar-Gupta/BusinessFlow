// Main world content script.
// Captures: console.error, console.warn, window.onerror, unhandledrejection,
// Web Vitals (LCP/FCP/CLS/INP/TTFB), Navigation Timing (page_timing).
// All via chrome.runtime.sendMessage (available in MV3 main-world scripts, Chrome 111+).

(function () {
  'use strict';

  const mainWindow = window as Window & { __tt_mainworld_patched__?: boolean };
  if (mainWindow.__tt_mainworld_patched__) return;
  mainWindow.__tt_mainworld_patched__ = true;

  const MAX_MSG_LEN = 500;

  function send(event: Record<string, unknown>): void {
    try {
      chrome.runtime.sendMessage({ type: 'TT_CONTENT_EVENT', event }).catch(() => {});
    } catch { /* extension reloaded or unavailable */ }
  }

  // ─── console.error ─────────────────────────────────────────────────────────

  const origError = console.error.bind(console);
  console.error = function (...args: unknown[]): void {
    origError(...args);
    try {
      send({
        kind: 'console_error',
        message: formatArgs(args),
        stack: extractStack(args),
        pageUrl: location.href,
      });
    } catch { /* never throw */ }
  };

  // ─── console.warn ──────────────────────────────────────────────────────────

  const origWarn = console.warn.bind(console);
  console.warn = function (...args: unknown[]): void {
    origWarn(...args);
    try {
      send({
        kind: 'console_warn',
        message: formatArgs(args),
        stack: extractStack(args),
        pageUrl: location.href,
      });
    } catch { /* never throw */ }
  };

  // ─── window.onerror ────────────────────────────────────────────────────────

  const origOnError = window.onerror;
  window.onerror = function (event, source, lineno, colno, error): boolean | void {
    try {
      send({
        kind: 'page_error',
        type: 'uncaught',
        message: (error?.message ?? String(event)).slice(0, MAX_MSG_LEN),
        source, lineno, colno,
        pageUrl: location.href,
      });
    } catch { /* never throw */ }
    if (typeof origOnError === 'function') return origOnError.call(window, event, source, lineno, colno, error);
  };

  // ─── unhandledrejection ────────────────────────────────────────────────────

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    try {
      const reason = e.reason;
      send({
        kind: 'page_error',
        type: 'unhandled_rejection',
        message: (reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)).slice(0, MAX_MSG_LEN),
        pageUrl: location.href,
      });
    } catch { /* never throw */ }
  });

  // ─── Web Vitals via PerformanceObserver ────────────────────────────────────
  //
  // Google's thresholds: https://web.dev/vitals/
  //   LCP: good < 2500ms | needs-improvement < 4000ms | poor >= 4000ms
  //   FCP: good < 1800ms | needs-improvement < 3000ms | poor >= 3000ms
  //   CLS: good < 0.1    | needs-improvement < 0.25   | poor >= 0.25
  //   INP: good < 200ms  | needs-improvement < 500ms  | poor >= 500ms
  //   TTFB: good < 800ms | needs-improvement < 1800ms | poor >= 1800ms

  function rateMs(value: number, good: number, ni: number) {
    return value < good ? 'good' : value < ni ? 'needs-improvement' : 'poor';
  }

  function sendVital(name: string, value: number, rating: string) {
    send({ kind: 'web_vital', name, value: Math.round(value * 10) / 10, rating, pageUrl: location.href });
  }

  // LCP — fires multiple times, last before first interaction is canonical
  try {
    let lcpValue = 0;
    const lcpObs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        lcpValue = (entry as PerformanceEntry & { renderTime?: number; loadTime?: number }).renderTime
          || (entry as PerformanceEntry & { loadTime?: number }).loadTime
          || entry.startTime;
      }
    });
    lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });

    // Finalize LCP on first user interaction or page hide
    const finalizeLcp = () => {
      if (lcpValue > 0) {
        sendVital('LCP', lcpValue, rateMs(lcpValue, 2500, 4000));
        lcpValue = 0; // only send once
      }
    };
    ['click', 'keydown', 'touchstart'].forEach((t) =>
      window.addEventListener(t, finalizeLcp, { once: true, capture: true, passive: true }),
    );
    document.addEventListener('visibilitychange', () => { if (document.hidden) finalizeLcp(); }, { once: true });
    // Fallback: send after 10s if no interaction
    setTimeout(finalizeLcp, 10000);
  } catch { /* PerformanceObserver not supported */ }

  // FCP — fires once
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === 'first-contentful-paint') {
          sendVital('FCP', entry.startTime, rateMs(entry.startTime, 1800, 3000));
        }
      }
    }).observe({ type: 'paint', buffered: true });
  } catch { /* */ }

  // CLS — cumulative, send on page hide
  try {
    let clsValue = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const ls = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
        if (!ls.hadRecentInput) clsValue += ls.value ?? 0;
      }
    }).observe({ type: 'layout-shift', buffered: true });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && clsValue >= 0) {
        sendVital('CLS', clsValue, rateMs(clsValue, 0.1, 0.25));
      }
    }, { once: true });
    // Fallback: send after 15s
    setTimeout(() => sendVital('CLS', clsValue, rateMs(clsValue, 0.1, 0.25)), 15000);
  } catch { /* */ }

  // INP — Interaction to Next Paint (Chrome 96+, replaces FID)
  try {
    let maxInp = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const dur = (entry as PerformanceEntry & { duration?: number }).duration ?? 0;
        if (dur > maxInp) maxInp = dur;
      }
    }).observe({ type: 'event', durationThreshold: 40, buffered: true } as PerformanceObserverInit);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && maxInp > 0) {
        sendVital('INP', maxInp, rateMs(maxInp, 200, 500));
      }
    }, { once: true });
  } catch { /* */ }

  // ─── Long Tasks (Main thread blocking > 50ms) ────────────────────────────
  // Long tasks are the primary cause of poor INP scores.
  // Chrome's DevTools Performance panel flags these with red triangles.

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        send({
          kind: 'long_task',
          duration: Math.round(entry.duration),
          startTime: Math.round(entry.startTime),
          pageUrl: location.href,
        });
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* longtask not supported */ }

  // ─── Memory Snapshots (Chrome-only: performance.memory) ───────────────────
  // Helps detect memory leaks — the "Memory Panel" equivalent.
  // Only available in Chrome; other browsers return undefined.

  type PerfWithMemory = typeof performance & {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
  };

  function sendMemorySnapshot() {
    const mem = (performance as PerfWithMemory).memory;
    if (!mem) return;
    send({
      kind: 'memory_snapshot',
      usedJSHeapSizeBytes: mem.usedJSHeapSize,
      totalJSHeapSizeBytes: mem.totalJSHeapSize,
      jsHeapSizeLimitBytes: mem.jsHeapSizeLimit,
      pageUrl: location.href,
    });
  }

  // Capture at page load and every 30 seconds
  window.addEventListener('load', () => setTimeout(sendMemorySnapshot, 2000), { once: true });
  setInterval(sendMemorySnapshot, 30000);

  // ─── Resource Timing (per-asset waterfall) ────────────────────────────────
  // Captures what the Network panel shows: per-asset type, size, duration.
  // Identifies broken assets (404 scripts, images) and large downloads.

  function sendResourceTiming() {
    try {
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const resources = entries.slice(-50).map((e) => ({
        name: e.name.split('?')[0] ?? e.name, // strip query params
        initiatorType: e.initiatorType,
        durationMs: Math.round(e.duration),
        transferSizeBytes: e.transferSize || 0,
        encodedBodySizeBytes: e.encodedBodySize || 0,
        failed: e.transferSize === 0 && e.duration > 0 && e.encodedBodySize === 0,
      }));
      if (resources.length > 0) {
        send({ kind: 'resource_timing', resources, pageUrl: location.href });
      }
    } catch { /* */ }
  }

  window.addEventListener('load', () => setTimeout(sendResourceTiming, 1500), { once: true });

  // ─── Page Timing (Navigation Timing API) ───────────────────────────────────

  function sendPageTiming() {
    try {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (!nav) return;
      const ttfb = nav.responseStart - nav.requestStart;
      const dcl = nav.domContentLoadedEventEnd - nav.startTime;
      const load = nav.loadEventEnd - nav.startTime;
      if (load <= 0) return; // not yet done

      send({
        kind: 'page_timing',
        ttfbMs: Math.round(ttfb),
        domContentLoadedMs: Math.round(dcl),
        loadEventMs: Math.round(load),
        redirectCount: nav.redirectCount ?? 0,
        pageUrl: location.href,
      });

      // TTFB as a web vital
      if (ttfb > 0) {
        sendVital('TTFB', ttfb, rateMs(ttfb, 800, 1800));
      }
    } catch { /* */ }
  }

  if (document.readyState === 'complete') {
    setTimeout(sendPageTiming, 0);
  } else {
    window.addEventListener('load', () => setTimeout(sendPageTiming, 100), { once: true });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function formatArgs(args: unknown[]): string {
    return args.map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ').slice(0, MAX_MSG_LEN);
  }

  function extractStack(args: unknown[]): string | undefined {
    const err = args.find((a) => a instanceof Error) as Error | undefined;
    return err?.stack?.slice(0, 400);
  }
})();
