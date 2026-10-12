/// <reference lib="webworker" />
/**
 * MPEG-TS → fragmented MP4 remux worker (mux.js).
 * Protocol:
 *   in : { id, cmd: "segment", data: ArrayBuffer, discontinuity?: boolean }  → out: { id, init?: ArrayBuffer, data: ArrayBuffer, ok: true }
 *   in : { id, cmd: "end" }                                                     → out: { id, ok: true }
 *   in : { id, cmd: "reset" }                                                   → fresh transmuxer
 * Only the first init segment is emitted; later ones are identical for a continuous stream.
 * On a discontinuity we re-emit the init (players handle repeated moov in fMP4 gracefully),
 * and tell mux.js to keep going with a fresh timeline.
 */
import { Transmuxer, type TransmuxSegment } from "mux.js/lib/mp4/transmuxer.js";

interface In {
  id: number;
  cmd: "segment" | "end" | "reset";
  data?: ArrayBuffer;
  discontinuity?: boolean;
}

let tx: Transmuxer | null = null;
let initSent = false;
let pending: TransmuxSegment[] = [];
let hasVideo = false;
let hasAudio = false;

function create(): Transmuxer {
  const t = new Transmuxer({ remux: true, keepOriginalTimestamps: false });
  t.on("data", (seg) => pending.push(seg));
  t.on("trackinfo", (i) => {
    hasVideo = i.hasVideo;
    hasAudio = i.hasAudio;
  });
  return t;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

self.onmessage = (ev: MessageEvent<In>) => {
  const { id, cmd } = ev.data;
  try {
    if (cmd === "reset") {
      tx?.dispose();
      tx = null;
      initSent = false;
      pending = [];
      (self as unknown as Worker).postMessage({ id, ok: true });
      return;
    }
    if (!tx) tx = create();
    if (cmd === "segment") {
      if (ev.data.discontinuity && initSent) {
        // flush what we have, then restart the timeline
        tx.flush();
        tx.reset();
        tx.setBaseMediaDecodeTime(0);
      }
      pending = [];
      tx.push(new Uint8Array(ev.data.data!));
      tx.flush();
      const chunks: Uint8Array[] = [];
      let init: Uint8Array | undefined;
      for (const seg of pending) {
        if (!initSent || ev.data.discontinuity) {
          init = seg.initSegment;
          initSent = true;
        }
        chunks.push(seg.data);
      }
      pending = [];
      const data = concat(chunks);
      const msg: { id: number; ok: true; init?: ArrayBuffer; data: ArrayBuffer; hasVideo: boolean; hasAudio: boolean } = {
        id,
        ok: true,
        data: data.buffer as ArrayBuffer,
        hasVideo,
        hasAudio,
      };
      const transfer: ArrayBuffer[] = [data.buffer as ArrayBuffer];
      if (init) {
        const copy = init.slice();
        msg.init = copy.buffer as ArrayBuffer;
        transfer.push(copy.buffer as ArrayBuffer);
      }
      (self as unknown as Worker).postMessage(msg, transfer);
      return;
    }
    if (cmd === "end") {
      pending = [];
      tx.flush();
      const data = concat(pending.map((s) => s.data));
      pending = [];
      tx.dispose();
      tx = null;
      initSent = false;
      (self as unknown as Worker).postMessage({ id, ok: true, data: data.buffer }, [data.buffer as ArrayBuffer]);
    }
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String((e as Error)?.message ?? e) });
  }
};
