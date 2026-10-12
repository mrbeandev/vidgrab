import type { MediaItem } from "@shared/types";
import { broadcast } from "@shared/messages";

/**
 * Per-tab detections. Kept in chrome.storage.session so they survive service-worker
 * restarts and are automatically dropped when the browser closes.
 */
const MAX_PER_TAB = 60;
const key = (tabId: number) => `tab:${tabId}`;
const mem = new Map<number, Record<string, MediaItem>>();
const loading = new Map<number, Promise<Record<string, MediaItem>>>();

/** Load (once) the per-tab map; concurrent callers share the same promise so nobody clobbers `mem`. */
function mapFor(tabId: number): Promise<Record<string, MediaItem>> {
  const m = mem.get(tabId);
  if (m) return Promise.resolve(m);
  let p = loading.get(tabId);
  if (!p) {
    p = chrome.storage.session.get(key(tabId)).then((res) => {
      const existing = mem.get(tabId);
      if (existing) return existing;
      const map = (res[key(tabId)] as Record<string, MediaItem>) ?? {};
      mem.set(tabId, map);
      return map;
    });
    p.finally(() => loading.delete(tabId));
    loading.set(tabId, p);
  }
  return p;
}

export async function getTabMedia(tabId: number): Promise<MediaItem[]> {
  const map = await mapFor(tabId);
  return Object.values(map).sort((a, b) => b.detectedAt - a.detectedAt);
}

export async function addTabMedia(item: MediaItem): Promise<boolean> {
  const map = await mapFor(item.tabId);
  if (map[item.id]) return false;
  if (Object.keys(map).length >= MAX_PER_TAB) return false;
  map[item.id] = item;
  await chrome.storage.session.set({ [key(item.tabId)]: map });
  updateBadge(item.tabId, Object.keys(map).length);
  broadcast({ type: "MEDIA_UPDATED", tabId: item.tabId });
  return true;
}

export async function patchTabMedia(tabId: number, id: string, patch: Partial<MediaItem>): Promise<void> {
  const map = await mapFor(tabId);
  if (!map[id]) return;
  map[id] = { ...map[id], ...patch };
  await chrome.storage.session.set({ [key(tabId)]: map });
}

export async function clearTabMedia(tabId: number): Promise<void> {
  mem.delete(tabId);
  await chrome.storage.session.remove(key(tabId));
  updateBadge(tabId, 0);
  broadcast({ type: "MEDIA_UPDATED", tabId });
}

export async function removeHostFromAllTabs(host: string): Promise<void> {
  for (const [tabId, map] of mem) {
    let changed = false;
    for (const [id, it] of Object.entries(map)) {
      if (new URL(it.url).hostname === host) {
        delete map[id];
        changed = true;
      }
    }
    if (changed) {
      await chrome.storage.session.set({ [key(tabId)]: map });
      updateBadge(tabId, Object.keys(map).length);
      broadcast({ type: "MEDIA_UPDATED", tabId });
    }
  }
}

export function updateBadge(tabId: number, count: number): void {
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" }).catch(() => {});
}

export function hasUrl(tabId: number, url: string): boolean {
  const map = mem.get(tabId);
  if (!map) return false;
  for (const it of Object.values(map)) if (it.url === url) return true;
  return false;
}
