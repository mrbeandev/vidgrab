import { sleep } from "@shared/utils";

export interface FetchOpts {
  headers: Record<string, string>;
  method?: string;
  signal?: AbortSignal;
  retries?: number;
  timeoutMs?: number;
  /** length = Infinity → open-ended "bytes=offset-" */
  range?: { offset: number; length: number };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    msg: string,
  ) {
    super(msg);
  }
}

function retryable(e: unknown): boolean {
  if (e instanceof DOMException && e.name === "TimeoutError") return true;
  if (e instanceof DOMException && e.name === "AbortError") return false;
  if (e instanceof HttpError) return e.status >= 500 || e.status === 429 || e.status === 408 || e.status === 403;
  return true; // network errors
}

/** fetch with timeout + exponential backoff. Resolves to the Response (body unread). */
export async function fetchRetry(url: string, o: FetchOpts): Promise<Response> {
  const retries = o.retries ?? 4;
  let attempt = 0;
  for (;;) {
    // Header timeout only. The caller's signal stays bound to the fetch for the *whole* body
    // (AbortSignal.any) – previously the link was dropped once headers arrived, so a body that
    // stalled could never be aborted (not by the watchdog, not by Pause/Cancel).
    const ctl = new AbortController();
    const signal = o.signal ? AbortSignal.any([o.signal, ctl.signal]) : ctl.signal;
    const timer = setTimeout(() => ctl.abort(new DOMException("Timeout", "TimeoutError")), o.timeoutMs ?? 30_000);
    try {
      const headers: Record<string, string> = { ...o.headers };
      if (o.range)
        headers.range = Number.isFinite(o.range.length)
          ? `bytes=${o.range.offset}-${o.range.offset + o.range.length - 1}`
          : `bytes=${o.range.offset}-`;
      const res = await fetch(url, {
        method: o.method ?? "GET",
        headers,
        credentials: "include",
        signal,
        cache: "no-store",
        redirect: "follow",
      });
      if (!res.ok && res.status !== 206) {
        await res.body?.cancel().catch(() => {});
        throw new HttpError(res.status, `HTTP ${res.status}`);
      }
      clearTimeout(timer);
      return res;
    } catch (e) {
      clearTimeout(timer);
      if (o.signal?.aborted) throw o.signal.reason ?? new DOMException("Aborted", "AbortError");
      if (attempt >= retries || !retryable(e)) throw e;
      attempt++;
      await sleep(Math.min(8000, 400 * 2 ** attempt + Math.random() * 300), o.signal);
    }
  }
}

/**
 * Fetch a whole resource into memory with retries. Unlike fetchRetry, the timeout covers the BODY too:
 *  - idle watchdog: no bytes for `idleMs` → abort & retry (CDN stalls mid-transfer)
 *  - hard deadline per attempt: `timeoutMs`
 */
export async function fetchBytes(url: string, o: FetchOpts & { idleMs?: number; onBytes?: (n: number) => void }): Promise<Uint8Array> {
  const retries = o.retries ?? 4;
  const idleMs = o.idleMs ?? 20_000;
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const signal = o.signal ? AbortSignal.any([o.signal, ctl.signal]) : ctl.signal;
    const hard = setTimeout(() => ctl.abort(new DOMException("Timeout", "TimeoutError")), o.timeoutMs ?? 120_000);
    let idle = setTimeout(() => ctl.abort(new DOMException("Stalled", "TimeoutError")), idleMs);
    const kick = () => {
      clearTimeout(idle);
      idle = setTimeout(() => ctl.abort(new DOMException("Stalled", "TimeoutError")), idleMs);
    };
    try {
      const res = await fetchRetry(url, { ...o, signal, retries: 0, timeoutMs: idleMs });
      kick();
      const reader = res.body!.getReader();
      const chunks: Uint8Array[] = [];
      let n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        kick();
        chunks.push(value);
        n += value.byteLength;
        o.onBytes?.(value.byteLength);
      }
      const out = new Uint8Array(n);
      let off = 0;
      for (const c of chunks) (out.set(c, off), (off += c.byteLength));
      return out;
    } catch (e) {
      if (o.signal?.aborted) throw o.signal.reason ?? new DOMException("Aborted", "AbortError");
      if (attempt >= retries || !retryable(e)) throw e;
      await sleep(Math.min(8000, 400 * 2 ** (attempt + 1) + Math.random() * 300), o.signal);
    } finally {
      clearTimeout(hard);
      clearTimeout(idle);
    }
  }
}

export async function fetchText(url: string, o: FetchOpts): Promise<string> {
  const res = await fetchRetry(url, o);
  return res.text();
}
