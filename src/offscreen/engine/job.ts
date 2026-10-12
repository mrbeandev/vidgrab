import type { DownloadJob, Settings } from "@shared/types";
import { parsePlaylist, type MediaPlaylist, type Segment } from "@shared/m3u8";
import { splitHeaders } from "@shared/headers";
import { hostOf, sleep } from "@shared/utils";
import { send } from "@shared/messages";
import { OutputFile } from "./storage";
import { HttpError, fetchBytes, fetchRetry, fetchText } from "./net";
import { KeyStore } from "./crypto";
import { Remuxer } from "./remux";
import { FlatMp4Writer } from "./flatmp4";

type Progress = Partial<DownloadJob> & { id: string };
type Container = NonNullable<DownloadJob["container"]>;

const CONTAINER_EXT: Record<Container, string> = { mp4: "mp4", ts: "ts", webm: "webm", mkv: "mkv", mp3: "mp3", m4a: "m4a", bin: "bin" };
/** Explicit MIME so Chrome doesn't "correct" the file extension (an untyped blob became .txt). */
const CONTAINER_MIME: Record<Container, string> = {
  mp4: "video/mp4",
  ts: "video/mp2t",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  bin: "application/octet-stream",
};
const EXT_CONTAINER: Record<string, Container> = {
  mp4: "mp4", m4v: "mp4", mov: "mp4", webm: "webm", mkv: "mkv", mp3: "mp3", m4a: "m4a", aac: "m4a", ts: "ts",
};

const SLOW_RETRY_ROUNDS = 3; // after fetchBytes' own retries, requeue a segment this many times before pausing

const isAbort = (e: unknown) => e instanceof DOMException && (e.name === "AbortError" || e.name === "TimeoutError");

export class JobRunner {
  private abort = new AbortController(); // cancel = whole job
  private pauseCtl = new AbortController(); // aborted on pause → in-flight requests stop immediately
  private paused = false;
  private cancelled = false;
  private out: OutputFile;
  private fetchHeaders: Record<string, string>;
  private knownHosts = new Set<string>();
  private lastProgress = 0;
  private netBytes = 0; // bytes received from the network (drives speed)
  private speedWindow: { t: number; b: number }[] = [];
  private blobUrl: string | null = null;
  private remux: Remuxer | null = null;
  private remuxers: Map<number, Remuxer> | null = null;
  private state: Progress;
  private waiters: (() => void)[] = [];

  // HLS pipeline state (kept on the instance so pause/resume/skip can touch it)
  // `segs` is the combined work list: video playlist segments first, then the separate audio rendition's.
  private mediaUrl = "";
  private audioUrl = "";
  private segs: Segment[] = [];
  private segSource: number[] = []; // 0 = main playlist, 1 = separate audio rendition
  private videoCount = 0; // number of segments that belong to source 0
  private queue: number[] = [];
  private inflight = new Set<number>();
  private buffers = new Map<number, Uint8Array>();
  private attempts = new Map<number, number>();
  private failedIdx = new Set<number>(); // segments that exhausted retries (job paused because of them)
  private skipped = 0;
  private fetchedCount = 0;
  private nextWrite = 0;
  private lastFailure: unknown = null;

  constructor(
    readonly job: DownloadJob,
    readonly settings: Settings,
  ) {
    this.out = new OutputFile(`${job.id}.part`);
    this.fetchHeaders = splitHeaders(job.item.headers).fetchHeaders;
    this.state = { id: job.id, status: "preparing", bytesDone: 0, doneSegments: 0, failedSegments: 0 };
    this.knownHosts.add(hostOf(job.item.url));
    if (job.variant) this.knownHosts.add(hostOf(job.variant.url));
  }

  // ------------------------------------------------------------------ control
  pause(): void {
    if (this.paused || this.cancelled) return;
    this.paused = true;
    this.pauseCtl.abort(new DOMException("Paused", "AbortError"));
    this.emit({ status: "paused" }, true);
  }

  async resume(): Promise<void> {
    if (!this.paused || this.cancelled) return;
    // Expired signed URLs are the #1 reason segments start failing with 403 – refresh the playlist.
    const st = this.lastFailure instanceof HttpError ? this.lastFailure.status : 0;
    if (this.segs.length && (st === 401 || st === 403 || st === 404 || st === 410)) await this.refreshPlaylist().catch(() => {});
    this.failedIdx.clear();
    this.attempts.clear();
    this.lastFailure = null;
    this.pauseCtl = new AbortController();
    this.paused = false;
    this.emit({ status: "downloading", error: "" }, true);
    this.wake();
  }

