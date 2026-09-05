// webRequest → NetPhaseEvent pipeline + API-lifecycle screenshot triggers.
//
// Screenshot philosophy (API-driven, not time-driven):
//   1. When a significant API starts AND will take > 500ms:
//      → "loading state" screenshot after 300ms (shows skeleton/spinner)
//   2. When that API completes:
//      → "loaded state" screenshot after 400ms settle (React/Vue re-renders)
//   3. Both screenshots are labeled with the inferred component name
//
// Significance filter — we only screenshot for:
//   - xmlhttprequest / fetch (not images, fonts, CSS, scripts, favicons)
//   - First-party origin (matches scope)
//   - Max 3 "api_complete" screenshots per screen visit (budget)
//
// This gives us semantically meaningful screenshots:
//   "Inventory Health — loading" → "Inventory Health — loaded"
// instead of arbitrary time-based captures.

import type { TestEvent } from '../core/types.js';
import { newEventId } from '../core/ids.js';
import { redactUrl, urlMatchesScope } from '../core/url.js';
import { filterResponseHeaders } from '../core/headers.js';
import { appendEvent } from '../storage/db.js';
import { getActiveSessionId, isPaused, getScopeOrigins, nextSeq } from '../storage/session-state.js';
import { requestCapture } from './screenshot.js';
import { incrementCounter } from './session.js';

// ─── Component inference from API path ───────────────────────────────────────
// This is what makes screenshot labels meaningful instead of "screenshot #4"

const COMPONENT_MAP: Array<[RegExp, string]> = [
  [/\/inventory-health\/data/,              'Inventory Health Overview'],
  [/\/inventory-health\/details/,           'Inventory Health Details'],
  [/\/inventory-health\/filters/,           'Inventory Health Filters'],
  [/\/inventory-health\/unavailable/,       'Unavailable Inventory'],
  [/\/critical-alerts?\/banner/,            'Critical Alerts Banner'],
  [/\/critical-alert-adherence\/consolidated/, 'Alert Adherence Metrics'],
  [/\/critical-alert-adherence/,            'Alert Adherence'],
  [/\/recommendations\/insights/,           'Recommendations Insights'],
  [/\/recommendations\/search/,             'Recommendations Table'],
  [/\/recommendations\/filters/,            'Recommendations Filters'],
  [/\/recommendations\/actions/,            'Recommendation Actions'],
  [/\/supplier-eta-missing-po\/search/,     'Supplier ETA Missing PO'],
  [/\/supplier-eta-missing-po\/filters/,    'Supplier ETA Filters'],
  [/\/supplier-eta-missing-po\/action-alert/, 'Supplier Alert'],
  [/\/store-orders-tobe\/search/,           'Store Order Layout'],
  [/\/store-orders-tobe\/filters/,          'Store Order Filters'],
  [/\/stockout-prevention-insights/,        'Stockout Prevention'],
  [/\/warehouse-otif\/performance/,         'Warehouse OTIF Performance'],
  [/\/warehouse-otif\/search/,              'Warehouse OTIF Table'],
  [/\/supplier-otif\/search/,               'Supplier OTIF Table'],
  [/\/supplier-otif\/filter-suggestions/,   'Supplier OTIF Filters'],
  [/\/orders\/create-orders/,               'Order Creation'],
  [/\/ordering\/.*\/order-summary/,         'Order Summary'],
  [/\/ordering\/.*\/tracker/,               'Order Tracker'],
  [/\/review-stale-po/,                     'Stale PO Review'],
  [/\/inventory-management\//,              'Inventory Management'],
  [/\/article-deep-dive\/header/,           'Article Deep Dive Header'],
  [/\/article-deep-dive\/weekly/,           'Article Weekly Detail'],
  [/\/article-deep-dive\/ai-summary/,       'Article AI Summary'],
  [/\/inventory\/overtime/,                 'Inventory Overtime'],
  [/\/replenishment\/filters/,              'Replenishment Filters'],
  [/\/config/,                              'App Configuration'],
];

export function inferComponentFromUrl(url: string): string | undefined {
  try {
    const path = new URL(url).pathname;
    for (const [pattern, name] of COMPONENT_MAP) {
      if (pattern.test(path)) return name;
    }
    // Generic fallback: last two path segments, humanized
    const parts = path.split('/').filter(Boolean).slice(-2);
    if (parts.length >= 1) return parts.join(' / ').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  } catch { /* */ }
  return undefined;
}

// ─── Significance filter ──────────────────────────────────────────────────────

const SIGNIFICANT_TYPES = new Set(['xmlhttprequest', 'fetch', 'other']);
const FAVICON_PATTERN = /favicon\.ico$/i;

function isSignificantRequest(type: string, url: string): boolean {
  if (!SIGNIFICANT_TYPES.has(type)) return false;
  if (FAVICON_PATTERN.test(url)) return false;
  return true;
}

// Per-tab API screenshot budget (in-memory, reset on SW restart)
// Key: tabId → count of api_complete screenshots taken this screen visit
const tabApiShotCount = new Map<number, number>();
const MAX_API_SHOTS_PER_VISIT = 4; // max api_complete + api_loading screenshots per screen

// Track pending requests for loading-state screenshots
// requestId → { tabId, sessionId, startTs, loadingShotFired }
const pendingRequests = new Map<string, {
  tabId: number;
  sessionId: string;
  startTs: number;
  loadingShotFired: boolean;
  componentName?: string;
}>();

// ─── Listeners ────────────────────────────────────────────────────────────────

type WebReqFilter = { urls: string[] };
const FILTER_ALL: WebReqFilter = { urls: ['<all_urls>'] };

let onBeforeRequestCb: ((d: chrome.webRequest.RequestDetails) => void) | null = null;
let onHeadersReceivedCb: ((d: chrome.webRequest.HeadersReceivedDetails) => void) | null = null;
let onCompletedCb: ((d: chrome.webRequest.CompletedDetails) => void) | null = null;
let onErrorOccurredCb: ((d: chrome.webRequest.ErrorDetails) => void) | null = null;

export function attachNetListeners(): void {
  if (onBeforeRequestCb) return;
  onBeforeRequestCb = (d) => void handleBeforeRequest(d);
  onHeadersReceivedCb = (d) => void handleHeadersReceived(d);
  onCompletedCb = (d) => void handleCompleted(d);
  onErrorOccurredCb = (d) => void handleErrorOccurred(d);
  chrome.webRequest.onBeforeRequest.addListener(onBeforeRequestCb, FILTER_ALL);
  chrome.webRequest.onHeadersReceived.addListener(onHeadersReceivedCb, FILTER_ALL, ['responseHeaders']);
  chrome.webRequest.onCompleted.addListener(onCompletedCb, FILTER_ALL, ['responseHeaders']);
  chrome.webRequest.onErrorOccurred.addListener(onErrorOccurredCb, FILTER_ALL);
}

export function detachNetListeners(): void {
  if (onBeforeRequestCb) chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequestCb);
  if (onHeadersReceivedCb) chrome.webRequest.onHeadersReceived.removeListener(onHeadersReceivedCb);
  if (onCompletedCb) chrome.webRequest.onCompleted.removeListener(onCompletedCb);
  if (onErrorOccurredCb) chrome.webRequest.onErrorOccurred.removeListener(onErrorOccurredCb);
  onBeforeRequestCb = null; onHeadersReceivedCb = null; onCompletedCb = null; onErrorOccurredCb = null;
  pendingRequests.clear();
  tabApiShotCount.clear();
}

