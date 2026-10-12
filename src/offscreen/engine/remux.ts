/** Typed client for remux.worker.ts – one worker per job, strictly sequential. */
export interface RemuxResult {
  init?: Uint8Array;
  data: Uint8Array;
  hasVideo: boolean;
  hasAudio: boolean;
}

interface Reply {
  id: number;
  ok: boolean;
  error?: string;
  init?: ArrayBuffer;
  data?: ArrayBuffer;
  hasVideo?: boolean;
  hasAudio?: boolean;
}

export class Remuxer {
  private worker: Worker;
  private seq = 0;
  private waiting = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker = new Worker(new URL("./remux.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev: MessageEvent<Reply>) => {
      const w = this.waiting.get(ev.data.id);
      if (!w) return;
      this.waiting.delete(ev.data.id);
      ev.data.ok ? w.resolve(ev.data) : w.reject(new Error(ev.data.error || "remux failed"));
    };
    this.worker.onerror = (e) => {
      for (const w of this.waiting.values()) w.reject(new Error(e.message || "remux worker crashed"));
      this.waiting.clear();
    };
  }

  private call(msg: Record<string, unknown>, transfer: ArrayBuffer[] = []): Promise<Reply> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...msg }, transfer);
    });
  }

  async segment(ts: Uint8Array, discontinuity = false): Promise<RemuxResult> {
    // copy into a standalone buffer so we can transfer it
    const buf = ts.buffer.byteLength === ts.byteLength && ts.byteOffset === 0 ? (ts.buffer as ArrayBuffer) : ts.slice().buffer;
    const r = await this.call({ cmd: "segment", data: buf, discontinuity }, [buf as ArrayBuffer]);
    return {
      init: r.init ? new Uint8Array(r.init) : undefined,
      data: new Uint8Array(r.data ?? new ArrayBuffer(0)),
      hasVideo: !!r.hasVideo,
      hasAudio: !!r.hasAudio,
    };
  }

  async end(): Promise<Uint8Array> {
    const r = await this.call({ cmd: "end" });
    return new Uint8Array(r.data ?? new ArrayBuffer(0));
  }

  terminate(): void {
    this.worker.terminate();
    for (const w of this.waiting.values()) w.reject(new Error("terminated"));
    this.waiting.clear();
  }
}
