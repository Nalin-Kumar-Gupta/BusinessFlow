import type { TestEvent, NetPhaseEvent, RequestView, RequestOutcome } from './types.js';
import { safeOrigin, safePath } from './url.js';

export function groupByRequest(events: readonly TestEvent[]): Map<string, NetPhaseEvent[]> {
  const map = new Map<string, NetPhaseEvent[]>();
  for (const ev of events) {
    if (ev.kind !== 'net_phase') continue;
    let g = map.get(ev.requestId);
    if (!g) { g = []; map.set(ev.requestId, g); }
    g.push(ev);
  }
  for (const g of map.values()) g.sort((a, b) => a.seq - b.seq);
  return map;
}

export function foldRequest(phases: NetPhaseEvent[]): RequestView {
  const first = phases[0];
  if (!first) throw new Error('foldRequest: empty phases');

  let statusCode: number | undefined;
  let statusLine: string | undefined;
  let responseHeaders: Record<string, string> | undefined;
  let droppedHeaderCount = first.droppedHeaderCount ?? 0;
  let fromCache: boolean | undefined;
  let responseSize: number | undefined;
  let errorText: string | undefined;
  let endedAt: number | undefined;
  let outcome: RequestOutcome = 'pending';

  for (const p of phases) {
    if (p.statusCode !== undefined) statusCode = p.statusCode;
    if (p.statusLine !== undefined) statusLine = p.statusLine;
    if (p.responseHeaders !== undefined) responseHeaders = p.responseHeaders;
    if (p.droppedHeaderCount !== undefined) droppedHeaderCount = p.droppedHeaderCount;
    if (p.fromCache !== undefined) fromCache = p.fromCache;
    if (p.responseSize !== undefined) responseSize = p.responseSize;
    if (p.errorText !== undefined) errorText = p.errorText;
    if (p.phase === 'complete') {
      endedAt = p.ts;
      outcome = statusCode !== undefined && statusCode >= 400 ? 'http_error' : 'success';
    }
    if (p.phase === 'error') { endedAt = p.ts; outcome = 'network_error'; }
  }

  return {
    requestId: first.requestId,
    sessionId: first.sessionId,
    method: first.method,
    url: first.url,
    origin: safeOrigin(first.url),
    path: safePath(first.url),
    resourceType: first.resourceType,
    tabId: first.tabId,
    frameId: first.frameId,
    initiator: first.initiator,
    startedAt: first.ts,
    endedAt,
    durationMs: endedAt !== undefined ? endedAt - first.ts : undefined,
    statusCode,
    statusLine,
    responseHeaders,
    droppedHeaderCount,
    fromCache,
    responseSize,
    errorText,
    outcome,
    seq: first.seq,
  };
}
