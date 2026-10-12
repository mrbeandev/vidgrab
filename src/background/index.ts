import type { Msg, HlsInspectResult } from "@shared/messages";
import { parsePlaylist, variantLabel } from "@shared/m3u8";
import { tracksFromCodecs } from "@shared/probe-parsers";
import { splitHeaders } from "@shared/headers";
import { hostOf } from "@shared/utils";
import { startSniffer } from "./sniffer";
import { probeItem } from "./probe";
import { clearTabMedia, getTabMedia, patchTabMedia, removeHostFromAllTabs, updateBadge } from "./tabMedia";
import { getSettings, setSettings } from "./settings";
import { cleanupOrphanRules, ensureRule, removeRule } from "./rules";
import {
  cancelJob,
  getJobs,
  pauseJob,
  removeJob,
  resumeJob,
  retryJob,
  restartJob,
  skipFailed,
  storageInfo,
  cleanStorage,
  ruleKey,
  saveJob,
  showInFolder,
  startDownload,
  updateJob,
} from "./jobs";
import { broadcast } from "@shared/messages";

chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => void cleanupOrphanRules());
chrome.runtime.onStartup.addListener(() => void cleanupOrphanRules());

startSniffer();

// ---- tab lifecycle
chrome.tabs.onRemoved.addListener((tabId) => void clearTabMedia(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && info.url) void clearTabMedia(tabId);
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const list = await getTabMedia(tabId);
  updateBadge(tabId, list.length);
});

// ---- keep SW alive while jobs are running (alarms every 30s nudge is enough with offscreen traffic)
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {});

/**
 * Estimate the total size of a media playlist from real segment sizes.
 * Byte-range playlists: exact (sum of ranges). Otherwise HEAD up to 6 segments spread across the timeline.
 */
async function measureSize(
  pl: import("@shared/m3u8").MediaPlaylist,
  headers: Record<string, string>,
  ruleKey: string,
  ruleHeaders: Record<string, string>,
): Promise<number | undefined> {
  const segs = pl.segments;
  if (segs.every((s) => s.byteRange)) return segs.reduce((n, s) => n + s.byteRange!.length, 0);
  const picks = [...new Set([0.1, 0.25, 0.4, 0.55, 0.7, 0.85].map((f) => Math.min(segs.length - 1, Math.floor(f * segs.length))))];
  await ensureRule(ruleKey, ruleHeaders, [...new Set(picks.map((i) => hostOf(segs[i].uri)))]);
  let bytes = 0;
  let secs = 0;
  await Promise.all(
    picks.map(async (i) => {
      const s = segs[i];
      try {
        let len = 0;
        const h = await fetch(s.uri, { method: "HEAD", headers, credentials: "include" });
        if (h.ok) len = parseInt(h.headers.get("content-length") || "0", 10);
        if (!len) {
          // some CDNs don't answer HEAD – ask for 1 byte and read the total from Content-Range
          const g = await fetch(s.uri, { headers: { ...headers, range: "bytes=0-0" }, credentials: "include" });
          const m = /\/(\d+)/.exec(g.headers.get("content-range") || "");
          len = m ? parseInt(m[1], 10) : 0;
          await g.body?.cancel().catch(() => {});
        }
        if (len > 0 && s.duration > 0) {
          bytes += len;
          secs += s.duration;
        }
      } catch {
        /* ignore */
      }
    }),
  );
  if (!secs) return undefined;
  return Math.round((bytes / secs) * pl.duration);
}

// ---- HLS inspection (fetch + parse master/media playlist)
async function inspectHls(item: Parameters<typeof startDownload>[0]): Promise<HlsInspectResult> {
  const key = `item:${item.id}`;
  try {
    await ensureRule(key, item.headers, [hostOf(item.url)]);
    const { fetchHeaders } = splitHeaders(item.headers);
    const res = await fetch(item.url, { headers: fetchHeaders, credentials: "include", method: item.method });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const pl = parsePlaylist(text, item.url);
    if (pl.kind === "master") {
      let duration: number | undefined;
      // Size estimate: BANDWIDTH is the *peak* bitrate (often 2–3× the average). Measure real segment
      // sizes (HEAD on a few segments spread over the video) for each variant and extrapolate.
      await Promise.all(
        pl.variants.map(async (v) => {
          const tr = tracksFromCodecs(v.codecs, !!v.height);
          v.hasAudio = tr?.audio;
          try {
            await ensureRule(key, item.headers, [hostOf(v.url)]);
            const r2 = await fetch(v.url, { headers: fetchHeaders, credentials: "include" });
            const p2 = parsePlaylist(await r2.text(), v.url);
            if (p2.kind !== "media" || !p2.segments.length) return;
            duration ??= p2.duration;
            v.estSize = await measureSize(p2, fetchHeaders, key, item.headers);
          } catch {
            /* fall back below */
          }
          if (!v.estSize && duration && v.bandwidth) v.estSize = Math.round((v.bandwidth / 8) * duration * 0.6);
        }),
      );
      await patchTabMedia(item.tabId, item.id, { variants: pl.variants, duration });
      return { ok: true, isMaster: true, variants: pl.variants, audioRenditions: pl.audio, duration };
    }
    await patchTabMedia(item.tabId, item.id, { duration: pl.duration, isLive: !pl.endList });
    return {
      ok: true,
      isMaster: false,
      variants: [{ url: item.url, bandwidth: 0, label: variantLabel({ bandwidth: 0 }) }],
      audioRenditions: [],
      duration: pl.duration,
      isLive: !pl.endList,
      segmentCount: pl.segments.length,
      encrypted: pl.encrypted,
      fmp4: pl.fmp4,
    };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e), isMaster: false, variants: [], audioRenditions: [] };
  } finally {
    // keep the preview rule for a while, popup may play it; remove after 2 min
    setTimeout(() => void removeRule(key), 120_000);
  }
}

