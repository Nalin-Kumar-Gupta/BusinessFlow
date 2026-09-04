// Content script injection management.
// Scripts are NOT in the manifest (which would require static host_permissions).
// Instead, they are injected dynamically after optional permission is granted.

import { originToPattern } from '../core/url.js';

function getRequestableOriginPatterns(origins: string[]): string[] {
  const out = new Set<string>();
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      out.add(originToPattern(url.origin));
    } catch {
      continue;
    }
  }
  return [...out];
}

export async function injectIntoMatchingTabs(scopeOrigins: string[]): Promise<void> {
  if (!scopeOrigins.length) return;
  const { extractOrigin } = await import('../core/url.js');

  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({});
    tabs = tabs.filter((t) => {
      const u = t.url ?? '';
      if (u.startsWith('chrome://') || u.startsWith('about:')) return false;
      const origin = u.startsWith('http') ? extractOrigin(u) : u;
      return scopeOrigins.includes(origin) || scopeOrigins.includes(extractOrigin(u));
    });
  } catch {
    tabs = [];
  }

  for (const tab of tabs) {
    if (!tab.id) continue;
    await injectIntoTab(tab.id).catch(() => { /* tab may not support injection */ });
  }
}

export async function injectIntoTab(tabId: number): Promise<void> {
  try {
    // Isolated world script (click capture, DOM observation, indicator)
    // Inject into all frames so interactions inside iframes are captured.
    // UI overlays remain top-frame only via guards in isolated.ts.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content/isolated.js'],
    });

    // Main world script (console.error, window.onerror)
    // Inject into all frames so we capture iframe-level runtime/page errors too.
    // Keep isolated.js top-frame only to avoid duplicate overlays/panels.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content/main-world.js'],
      world: 'MAIN',
    });

    // Indicator CSS
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/indicator.css'],
    });
  } catch (err) {
    console.debug('[TestTrace] inject failed for tab', tabId, err);
  }
}

export async function deactivateInAllTabs(scopeOrigins: string[]): Promise<void> {
  if (!scopeOrigins.length) return;
  const { extractOrigin } = await import('../core/url.js');
  let tabs: chrome.tabs.Tab[];
  try {
    const all = await chrome.tabs.query({});
    tabs = all.filter(t => {
      const u = t.url ?? '';
      if (u.startsWith('chrome://') || u.startsWith('about:')) return false;
      const origin = u.startsWith('http') ? extractOrigin(u) : u;
      return scopeOrigins.includes(origin) || scopeOrigins.includes(extractOrigin(u));
    });
  } catch { tabs = []; }

  for (const tab of tabs) {
    if (!tab.id) continue;
    chrome.tabs.sendMessage(tab.id, { type: 'TT_CONTENT_DEACTIVATE' }).catch(() => {});
  }
}

export async function requestOptionalPermission(origins: string[]): Promise<boolean> {
  const patterns = getRequestableOriginPatterns(origins);
  if (!patterns.length) return false;

  const hasAlready = await chrome.permissions.contains({ origins: patterns }).catch(() => false);
  if (hasAlready) return true;

  return chrome.permissions.request({ origins: patterns }).catch(() => false);
}

export function getSessionScopePermissionPatterns(origins: string[]): string[] {
  return getRequestableOriginPatterns(origins);
}