  /** Give up on the segments that keep failing, continue with the rest. */
  async skipFailed(): Promise<void> {
    for (const idx of this.failedIdx) {
      this.queue = this.queue.filter((q) => q !== idx);
      this.buffers.set(idx, new Uint8Array(0));
      this.skipped++;
    }
    this.failedIdx.clear();
    this.emit({ failedSegments: this.skipped });
    await this.resume();
  }

  cancel(): void {
    this.cancelled = true;
    this.abort.abort(new DOMException("Cancelled", "AbortError"));
    this.pauseCtl.abort(new DOMException("Cancelled", "AbortError"));
    this.wake();
    this.cleanup();
  }

  private cleanup(): void {
    this.remux?.terminate();
    this.remux = null;
    this.remuxers?.forEach((r) => r.terminate());
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = null;
    void this.out.abort();
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }
  private waitChange(ms = 1000): Promise<void> {
    return new Promise((r) => {
      const done = () => {
        clearTimeout(t);
        const i = this.waiters.indexOf(done);
        if (i >= 0) this.waiters.splice(i, 1);
        r();
      };
      const t = setTimeout(done, ms); // safety net: never wait forever
      this.waiters.push(done);
    });
  }
  private async waitIfPaused(): Promise<void> {
    while (this.paused && !this.cancelled) await this.waitChange(5000);
    if (this.cancelled) throw new DOMException("Cancelled", "AbortError");
  }
  private signal(): AbortSignal {
    return AbortSignal.any([this.abort.signal, this.pauseCtl.signal]);
  }

  // ------------------------------------------------------------------ progress
  private emit(p: Partial<Progress>, force = false): void {
    Object.assign(this.state, p);
    const now = Date.now();
    const last = this.speedWindow[this.speedWindow.length - 1];
    if (!last || this.netBytes !== last.b || now - last.t > 500) this.speedWindow.push({ t: now, b: this.netBytes });
    while (this.speedWindow.length > 2 && now - this.speedWindow[0].t > 5000) this.speedWindow.shift();
    if (!force && now - this.lastProgress < 250) return;
    this.lastProgress = now;
    const first = this.speedWindow[0];
    const dt = (now - first.t) / 1000;
    const speed = this.paused ? 0 : dt > 0.3 ? (this.netBytes - first.b) / dt : 0;
    let eta = 0;
    let estTotal = this.state.estTotal;
    if (this.segs.length && this.fetchedCount) {
      const perSeg = this.netBytes / this.fetchedCount;
      estTotal = Math.round(perSeg * this.segs.length);
      if (speed > 0) eta = Math.round((perSeg * (this.segs.length - this.fetchedCount)) / speed);
    } else if (speed > 0 && this.state.bytesTotal) {
      eta = Math.round((this.state.bytesTotal - (this.state.bytesDone ?? 0)) / speed);
    }
    send({ type: "JOB_PROGRESS", job: { ...this.state, estTotal, speedBps: Math.max(0, speed), etaSec: eta } }).catch(() => {});
  }

  private async addHosts(urls: string[]): Promise<void> {
    const fresh = [...new Set(urls.map(hostOf))].filter((h) => h && !this.knownHosts.has(h));
    if (!fresh.length) return;
    fresh.forEach((h) => this.knownHosts.add(h));
    await send({ type: "ADD_RULE_HOSTS", jobId: this.job.id, hosts: fresh, headers: this.job.item.headers }).catch(() => {});
  }

  // ------------------------------------------------------------------ entry
  async run(): Promise<void> {
    const beat = setInterval(() => !this.cancelled && this.emit({}, true), 1000);
    try {
      this.emit({ status: "preparing", startedAt: Date.now() }, true);
      if (this.job.item.kind === "hls") await this.runHls();
      else await this.runDirect();
    } catch (e) {
      if (this.cancelled) return;
      const msg = e instanceof Error ? e.message : String(e);
      this.cleanup();
      await send({ type: "JOB_FAILED", jobId: this.job.id, error: msg }).catch(() => {});
    } finally {
      clearInterval(beat);
    }
  }

