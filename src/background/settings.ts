import { DEFAULT_SETTINGS, type Settings } from "@shared/types";

let cache: Settings | null = null;

export async function getSettings(): Promise<Settings> {
  if (cache) return cache;
  const { settings } = await chrome.storage.sync.get("settings");
  cache = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
  return cache;
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await getSettings();
  cache = { ...cur, ...patch };
  cache.threads = Math.min(16, Math.max(1, Math.round(cache.threads)));
  cache.maxRetries = Math.min(10, Math.max(0, Math.round(cache.maxRetries)));
  cache.blockedHosts = [...new Set(cache.blockedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean))];
  await chrome.storage.sync.set({ settings: cache });
  return cache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.settings) cache = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue ?? {}) };
});