// ---- message router
chrome.runtime.onMessage.addListener((raw: Msg & { __target?: string }, sender, sendResponse) => {
  if (raw.__target === "offscreen") return false; // not for us
  const done = (p: Promise<unknown>) => {
    p.then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
    return true;
  };
  switch (raw.type) {
    case "GET_TAB_MEDIA":
      return done(getTabMedia(raw.tabId));
    case "CLEAR_TAB_MEDIA":
      return done(clearTabMedia(raw.tabId));
    case "GET_SETTINGS":
      return done(getSettings());
    case "SET_SETTINGS":
      return done(
        setSettings(raw.settings).then(async (s) => {
          broadcast({ type: "SETTINGS_UPDATED", settings: s });
          for (const h of s.blockedHosts) await removeHostFromAllTabs(h);
          return s;
        }),
      );
    case "INSPECT_HLS":
      return done(inspectHls(raw.item));
    case "PROBE_MEDIA":
      return done(probeItem(raw.item));
    case "SET_THUMBNAIL":
      return done(patchTabMedia(raw.tabId, raw.id, { thumbnail: raw.dataUrl }));
    case "ENSURE_HEADER_RULE":
      return done(ensureRule(`item:${raw.item.id}`, raw.item.headers, [hostOf(raw.item.url)]).then(() => true));
    case "START_DOWNLOAD":
      return done(startDownload(raw.item, raw.variant, raw.audioRendition, raw.fileName));
    case "PAUSE_JOB":
      return done(pauseJob(raw.jobId));
    case "RESUME_JOB":
      return done(resumeJob(raw.jobId));
    case "CANCEL_JOB":
      return done(cancelJob(raw.jobId));
    case "REMOVE_JOB":
      return done(removeJob(raw.jobId));
    case "RETRY_JOB":
      return done(retryJob(raw.jobId));
    case "RESTART_JOB":
      return done(restartJob(raw.jobId));
    case "SKIP_FAILED":
      return done(skipFailed(raw.jobId));
    case "GET_STORAGE":
      return done(storageInfo());
    case "CLEAN_STORAGE":
      return done(cleanStorage());
    case "GET_JOBS":
      return done(getJobs());
    case "SHOW_IN_FOLDER":
      return done(showInFolder(raw.jobId));
    case "OPEN_URL":
      return done(chrome.tabs.create({ url: raw.url }));
    case "OPEN_SIDE_PANEL": {
      const windowId = raw.windowId ?? sender.tab?.windowId;
      return done(
        (windowId !== undefined
          ? chrome.sidePanel.open({ windowId })
          : chrome.windows.getLastFocused().then((w) => chrome.sidePanel.open({ windowId: w.id! }))
        ).then(() => true),
      );
    }
    // ---- from offscreen
    case "JOB_PROGRESS":
      return done(updateJob(raw.job));
    case "JOB_READY_TO_SAVE":
      return done(saveJob(raw.jobId, raw.blobUrl, raw.fileName, raw.size));
    case "JOB_FAILED":
      return done(updateJob({ id: raw.jobId, status: "error", error: raw.error }).then(() => removeRule(ruleKey(raw.jobId))));
    case "ADD_RULE_HOSTS":
      // engine discovered new segment / key hosts → extend the header rule
      return done(ensureRule(ruleKey(raw.jobId), raw.headers, raw.hosts).then(() => true));
  }
  return false;
});

// ---- test hook: scripts/smoke.mjs drives the service worker through the DevTools protocol.
// Only reachable from DevTools attached to the extension's own service worker.
(globalThis as unknown as { __vg: unknown }).__vg = {
  getSettings,
  setSettings,
  getTabMedia,
  getJobs,
  inspectHls,
  startDownload,
  probeItem,
  storageInfo,
  /** smoke/debug: run the real save path for an arbitrary blob URL */
  testSave: async (blobUrl: string, fileName: string) => {
    const job = await startDownload(
      { id: "t", tabId: -1, url: "https://x/t.mp4", kind: "video", ext: "mp4", mime: "video/mp4", size: 4096, name: "t", pageUrl: "", pageTitle: "t", headers: {}, method: "GET", detectedAt: Date.now() },
      undefined, undefined, "t",
    );
    await cancelJob(job.id);
    await saveJob(job.id, blobUrl, fileName, 4096);
    return job.id;
  },
  pauseJob,
  resumeJob,
  restartJob,
  skipFailed,
};
