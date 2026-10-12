import type { MediaItem } from "@shared/types";
import { send } from "@shared/messages";

/**
 * Thumbnail capture inside the popup:
 *  1. HLS → hls.js on a hidden <video>, seek ~10 % in, draw to canvas.
 *  2. Direct video → native <video> with Range (browser handles it), same.
 *  3. Audio → none.
 * Takes ≤ 4 s; failures are silent. Result is cached on the item via SET_THUMBNAIL.
 */
const W = 160;
const inflight = new Map<string, Promise<string | null>>();

export function captureThumbnail(item: MediaItem, variantUrl?: string): Promise<string | null> {
  if (item.thumbnail) return Promise.resolve(item.thumbnail);
  if (item.kind === "audio") return Promise.resolve(null);
  let p = inflight.get(item.id);
  if (!p) {
    p = doCapture(item, variantUrl)
      .then(async (url) => {
        if (url) {
          item.thumbnail = url;
          await send({ type: "SET_THUMBNAIL", tabId: item.tabId, id: item.id, dataUrl: url }).catch(() => {});
        }
        return url;
      })
      .catch(() => null)
      .finally(() => inflight.delete(item.id));
    inflight.set(item.id, p);
  }
  return p;
}

async function doCapture(item: MediaItem, variantUrl?: string): Promise<string | null> {
  await send({ type: "ENSURE_HEADER_RULE", item });
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.style.cssText = "position:fixed;left:-9999px;top:0;width:160px;height:90px;opacity:0;pointer-events:none";
  document.body.append(video);
  let hls: { destroy(): void } | null = null;
  const cleanup = () => hls?.destroy();
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 6000));

  const work = (async () => {
    if (item.kind === "hls") {
      const { default: Hls } = await import("hls.js");
      if (!Hls.isSupported()) return null;
      const h = new Hls({
        enableWorker: false,
        autoStartLoad: true,
        startLevel: 0, // lowest quality is enough for a thumb
        capLevelToPlayerSize: true,
        maxBufferLength: 4,
        xhrSetup: (xhr) => {
          xhr.withCredentials = true;
        },
      });
      hls = h;
      h.loadSource(variantUrl || item.url);
      h.attachMedia(video);
      await new Promise<void>((res, rej) => {
        h.on(Hls.Events.MANIFEST_PARSED, () => res());
        h.on(Hls.Events.ERROR, (_e, d) => d.fatal && rej(new Error(d.details)));
      });
    } else {
      video.src = item.url;
    }
    await once(video, "loadedmetadata");
    const dur = Number.isFinite(video.duration) ? video.duration : 0;
    const t = dur ? Math.min(Math.max(dur * 0.1, 1), Math.max(dur - 1, 1)) : 1;
    video.currentTime = t;
    await once(video, "seeked", 3500).catch(() => undefined);
    if (video.readyState < 2) await once(video, "loadeddata", 2000).catch(() => undefined);
    if (!video.videoWidth) return null;
    const c = document.createElement("canvas");
    const h = Math.max(1, Math.round((W * video.videoHeight) / video.videoWidth));
    c.width = W;
    c.height = h;
    c.getContext("2d")!.drawImage(video, 0, 0, W, h);
    try {
      return c.toDataURL("image/jpeg", 0.7);
    } catch {
      return null; // tainted canvas (cross-origin without CORS) – rare with crossOrigin=anonymous
    }
  })();

  try {
    return await Promise.race([work, timeout]);
  } finally {
    cleanup();
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
  }
}

function once(el: HTMLMediaElement, ev: string, ms = 5000): Promise<void> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout " + ev)), ms);
    el.addEventListener(
      ev,
      () => {
        clearTimeout(t);
        res();
      },
      { once: true },
    );
    el.addEventListener("error", () => (clearTimeout(t), rej(new Error("media error"))), { once: true });
  });
}
