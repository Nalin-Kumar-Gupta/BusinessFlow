(function () {
  'use strict';

  const PATCH_GUARD = '__tt_network_interceptor_v1__';
  const win = window as Window & { [PATCH_GUARD]?: boolean };
  if (win[PATCH_GUARD]) return;
  win[PATCH_GUARD] = true;

  const STATIC_EXT_REGEX = /\.(js|css|png|jpe?g|gif|svg|woff2?|ico|map)(\?.*)?$/i;

  function isApiLikeUrl(rawUrl: string): boolean {
    try {
      const u = new URL(rawUrl, location.href);
      if (!/^https?:$/.test(u.protocol)) return false;
      if (STATIC_EXT_REGEX.test(u.href)) return false;
      return true;
    } catch {
      return false;
    }
  }

  function safeStringify(value: unknown): string | undefined {
    if (value == null) return undefined;
    if (typeof value === 'string') return value.slice(0, 20_000);
    if (value instanceof URLSearchParams) return value.toString().slice(0, 20_000);
    if (value instanceof FormData) {
      const pairs: string[] = [];
      for (const [k, v] of value.entries()) pairs.push(`${k}=${String(v)}`);
      return pairs.join('&').slice(0, 20_000);
    }
    try {
      return JSON.stringify(value).slice(0, 20_000);
    } catch {
      return String(value).slice(0, 20_000);
    }
  }

  function postNetworkLog(payload: {
    url: string;
    method: string;
    status: number;
    requestBody?: string;
    responseBody?: string;
    timestamp: number;
    durationMs?: number;
  }): void {
    try {
      chrome.runtime.sendMessage({ type: 'TT_NETWORK_LOG', payload }).catch(() => {});
    } catch {
      // extension runtime unavailable
    }
  }

  async function readRequestBody(input: RequestInfo | URL, init?: RequestInit): Promise<string | undefined> {
    try {
      if (init && 'body' in init) return safeStringify(init.body);
      if (typeof input !== 'string' && !(input instanceof URL)) {
        const clone = input.clone();
        const text = await clone.text();
        return text ? text.slice(0, 20_000) : undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  function shouldCaptureResponseBody(contentType: string | null): boolean {
    if (!contentType) return false;
    const lower = contentType.toLowerCase();
    return lower.includes('application/json')
      || lower.includes('text/html')
      || lower.includes('application/graphql');
  }

  async function readResponseBody(resp: Response): Promise<string | undefined> {
    if (!shouldCaptureResponseBody(resp.headers.get('content-type'))) return undefined;
    try {
      const clone = resp.clone();
      const text = await clone.text();
      return text ? text.slice(0, 20_000) : undefined;
    } catch {
      return undefined;
    }
  }

  try {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const reqUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      const method = (init?.method || (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET') || 'GET').toUpperCase();

      if (!isApiLikeUrl(reqUrl)) return nativeFetch(input, init);

      const requestBody = await readRequestBody(input, init);
      const startTime = performance.now();
      try {
        const response = await nativeFetch(input, init);
        const durationMs = Math.round(performance.now() - startTime);
        const responseBody = await readResponseBody(response);
        postNetworkLog({
          url: reqUrl,
          method,
          status: response.status || 0,
          requestBody,
          responseBody,
          timestamp: Date.now(),
          durationMs,
        });
        return response;
      } catch (err) {
        const durationMs = Math.round(performance.now() - startTime);
        postNetworkLog({
          url: reqUrl,
          method,
          status: 0,
          requestBody,
          responseBody: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
          durationMs,
        });
        throw err;
      }
    };

    const xhrOpen = XMLHttpRequest.prototype.open;
    const xhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function patchedOpen(
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ): void {
      (this as XMLHttpRequest & { __tt_url?: string; __tt_method?: string }).__tt_url = String(url);
      (this as XMLHttpRequest & { __tt_url?: string; __tt_method?: string }).__tt_method = (method || 'GET').toUpperCase();
      xhrOpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
    };

    XMLHttpRequest.prototype.send = function patchedSend(body?: Document | XMLHttpRequestBodyInit | null): void {
      const xhr = this as XMLHttpRequest & { __tt_url?: string; __tt_method?: string; __tt_reqBody?: string; __tt_startTime?: number };
      const url = xhr.__tt_url || '';
      if (!isApiLikeUrl(url)) {
        xhrSend.call(this, body as XMLHttpRequestBodyInit | null | undefined);
        return;
      }

      xhr.__tt_reqBody = safeStringify(body);
      xhr.__tt_startTime = performance.now();

      this.addEventListener('load', () => {
        const ct = this.getResponseHeader('content-type');
        const bodyText = shouldCaptureResponseBody(ct)
          && typeof this.responseText === 'string'
          ? this.responseText.slice(0, 20_000)
          : undefined;

        postNetworkLog({
          url,
          method: xhr.__tt_method || 'GET',
          status: this.status || 0,
          requestBody: xhr.__tt_reqBody,
          responseBody: bodyText,
          timestamp: Date.now(),
          durationMs: Math.round(performance.now() - (xhr.__tt_startTime ?? performance.now())),
        });
      });

      this.addEventListener('error', () => {
        postNetworkLog({
          url,
          method: xhr.__tt_method || 'GET',
          status: this.status || 0,
          requestBody: xhr.__tt_reqBody,
          responseBody: 'XMLHttpRequest error',
          timestamp: Date.now(),
          durationMs: Math.round(performance.now() - (xhr.__tt_startTime ?? performance.now())),
        });
      });

      xhrSend.call(this, body as XMLHttpRequestBodyInit | null | undefined);
    };
  } catch {
    // Never break host app
  }
})();
