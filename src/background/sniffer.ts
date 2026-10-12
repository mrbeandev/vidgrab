import type { MediaItem, MediaKind } from "@shared/types";
import { SKIPPED_PAGE_HOSTS } from "@shared/types";
import { sanitizeHeaders } from "@shared/headers";
import { baseNameFromUrl, hashId, hostMatches, hostOf, sanitizeFileName } from "@shared/utils";
import { addTabMedia, hasUrl } from "./tabMedia";
import { getSettings } from "./settings";

/** content-type → [kind, ext] */
const MIME: Record<string, [MediaKind, string]> = {
  "application/vnd.apple.mpegurl": ["hls", "m3u8"],
  "application/x-mpegurl": ["hls", "m3u8"],
  "audio/mpegurl": ["hls", "m3u8"],
  "audio/x-mpegurl": ["hls", "m3u8"],
  "video/mp4": ["video", "mp4"],
  "video/x-m4v": ["video", "mp4"],
  "video/webm": ["video", "webm"],
  "video/x-matroska": ["video", "mkv"],
  "video/quicktime": ["video", "mov"],
  "video/x-flv": ["video", "flv"],
  "video/x-msvideo": ["video", "avi"],
  "video/x-ms-wmv": ["video", "wmv"],
  "video/3gpp": ["video", "3gp"],
  "video/ogg": ["video", "ogv"],
  "audio/mpeg": ["audio", "mp3"],
  "audio/mp4": ["audio", "m4a"],
  "audio/x-m4a": ["audio", "m4a"],
  "audio/aac": ["audio", "aac"],
  "audio/ogg": ["audio", "ogg"],
  "audio/wav": ["audio", "wav"],
  "audio/x-wav": ["audio", "wav"],
  "audio/flac": ["audio", "flac"],
  "audio/webm": ["audio", "weba"],
};

const EXT: Record<string, MediaKind> = {
  m3u8: "hls",
  m3u: "hls",
  mp4: "video",
  m4v: "video",
  webm: "video",
  mkv: "video",
  mov: "video",
  flv: "video",
  avi: "video",
  wmv: "video",
  "3gp": "video",
  ogv: "video",
  mp3: "audio",
  m4a: "audio",
  aac: "audio",
  ogg: "audio",
  wav: "audio",
  flac: "audio",
  weba: "audio",
};

/** Segment-ish extensions that must never be listed as standalone media. */
const SEGMENT_EXT = new Set(["ts", "m4s", "m4f", "cmfv", "cmfa", "aac", "vtt", "key", "mpd", "init"]);
const AD_HOSTS = ["doubleclick.net", "googlesyndication.com", "google-analytics.com", "adtng.com", "doppiocdn.com"];

/** requestId → captured request headers (short-lived) */
const reqHeaders = new Map<string, chrome.webRequest.HttpHeader[]>();
const TYPES = ["media", "xmlhttprequest", "object", "other"] as unknown as chrome.webRequest.ResourceType[];

function header(list: chrome.webRequest.HttpHeader[] | undefined, name: string): string | undefined {
  if (!list) return undefined;
  const h = list.find((x) => x.name.toLowerCase() === name);
  return h?.value;
}

function parseContentRangeTotal(v?: string): number {
  // bytes 0-1023/4567890
  const m = v && /\/(\d+)\s*$/.exec(v);
  return m ? parseInt(m[1], 10) : 0;
}

function fileNameFromDisposition(v?: string): string | undefined {
  if (!v) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/i.exec(v);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* fallthrough */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(v);
  return plain ? plain[1].trim() : undefined;
}

export function startSniffer(): void {
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (d) => {
      if (!d.initiator || !d.initiator.startsWith("http")) return;
      reqHeaders.set(d.requestId, d.requestHeaders ?? []);
      // GC: keep the map bounded
      if (reqHeaders.size > 2000) {
        const first = reqHeaders.keys().next().value;
        if (first !== undefined) reqHeaders.delete(first);
      }
      return undefined;
    },
    { urls: ["<all_urls>"], types: TYPES },
    ["requestHeaders", "extraHeaders"],
  );

  chrome.webRequest.onResponseStarted.addListener(
    (d) => {
      const captured = reqHeaders.get(d.requestId);
      reqHeaders.delete(d.requestId);
      void onResponse(d, captured);
    },
    { urls: ["<all_urls>"], types: TYPES },
    ["responseHeaders"],
  );

  chrome.webRequest.onErrorOccurred.addListener((d) => reqHeaders.delete(d.requestId), { urls: ["<all_urls>"] });
}

