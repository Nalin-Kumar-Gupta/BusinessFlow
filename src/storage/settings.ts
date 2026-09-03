import type { TestTraceSettings } from '../core/settings.js';
import { DEFAULT_SETTINGS } from '../core/settings.js';

const SETTINGS_KEY = 'tt:settings';

export async function getSettings(): Promise<TestTraceSettings> {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(r[SETTINGS_KEY] as Partial<TestTraceSettings> ?? {}) };
}

export async function saveSettings(patch: Partial<TestTraceSettings>): Promise<void> {
  const current = await getSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, ...patch } });
}

export async function resetSettings(): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS } });
}