  private async finish(container: Container): Promise<void> {
    this.emit({ status: "saving" }, true);
    const file = await this.out.close();
    // Wrap with an explicit type – references the on-disk data, no copy.
    const typed = new Blob([file], { type: CONTAINER_MIME[container] });
    this.blobUrl = URL.createObjectURL(typed);
    const base = this.job.fileName.replace(/\.[a-z0-9]{2,5}$/i, "");
    const fileName = `${base}.${CONTAINER_EXT[container]}`;
    this.emit({ container, bytesDone: file.size, bytesTotal: file.size, fileName }, true);
    await send({ type: "JOB_READY_TO_SAVE", jobId: this.job.id, blobUrl: this.blobUrl, fileName, size: file.size });
  }

  get handedOff(): boolean {
    return this.blobUrl !== null;
  }

  release(): void {
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = null;
    this.remux?.terminate();
    void this.out.remove();
  }

  // =====================================================================
  // Direct file – streamed to OPFS, resumable via Range, idle watchdog
  // =====================================================================
  private async runDirect(): Promise<void> {
    const { item } = this.job;
    await this.out.open();
    const container: Container = EXT_CONTAINER[item.ext] ?? (item.kind === "audio" ? "m4a" : "bin");
    let offset = 0;
    let total = item.size || 0;
    let restarts = 0;
    this.emit({ status: "downloading", bytesTotal: total }, true);

    for (;;) {
      await this.waitIfPaused();
      const stall = new AbortController();
      const sig = AbortSignal.any([this.signal(), stall.signal]);
      let idle: ReturnType<typeof setTimeout> | undefined;
      const kick = () => {
        clearTimeout(idle);
        idle = setTimeout(() => stall.abort(new DOMException("Stalled", "TimeoutError")), 30_000);
      };
      kick();
      let acceptRanges = false;
      try {
        const res = await fetchRetry(item.url, {
          headers: this.fetchHeaders,
          method: item.method,
          signal: sig,
          retries: this.settings.maxRetries,
          timeoutMs: 30_000,
          range: offset > 0 ? { offset, length: Infinity } : undefined,
        });
        if (offset > 0 && res.status !== 206) {
          await this.out.abort();
          await this.out.open();
          offset = 0;
        }
        acceptRanges = res.status === 206 || (res.headers.get("accept-ranges") || "").includes("bytes");
        if (!total) {
          const m = /\/(\d+)/.exec(res.headers.get("content-range") || "");
          total = m ? parseInt(m[1], 10) : parseInt(res.headers.get("content-length") || "0", 10) || 0;
          this.emit({ bytesTotal: total });
        }
        const reader = res.body!.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            clearTimeout(idle);
            await this.finish(container);
            return;
          }
          kick();
          await this.out.write(value);
          offset += value.byteLength;
          this.netBytes += value.byteLength;
          this.emit({ bytesDone: offset });
        }
      } catch (e) {
        clearTimeout(idle);
        if (this.cancelled) throw e;
        if (this.paused) continue; // waitIfPaused at loop top; resumes from `offset` (or 0 below)
        if (!acceptRanges && offset > 0) {
          if (++restarts > this.settings.maxRetries) throw e;
          await this.out.abort();
          await this.out.open();
          offset = 0;
        }
        this.lastFailure = e;
        await sleep(1500, this.abort.signal);
      } finally {
        clearTimeout(idle);
      }
      if (!acceptRanges && this.paused) {
        // can't resume mid-file without Range support → start over on resume
        await this.out.abort();
        await this.out.open();
        offset = 0;
      }
    }
  }

  // =====================================================================
  // HLS
  // =====================================================================
  private async loadMedia(): Promise<MediaPlaylist> {
    const { item, variant } = this.job;
    const startUrl = variant?.url || item.url;
    const text = await fetchText(startUrl, { headers: this.fetchHeaders, signal: this.abort.signal, retries: 3 });
    let pl = parsePlaylist(text, startUrl);
    this.mediaUrl = startUrl;
    if (pl.kind === "master") {
      const best = pl.variants[0];
      if (!best) throw new Error("Master playlist has no variants");
      await this.addHosts([best.url]);
      const t2 = await fetchText(best.url, { headers: this.fetchHeaders, signal: this.abort.signal, retries: 3 });
      pl = parsePlaylist(t2, best.url);
      this.mediaUrl = best.url;
      if (pl.kind === "master") throw new Error("Nested master playlists are not supported");
    }
    return pl;
  }

  /** Re-fetch the media playlist(s) and swap in fresh (re-signed) segment URLs. */
  private async refreshPlaylist(): Promise<void> {
    const load = async (url: string) => {
      const pl = parsePlaylist(await fetchText(url, { headers: this.fetchHeaders, signal: this.abort.signal, retries: 2 }), url);
      return pl.kind === "media" ? pl.segments : null;
    };
    const v = await load(this.mediaUrl);
    if (!v || v.length !== this.videoCount) return;
    let a: Segment[] = [];
    if (this.audioUrl) {
      const got = await load(this.audioUrl);
      if (!got || got.length !== this.segs.length - this.videoCount) return;
      a = got;
    }
    this.segs = [...v, ...a];
    await this.addHosts(this.segs.flatMap((s) => [s.uri, s.key?.uri, s.map?.uri].filter((x): x is string => !!x)));
  }

  private requeue(idx: number): void {
    if (this.queue.includes(idx)) return;
    // keep sorted → lowest index (closest to the write cursor) is fetched first
    let i = 0;
    while (i < this.queue.length && this.queue[i] < idx) i++;
    this.queue.splice(i, 0, idx);
  }

  private async runHls(): Promise<void> {
    const media = await this.loadMedia();
    if (media.unsupportedEncryption) throw new Error(`Encrypted stream not supported (${media.unsupportedEncryption})`);
    if (!media.segments.length) throw new Error("Playlist has no segments");
    if (!media.endList) throw new Error("Live streams are not supported yet – wait for the stream to end or use a VOD link");

    // Separate audio rendition (#EXT-X-MEDIA TYPE=AUDIO): download it too and mux it into the same file.
    let audio: MediaPlaylist | null = null;
    const rendition = this.job.audioRendition;
    if (rendition && rendition.url !== this.mediaUrl) {
      await this.addHosts([rendition.url]);
      const pl = parsePlaylist(await fetchText(rendition.url, { headers: this.fetchHeaders, signal: this.abort.signal, retries: 3 }), rendition.url);
      if (pl.kind !== "media") throw new Error("Audio rendition is not a media playlist");
      if (pl.unsupportedEncryption) throw new Error(`Encrypted audio not supported (${pl.unsupportedEncryption})`);
      audio = pl;
      this.audioUrl = rendition.url;
    }

    this.videoCount = media.segments.length;
    this.segs = [...media.segments, ...(audio?.segments ?? [])];
    this.segSource = this.segs.map((_, i) => (i < this.videoCount ? 0 : 1));
    await this.addHosts(this.segs.flatMap((s) => [s.uri, s.key?.uri, s.map?.uri].filter((x): x is string => !!x)));

    const fmp4Of = (src: number) => (src === 0 ? media.fmp4 : !!audio?.fmp4);
    // Raw .ts output can't carry a second playlist → force the MP4 path when audio is separate.
    const rawTs = !media.fmp4 && !this.settings.remuxTs && !audio;
    this.emit({ status: "downloading", totalSegments: this.segs.length, doneSegments: 0, container: rawTs ? "ts" : "mp4" }, true);

    await this.out.open();
    const keys = new KeyStore({ headers: this.fetchHeaders, retries: this.settings.maxRetries });
    const writer = rawTs ? null : new FlatMp4Writer(this.out);
    // one remuxer per TS source – mux.js keeps per-stream timeline state
    const remuxers = (this.remuxers = new Map<number, Remuxer>());
    const remuxFor = (src: number) => {
      let r = remuxers.get(src);
      if (!r) remuxers.set(src, (r = new Remuxer()));
      return r;
    };
    const initsAdded = new Set<string>();

    this.queue = this.segs.map((_, i) => i);
    const threads = Math.max(1, Math.min(16, this.settings.threads));
    const ahead = threads * 3;
    let writerError: Error | null = null;

    const fetchSeg = async (idx: number): Promise<Uint8Array> => {
      const seg = this.segs[idx];
      const data = await fetchBytes(seg.uri, {
        headers: this.fetchHeaders,
        signal: this.signal(),
        retries: this.settings.maxRetries,
        idleMs: 20_000,
        timeoutMs: 180_000,
        range: seg.byteRange ? { offset: seg.byteRange.offset, length: seg.byteRange.length } : undefined,
        onBytes: (n) => {
          this.netBytes += n;
          this.emit({});
        },
      });
      return keys.decrypt(seg, data, this.signal());
    };

    const worker = async () => {
      for (;;) {
        await this.waitIfPaused();
        if (writerError || this.cancelled) return;
        if (!this.queue.length) {
          if (!this.inflight.size || this.nextWrite >= this.segs.length) return;
          await this.waitChange(); // someone may still fail and requeue
          continue;
        }
        const idx = this.queue[0];
        if (idx - this.nextWrite > ahead) {
          await this.waitChange();
          continue;
        }
        this.queue.shift();
        this.inflight.add(idx);
        try {
          this.buffers.set(idx, await fetchSeg(idx));
          this.fetchedCount++;
          this.attempts.delete(idx);
        } catch (e) {
          if (this.cancelled) return;
          if (this.paused && isAbort(e)) {
            this.requeue(idx); // paused mid-request → fetch again on resume
          } else {
            this.lastFailure = e;
            const n = (this.attempts.get(idx) ?? 0) + 1;
            this.attempts.set(idx, n);
            console.warn(`[vidgrab] segment ${idx} failed (round ${n})`, e);
            if (n < SLOW_RETRY_ROUNDS) {
              this.inflight.delete(idx);
              await sleep(3000 * n, this.abort.signal).catch(() => {});
              this.requeue(idx);
            } else {
              // keeps failing → pause the job and let the user decide (Resume = retry w/ fresh URLs, Skip = drop it)
              this.failedIdx.add(idx);
              this.requeue(idx);
              const why = e instanceof HttpError ? `HTTP ${e.status}` : e instanceof Error ? e.message : String(e);
              this.state.error = `Segment ${idx + 1} keeps failing (${why}). Resume to retry with a fresh link, or skip it.`;
              this.pause();
            }
          }
        } finally {
          this.inflight.delete(idx);
          this.wake();
        }
      }
    };

    const writeLoop = async () => {
      try {
        while (this.nextWrite < this.segs.length) {
          if (this.cancelled) return;
          const data = this.buffers.get(this.nextWrite);
          if (data === undefined) {
            await this.waitChange();
            continue;
          }
          this.buffers.delete(this.nextWrite);
          const seg = this.segs[this.nextWrite];
          const src = this.segSource[this.nextWrite] ?? 0;
          if (data.byteLength) {
            if (rawTs) {
              await this.out.write(data);
            } else if (fmp4Of(src)) {
              const mapKey = seg.map ? src + "|" + seg.map.uri + "@" + (seg.map.byteRange?.offset ?? "") : "";
              if (seg.map && !initsAdded.has(mapKey)) {
                const init = await fetchBytes(seg.map.uri, {
                  headers: this.fetchHeaders,
                  signal: this.abort.signal,
                  retries: this.settings.maxRetries,
                  range: seg.map.byteRange ? { offset: seg.map.byteRange.offset, length: seg.map.byteRange.length } : undefined,
                });
                // An EXT-X-MAP under AES-128 is encrypted with the same key (spec requires an explicit IV).
                const encInit = seg.key?.method === "AES-128" && !!seg.key.iv;
                writer!.addInit(encInit ? await keys.decrypt(seg, init) : init, src);
                initsAdded.add(mapKey);
              }
              await writer!.addFragment(data, seg.byteRange?.offset ?? 0, src);
            } else {
              const rx = remuxFor(src);
              // discontinuity flag only makes sense within a source; the first audio segment starts a new stream
              const r = await rx.segment(data, seg.discontinuity);
              if (r.init) writer!.addInit(r.init, src);
              if (r.data.byteLength) await writer!.addFragment(r.data, 0, src);
            }
          }
          this.nextWrite++;
          this.emit({ doneSegments: this.nextWrite, bytesDone: this.out.bytes });
          this.wake();
        }
      } catch (e) {
        writerError = e instanceof Error ? e : new Error(String(e));
        this.abort.abort(writerError);
        this.wake();
      }
    };

    const writerP = writeLoop();
    await Promise.all(Array.from({ length: threads }, () => worker()));
    this.wake();
    await writerP;
    if (writerError) throw writerError;
    if (this.cancelled) return;
    if (this.skipped === this.segs.length) throw new Error("All segments failed to download");

    let container: Container = "ts";
    if (writer) {
      this.emit({ status: "muxing" }, true);
      for (const [src, rx] of remuxers) {
        const tail = await rx.end();
        if (tail.byteLength) await writer.addFragment(tail, 0, src);
        rx.terminate();
      }
      remuxers.clear();
      await writer.finalize();
      container = writer.hasVideo ? "mp4" : "m4a";
      if (audio && !writer.hasAudio) throw new Error("Separate audio track could not be read – the file would be silent");
    }
    this.emit({ doneSegments: this.segs.length, failedSegments: this.skipped }, true);
    await this.finish(container);
  }
}