async function onResponse(
  d: chrome.webRequest.OnResponseStartedDetails,
  captured: chrome.webRequest.HttpHeader[] | undefined,
): Promise<void> {
  try {
    const { url, initiator, statusCode, responseHeaders } = d;
    let tabId = d.tabId;
    if (!url.startsWith("http")) return;
    if (!initiator || !initiator.startsWith("http")) return; // skip extension / internal
    if (statusCode < 200 || statusCode >= 300) return;
    if (initiator.startsWith(`chrome-extension://${chrome.runtime.id}`)) return;

    const pageHost = hostOf(initiator);
    if (hostMatches(pageHost, SKIPPED_PAGE_HOSTS)) return;
    const mediaHost = hostOf(url);
    if (hostMatches(mediaHost, AD_HOSTS)) return;

    const settings = await getSettings();
    if (hostMatches(mediaHost, settings.blockedHosts)) return;

    // Requests from service workers have tabId -1; attribute to the active tab if the origin matches.
    if (tabId === -1) {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!active?.id || !active.url || !active.url.startsWith(initiator)) return;
      tabId = active.id;
    }
    if (hasUrl(tabId, url)) return;

    // ---- classify
    let ctype = (header(responseHeaders, "content-type") || "").toLowerCase().split(";")[0].trim();
    const { base, ext: urlExt } = baseNameFromUrl(url);
    const dispoName = fileNameFromDisposition(header(responseHeaders, "content-disposition"));
    const dispoExt = dispoName ? dispoName.split(".").pop()?.toLowerCase() || "" : "";

    let kind: MediaKind | undefined;
    let ext = "";

    if (MIME[ctype]) [kind, ext] = MIME[ctype];
    const guessExt = dispoExt && EXT[dispoExt] ? dispoExt : urlExt;
    if (!kind) {
      if (SEGMENT_EXT.has(guessExt)) return;
      if (EXT[guessExt]) {
        // octet-stream / text/plain / missing content type but a media-looking extension
        if (!ctype || /octet-stream|text\/plain|binary|application\/x-|application\/json/.test(ctype) || d.type === "media") {
          kind = EXT[guessExt];
          ext = guessExt;
        }
      }
    } else if (kind !== "hls" && EXT[guessExt] === kind) {
      ext = guessExt; // trust the url extension when it agrees with the type family
    }
    if (!kind) return;
    if (kind !== "hls" && SEGMENT_EXT.has(urlExt)) return;
    // Some servers send m3u8 as text/plain; HLS by extension is fine. mp4 segments of DASH (m4s) handled above.

    // ---- size
    const total = parseContentRangeTotal(header(responseHeaders, "content-range"));
    const size = total || parseInt(header(responseHeaders, "content-length") || "0", 10) || 0;
    if (kind !== "hls") {
      if (size && size < settings.minSizeKB * 1024) return;
      if (!size && d.type !== "media") return; // unknown-size XHR blobs are usually chunks
    }

    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    const pageTitle = tab?.title?.trim() || pageHost;
    const name = sanitizeFileName(dispoName?.replace(/\.[^.]+$/, "") || base || pageTitle);

    const item: MediaItem = {
      id: hashId(url),
      tabId,
      url,
      kind,
      ext,
      mime: ctype || "",
      size,
      name,
      pageUrl: tab?.url || initiator,
      pageTitle,
      headers: sanitizeHeaders(captured),
      method: d.method === "POST" ? "POST" : "GET",
      detectedAt: Date.now(),
    };
    await addTabMedia(item);
  } catch (e) {
    console.warn("[vidgrab] sniff error", e);
  }
}