export function resetTabApiShotBudget(tabId: number): void {
  tabApiShotCount.set(tabId, 0);
}

export function getInFlightRequestCount(tabId: number): number {
  let count = 0;
  for (const pending of pendingRequests.values()) {
    if (pending.tabId === tabId) count += 1;
  }
  return count;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function getSessionIfActive(url: string, tabId: number): Promise<{ sessionId: string; scopeOrigins: string[] } | null> {
  const sessionId = await getActiveSessionId();
  if (!sessionId || tabId < 0) return null;
  const scopeOrigins = await getScopeOrigins();
  if (!urlMatchesScope(url, scopeOrigins)) return null;
  return { sessionId, scopeOrigins };
}

async function handleBeforeRequest(d: chrome.webRequest.RequestDetails): Promise<void> {
  const ctx = await getSessionIfActive(d.url, d.tabId);
  if (!ctx) return;

  const seq = await nextSeq();
  const componentName = inferComponentFromUrl(d.url);
  pendingRequests.set(d.requestId, {
    tabId: d.tabId,
    sessionId: ctx.sessionId,
    startTs: d.timeStamp,
    loadingShotFired: false,
    componentName,
  });

  const ev: TestEvent = {
    id: newEventId(), sessionId: ctx.sessionId, ts: d.timeStamp, seq,
    kind: 'net_phase', tabId: d.tabId, frameId: d.frameId,
    confidence: 'observed', phase: 'start', requestId: d.requestId,
    method: d.method, url: redactUrl(d.url), resourceType: d.type,
    initiator: d.initiator, droppedHeaderCount: 0,
  };
  await appendEvent(ev);
  await incrementCounter(ctx.sessionId, 'events');
  await incrementCounter(ctx.sessionId, 'networkRequests');

  // Schedule "loading state" screenshot for significant slow requests.
  // After 400ms, if the request is still pending → the UI is likely showing a spinner.
  if (isSignificantRequest(d.type, d.url)) {
    const reqId = d.requestId;
    setTimeout(() => {
      const pending = pendingRequests.get(reqId);
      if (!pending || pending.loadingShotFired) return;
      const budgetKey = pending.tabId;
      const count = tabApiShotCount.get(budgetKey) ?? 0;
      if (count >= MAX_API_SHOTS_PER_VISIT) return;
      pending.loadingShotFired = true;
      tabApiShotCount.set(budgetKey, count + 1);
      void requestCapture({
        sessionId: pending.sessionId,
        tabId: pending.tabId,
        trigger: 'api_loading',
        triggerEventId: ev.id,
        componentName: pending.componentName,
        apiRequestId: reqId,
        capturePhase: 'loading',
        pageUrl: d.url,
        priority: 'low',
      });
    }, 400);
  }
}

async function handleHeadersReceived(d: chrome.webRequest.HeadersReceivedDetails): Promise<void> {
  const pending = pendingRequests.get(d.requestId);
  if (!pending) return;
  if (await isPaused()) return;

  const { allowed, droppedCount } = filterResponseHeaders(d.responseHeaders ?? []);
  const seq = await nextSeq();
  const ev: TestEvent = {
    id: newEventId(), sessionId: pending.sessionId, ts: d.timeStamp, seq,
    kind: 'net_phase', tabId: d.tabId, confidence: 'observed', phase: 'headers',
    requestId: d.requestId, method: d.method, url: redactUrl(d.url),
    resourceType: d.type, statusCode: d.statusCode, statusLine: d.statusLine,
    responseHeaders: allowed, droppedHeaderCount: droppedCount, fromCache: d.fromCache,
  };
  await appendEvent(ev);
  await incrementCounter(pending.sessionId, 'events');
}

async function handleCompleted(d: chrome.webRequest.CompletedDetails): Promise<void> {
  const pending = pendingRequests.get(d.requestId);
  if (!pending) return;
  pendingRequests.delete(d.requestId);

  const { allowed, droppedCount } = filterResponseHeaders(d.responseHeaders ?? []);
  const seq = await nextSeq();
  const isError = d.statusCode >= 400;

  const ev: TestEvent = {
    id: newEventId(), sessionId: pending.sessionId, ts: d.timeStamp, seq,
    kind: 'net_phase', tabId: d.tabId, confidence: 'observed', phase: 'complete',
    requestId: d.requestId, method: d.method, url: redactUrl(d.url),
    resourceType: d.type, statusCode: d.statusCode, statusLine: d.statusLine,
    responseHeaders: allowed, droppedHeaderCount: droppedCount, fromCache: d.fromCache,
  };
  await appendEvent(ev);
  await incrementCounter(pending.sessionId, 'events');

  if (isError) {
    await incrementCounter(pending.sessionId, 'httpErrors');
    // Error screenshots are always captured (high priority, not budget-limited)
    setTimeout(() => {
      void requestCapture({
        sessionId: pending.sessionId,
        tabId: pending.tabId,
        trigger: 'http_error',
        triggerEventId: ev.id,
        componentName: pending.componentName,
        apiRequestId: d.requestId,
        capturePhase: 'complete',
        pageUrl: d.url,
        priority: 'high',
      });
    }, 300);
    return;
  }

  // For successful significant APIs: "loaded state" screenshot
  // Budget-controlled to avoid screenshot storms
  if (isSignificantRequest(d.type, d.url)) {
    const budgetKey = pending.tabId;
    const count = tabApiShotCount.get(budgetKey) ?? 0;
    if (count < MAX_API_SHOTS_PER_VISIT) {
      tabApiShotCount.set(budgetKey, count + 1);
      const duration = d.timeStamp - pending.startTs;

      // Only screenshot if this was a meaningful request (not instant cache hits)
      // Cache hits < 50ms don't cause visible UI changes worth capturing
      if (duration >= 200 || !d.fromCache) {
        setTimeout(() => {
          void requestCapture({
            sessionId: pending.sessionId,
            tabId: pending.tabId,
            trigger: 'api_complete',
            triggerEventId: ev.id,
            componentName: pending.componentName,
            apiRequestId: d.requestId,
            capturePhase: 'complete',
            pageUrl: d.url,
            // Higher priority for slower APIs — they're more likely to show meaningful UI change
            priority: duration > 3000 ? 'high' : 'normal',
          });
        }, 400); // 400ms: React/Vue/Angular re-render settle time
      }
    }
  }
}

async function handleErrorOccurred(d: chrome.webRequest.ErrorDetails): Promise<void> {
  const pending = pendingRequests.get(d.requestId);
  if (!pending) return;
  pendingRequests.delete(d.requestId);

  const seq = await nextSeq();
  const ev: TestEvent = {
    id: newEventId(), sessionId: pending.sessionId, ts: d.timeStamp, seq,
    kind: 'net_phase', tabId: d.tabId, confidence: 'observed', phase: 'error',
    requestId: d.requestId, method: d.method, url: redactUrl(d.url),
    resourceType: d.type, errorText: d.error, fromCache: d.fromCache, droppedHeaderCount: 0,
  };
  await appendEvent(ev);
  await incrementCounter(pending.sessionId, 'events');
  await incrementCounter(pending.sessionId, 'networkErrors');

  setTimeout(() => {
    void requestCapture({
      sessionId: pending.sessionId,
      tabId: pending.tabId,
      trigger: 'network_error',
      triggerEventId: ev.id,
      componentName: pending.componentName,
      apiRequestId: d.requestId,
      capturePhase: 'complete',
      pageUrl: d.url,
      priority: 'high',
    });
  }, 300);
}
