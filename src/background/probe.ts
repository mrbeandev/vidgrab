import type { MediaItem, MediaProbe } from "@shared/types";
import { ivFromSequence, parsePlaylist, type MediaPlaylist } from "@shared/m3u8";
import { splitHeaders } from "@shared/headers";
import { hostOf } from "@shared/utils";
import { probeBytes, tracksFromCodecs, type TrackInfo } from "@shared/probe-parsers";
import { ensureRule } from "./rules";
import { patchTabMedia } from "./tabMedia";

const HEAD = 256 * 1024;

function toAB(u8: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
}
const TAIL = 768 * 1024;

async function fetchRange(url: string, headers: Record<string, string>, start: number, end?: number): Promise<{ bytes: Uint8Array; total: number; status: number }> {
  const h = { ...headers, range: end === undefined ? `bytes=${start}-` : `bytes=${start}-${end}` };
  const res = await fetch(url, { headers: h, credentials: "include", cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const cr = res.headers.get("content-range");
  const m = cr && /\/(\d+)/.exec(cr);
  const total = m ? parseInt(m[1], 10) : parseInt(res.headers.get("content-length") || "0", 10) || 0;
  // if the server ignored Range (200) only read the first chunk and bail
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  const want = end === undefined ? Number.MAX_SAFE_INTEGER : end - start + 1;
  while (got < want) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    if (res.status === 200 && got >= HEAD) break;
  }
  await reader.cancel().catch(() => {});
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) (out.set(c, o), (o += c.byteLength));
  return { bytes: out, total, status: res.status };
}

/** Probe a direct media file: head, then tail if the moov is at the end. */
async function probeDirect(item: MediaItem, headers: Record<string, string>): Promise<MediaProbe> {
  const head = await fetchRange(item.url, headers, 0, HEAD - 1);
  let info: TrackInfo = probeBytes(head.bytes);
  const size = head.total || item.size;
  if (info.container === "mp4" && !info.video && !info.audio && head.status === 206 && size > HEAD) {
    // moov is probably at the end
    const tail = await fetchRange(item.url, headers, Math.max(0, size - TAIL), size - 1);
    const t = probeBytes(tail.bytes);
    if (t.video || t.audio) info = t;
    else {
      // mp4 with moov in the tail but our tail window missed it (huge moov) → merge both
      const merged = new Uint8Array(head.bytes.length + tail.bytes.length);
      merged.set(head.bytes, 0);
      merged.set(tail.bytes, head.bytes.length);
      const m = probeBytes(merged);
      if (m.video || m.audio) info = m;
    }
  }
  return toProbe(info, size);
}

async function probeHls(item: MediaItem, headers: Record<string, string>): Promise<MediaProbe> {
  const res = await fetch(item.url, { headers, credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let pl = parsePlaylist(await res.text(), item.url);
  const probe: MediaProbe = { at: Date.now() };
  if (pl.kind === "master") {
    // Per-variant info from CODECS; actual byte probe only on the top variant.
    probe.audioSeparate = pl.audio.length > 0 && pl.variants.some((v) => v.audioGroup && !/mp4a|ec-3|ac-3|opus/i.test(v.codecs || ""));
    const top = pl.variants[0];
    if (!top) return probe;
    const t = tracksFromCodecs(top.codecs, !!top.height);
    if (t) Object.assign(probe, pick(t));
    await ensureRule(`item:${item.id}`, item.headers, [hostOf(top.url)]);
    const r2 = await fetch(top.url, { headers, credentials: "include" });
    if (!r2.ok) return probe;
    const p2 = parsePlaylist(await r2.text(), top.url);
    if (p2.kind !== "media") return probe;
    pl = p2;
    probe.duration = pl.duration;
    probe.estSize = Math.round((top.bandwidth / 8) * pl.duration);
  }
  const media = pl as MediaPlaylist;
  probe.duration ??= media.duration;
  probe.segments = media.segments.length;
  probe.encrypted = media.encrypted;
  probe.live = !media.endList;
  const first = media.segments[0];
  if (!first) return probe;
  if (first.key && first.key.method !== "AES-128" && first.key.method !== "NONE") return probe; // SAMPLE-AES etc.
  const target = first.map?.uri ?? first.uri;
  await ensureRule(`item:${item.id}`, item.headers, [hostOf(target)]);
  const range = first.map?.byteRange ?? (first.map ? undefined : first.byteRange);
  const encrypted = !!first.key && first.key.method === "AES-128" && !first.map;
  // Encrypted TS: CBC needs the full segment (padding at the end) – fetch it whole (segments are small).
  const got = range
    ? await fetchRange(target, headers, range.offset, range.offset + range.length - 1)
    : encrypted
      ? await fetchRange(target, headers, 0)
      : await fetchRange(target, headers, 0, 192 * 1024 - 1);
  let bytes = got.bytes;
  if (encrypted && first.key?.uri) {
    try {
      await ensureRule(`item:${item.id}`, item.headers, [hostOf(first.key.uri)]);
      const keyRes = await fetch(first.key.uri, { headers, credentials: "include" });
      const raw = new Uint8Array(await keyRes.arrayBuffer());
      const key = await crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["decrypt"]);
      const iv = first.key.iv ?? ivFromSequence(first.sn);
      const usable = bytes.byteLength - (bytes.byteLength % 16);
      bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: toAB(iv) }, key, toAB(bytes.subarray(0, usable))));
    } catch {
      return probe; // can't decrypt → CODECS-only info
    }
  }
  const info = probeBytes(bytes);
  if (info.video || info.audio) Object.assign(probe, pick(info));
  if (!probe.estSize && media.segments.length) {
    // rough: size of the first *media* segment / its duration × total duration
    let segBytes = first.map ? 0 : got.total;
    if (!segBytes) {
      try {
        const h = await fetch(first.uri, { method: "HEAD", headers, credentials: "include" });
        segBytes = parseInt(h.headers.get("content-length") || "0", 10);
      } catch {
        /* ignore */
      }
    }
    if (segBytes) probe.estSize = Math.round((segBytes / (first.duration || media.targetDuration || 1)) * media.duration);
  }
  return probe;
}

function pick(t: Partial<TrackInfo>): Partial<MediaProbe> {
  const out: Partial<MediaProbe> = {};
  if (t.video !== undefined) out.video = t.video;
  if (t.audio !== undefined) out.audio = t.audio;
  if (t.videoCodec) out.videoCodec = t.videoCodec;
  if (t.audioCodec) out.audioCodec = t.audioCodec;
  if (t.width) out.width = t.width;
  if (t.height) out.height = t.height;
  if (t.duration) out.duration = t.duration;
  return out;
}

function toProbe(t: TrackInfo, size: number): MediaProbe {
  return { at: Date.now(), ...pick(t), estSize: size || undefined };
}

const inflight = new Map<string, Promise<MediaProbe>>();

export function probeItem(item: MediaItem): Promise<MediaProbe> {
  if (item.probe) return Promise.resolve(item.probe);
  const k = item.id;
  let p = inflight.get(k);
  if (!p) {
    p = (async () => {
      await ensureRule(`item:${item.id}`, item.headers, [hostOf(item.url)]);
      const { fetchHeaders } = splitHeaders(item.headers);
      let probe: MediaProbe;
      try {
        probe = item.kind === "hls" ? await probeHls(item, fetchHeaders) : await probeDirect(item, fetchHeaders);
      } catch (e) {
        probe = { at: Date.now(), error: String((e as Error).message ?? e) };
      }
      await patchTabMedia(item.tabId, item.id, { probe });
      return probe;
    })().finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}
