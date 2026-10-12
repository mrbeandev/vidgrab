/**
 * Streaming fMP4 → regular ("flat") MP4 writer.
 *
 * Why: fragmented MP4 with audio and video in separate multi-second fragments makes some players
 * (VLC 3.x) deadlock their decoders → silent audio, glitchy video. A classic MP4 (one moov with full
 * sample tables + one mdat) plays everywhere.
 *
 * How (single pass, no second copy of the data):
 *   ftyp | mdat(64-bit size placeholder) | …sample data appended as fragments arrive… | moov
 * Then the mdat size is patched in place. moov at the end is valid ISO-BMFF; every desktop player handles it.
 *
 * Input: init segments (ftyp+moov with mvex) and media fragments (moof+mdat pairs; styp/sidx/emsg ignored),
 * as produced by mux.js or served by fMP4 HLS.
 */

export interface Sink {
  write(data: Uint8Array): Promise<void>;
  writeAt(position: number, data: Uint8Array): Promise<void>;
  readonly bytes: number;
}

// ------------------------------------------------------------------ byte helpers
const td = new TextDecoder("latin1");
const type4 = (b: Uint8Array, o: number) => td.decode(b.subarray(o, o + 4));
const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const i32 = (b: Uint8Array, o: number) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
const u64 = (b: Uint8Array, o: number) => u32(b, o) * 2 ** 32 + u32(b, o + 4);

interface Box {
  type: string;
  start: number; // box start (header)
  body: number; // payload start
  end: number;
}

function* iter(b: Uint8Array, from = 0, to = b.length): Generator<Box> {
  let o = from;
  while (o + 8 <= to) {
    let size = u32(b, o);
    const type = type4(b, o + 4);
    let hdr = 8;
    if (size === 1) {
      size = u64(b, o + 8);
      hdr = 16;
    } else if (size === 0) size = to - o;
    if (size < hdr || o + size > to) return;
    yield { type, start: o, body: o + hdr, end: o + size };
    o += size;
  }
}
const child = (b: Uint8Array, p: Box, type: string) => {
  for (const c of iter(b, p.body, p.end)) if (c.type === type) return c;
  return undefined;
};

class Grow {
  arr: Uint32Array;
  len = 0;
  constructor(n = 4096) {
    this.arr = new Uint32Array(n);
  }
  push(v: number) {
    if (this.len === this.arr.length) {
      const n = new Uint32Array(this.arr.length * 2);
      n.set(this.arr);
      this.arr = n;
    }
    this.arr[this.len++] = v >>> 0;
  }
  get last() {
    return this.arr[this.len - 1];
  }
  set last(v: number) {
    this.arr[this.len - 1] = v >>> 0;
  }
}

class GrowI {
  arr: Int32Array;
  len = 0;
  constructor(n = 4096) {
    this.arr = new Int32Array(n);
  }
  push(v: number) {
    if (this.len === this.arr.length) {
      const n = new Int32Array(this.arr.length * 2);
      n.set(this.arr);
      this.arr = n;
    }
    this.arr[this.len++] = v | 0;
  }
}

/** Growable big-endian uint32 table: `bytes(cols)` → entry_count (rows) + data. */
class U32Table {
  private g = new Grow(1024);
  row(...v: number[]) {
    for (const x of v) this.g.push(x);
  }
  bytes(cols: number): Uint8Array {
    const out = new Uint8Array(4 + this.g.len * 4);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, this.g.len / cols);
    for (let i = 0; i < this.g.len; i++) dv.setUint32(4 + i * 4, this.g.arr[i]);
    return out;
  }
}

// ------------------------------------------------------------------ box builders
function cat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}
function be32(v: number): Uint8Array {
  return new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
}
function be64(v: number): Uint8Array {
  return cat([be32(Math.floor(v / 2 ** 32)), be32(v >>> 0)]);
}
function be16(v: number): Uint8Array {
  return new Uint8Array([(v >>> 8) & 255, v & 255]);
}
const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const payload = cat(parts);
  return cat([be32(payload.byteLength + 8), ascii(type), payload]);
}
function fullbox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
  return box(type, new Uint8Array([version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255]), ...parts);
}
const MATRIX = cat([be32(0x00010000), be32(0), be32(0), be32(0), be32(0x00010000), be32(0), be32(0), be32(0), be32(0x40000000)]);

// ------------------------------------------------------------------ track state
interface Chunk {
  offset: number;
  count: number;
  sdi: number;
}

interface Track {
  id: number;
  timescale: number;
  handler: string;
  width: number; // 16.16 raw from tkhd
  height: number;
  language: Uint8Array; // 2 bytes from mdhd
  hdlr: Uint8Array;
  xmhd: Uint8Array | null;
  dinf: Uint8Array | null;
  entries: Uint8Array[]; // raw sample-entry boxes (stsd children)
  sdi: number; // current sample description index (1-based)
  trex: { sdi: number; dur: number; size: number; flags: number };
  sizes: Grow;
  durs: Grow;
  ctts: GrowI | null;
  sync: Grow; // 1-based sample numbers that are sync
  anyNonSync: boolean;
  chunks: Chunk[];
  dts: number; // cumulative decode time (track timescale)
  tfdtBase: number | null; // tfdt value that corresponds to dts = 0
}

export class FlatMp4Writer {
  private tracks = new Map<string, Track>(); // key: `${source}:${sourceTrackId}`
  private order: string[] = [];
  private movieTimescale = 1000;
  private mdatStart = -1; // offset of the mdat box header in the output
  private started = false;
  samples = 0;

  private readonly sink: Sink;

  constructor(sink: Sink) {
    this.sink = sink;
  }

  /**
   * Feed an init segment (ftyp+moov). Repeated identical inits are ignored; changed codec config adds an
   * stsd entry. `source` separates independent inputs (e.g. 0 = video playlist, 1 = separate audio
   * rendition) whose track ids may collide; output track ids are renumbered.
   */
  addInit(init: Uint8Array, source = 0): void {
    const moov = [...iter(init)].find((b) => b.type === "moov");
    if (!moov) throw new Error("init segment without moov");
    const trex = new Map<number, Track["trex"]>();
    const mvex = child(init, moov, "mvex");
    if (mvex)
      for (const t of iter(init, mvex.body, mvex.end))
        if (t.type === "trex")
          trex.set(u32(init, t.body + 4), {
            sdi: u32(init, t.body + 8),
            dur: u32(init, t.body + 12),
            size: u32(init, t.body + 16),
            flags: u32(init, t.body + 20),
          });

    for (const trak of iter(init, moov.body, moov.end)) {
      if (trak.type !== "trak") continue;
      const tkhd = child(init, trak, "tkhd");
      const mdia = child(init, trak, "mdia");
      if (!tkhd || !mdia) continue;
      const v = init[tkhd.body];
      const id = u32(init, tkhd.body + (v === 1 ? 20 : 12));
      const mdhd = child(init, mdia, "mdhd")!;
      const mv = init[mdhd.body];
      const timescale = u32(init, mdhd.body + (mv === 1 ? 20 : 12));
      const language = init.slice(mdhd.body + (mv === 1 ? 32 : 20), mdhd.body + (mv === 1 ? 34 : 22));
      const hdlrBox = child(init, mdia, "hdlr")!;
      const handler = type4(init, hdlrBox.body + 8);
      const minf = child(init, mdia, "minf")!;
      const xm = child(init, minf, "vmhd") ?? child(init, minf, "smhd") ?? child(init, minf, "sthd") ?? child(init, minf, "nmhd");
      const dinf = child(init, minf, "dinf");
      const stbl = child(init, minf, "stbl")!;
      const stsd = child(init, stbl, "stsd")!;
      const entries = [...iter(init, stsd.body + 8, stsd.end)].map((e) => init.slice(e.start, e.end));
      const width = u32(init, tkhd.end - 8);
      const height = u32(init, tkhd.end - 4);

      const key = `${source}:${id}`;
      let t = this.tracks.get(key);
      if (!t) {
        t = {
          id: this.order.length + 1,
          timescale,
          handler,
          width,
          height,
          language,
          hdlr: init.slice(hdlrBox.start, hdlrBox.end),
          xmhd: xm ? init.slice(xm.start, xm.end) : null,
          dinf: dinf ? init.slice(dinf.start, dinf.end) : null,
          entries: [],
          sdi: 1,
          trex: trex.get(id) ?? { sdi: 1, dur: 0, size: 0, flags: 0 },
          sizes: new Grow(),
          durs: new Grow(),
          ctts: null,
          sync: new Grow(1024),
          anyNonSync: false,
          chunks: [],
          dts: 0,
          tfdtBase: null,
        };
        this.tracks.set(key, t);
        this.order.push(key);
      } else if (trex.get(id)) t.trex = trex.get(id)!;
      // register sample entry (dedupe by bytes)
      const entry = entries[0];
      if (entry) {
        const idx = t.entries.findIndex((e) => e.byteLength === entry.byteLength && e.every((x, i) => x === entry[i]));
        if (idx >= 0) t.sdi = idx + 1;
        else {
          t.entries.push(entry);
          t.sdi = t.entries.length;
        }
      }
      if (!t.width && width) (t.width = width), (t.height = height);
    }
  }

  private async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const hasVideo = [...this.tracks.values()].some((t) => t.handler === "vide");
    const brands = hasVideo ? ["isom", "iso2", "avc1", "mp41"] : ["M4A ", "isom", "iso2", "mp41"];
    const ftyp = box("ftyp", ascii(brands[0]), be32(0x200), ...brands.map(ascii));
    await this.sink.write(ftyp);
    this.mdatStart = this.sink.bytes;
    // 64-bit mdat header; size patched in finalize()
    await this.sink.write(cat([be32(1), ascii("mdat"), be64(0)]));
  }

  get hasAudio(): boolean {
    return [...this.tracks.values()].some((t) => t.handler === "soun" && t.sizes.len > 0);
  }

  get hasVideo(): boolean {
    return [...this.tracks.values()].some((t) => t.handler === "vide" && t.sizes.len > 0);
  }

  /**
   * Feed one media segment (any number of moof+mdat pairs).
   * `fileOffset` = position of `buf` inside the source file (byte-range segments), used to
   * resolve absolute tfhd base-data-offsets.
   */
  async addFragment(buf: Uint8Array, fileOffset = 0, source = 0): Promise<void> {
    if (!this.tracks.size) throw new Error("fragment before init segment");
    await this.start();
    for (const moof of iter(buf)) {
      if (moof.type !== "moof") continue;
      let prevTrafEnd = moof.start; // base for trafs without explicit base (spec: first traf → moof start)
      for (const traf of iter(buf, moof.body, moof.end)) {
        if (traf.type !== "traf") continue;
        const tfhd = child(buf, traf, "tfhd");
        if (!tfhd) continue;
        const tflags = u32(buf, tfhd.body) & 0xffffff;
        const tid = u32(buf, tfhd.body + 4);
        const t = this.tracks.get(`${source}:${tid}`);
        if (!t) continue;
        let p = tfhd.body + 8;
        let base = tflags & 0x20000 ? moof.start : prevTrafEnd;
        if (tflags & 0x1) {
          // absolute base offsets refer to the source file
          const abs = u64(buf, p) - fileOffset;
          if (abs >= 0 && abs < buf.byteLength) base = abs;
          p += 8;
        }
        let sdi = t.trex.sdi;
        if (tflags & 0x2) (sdi = u32(buf, p)), (p += 4);
        let defDur = t.trex.dur;
        if (tflags & 0x8) (defDur = u32(buf, p)), (p += 4);
        let defSize = t.trex.size;
        if (tflags & 0x10) (defSize = u32(buf, p)), (p += 4);
        let defFlags = t.trex.flags;
        if (tflags & 0x20) (defFlags = u32(buf, p)), (p += 4);
        void sdi; // sample description index from the fragment is relative to the *source* init – we map via t.sdi

        // timeline: honour tfdt gaps (stretch last sample) and timeline resets (rebase)
        const tfdtBox = child(buf, traf, "tfdt");
        if (tfdtBox) {
          const v = buf[tfdtBox.body];
          const tfdt = v === 1 ? u64(buf, tfdtBox.body + 4) : u32(buf, tfdtBox.body + 4);
          if (t.tfdtBase === null) t.tfdtBase = tfdt - t.dts;
          const expected = t.tfdtBase + t.dts;
          const gap = tfdt - expected;
          if (gap > 0 && gap < 5 * t.timescale && t.durs.len) {
            t.durs.last = t.durs.last + gap;
            t.dts += gap;
          } else if (gap < -t.timescale || gap >= 5 * t.timescale) {
            t.tfdtBase = tfdt - t.dts; // discontinuity / reset → rebase
          }
        }

        let dataPos = base;
        for (const trun of iter(buf, traf.body, traf.end)) {
          if (trun.type !== "trun") continue;
          const v = buf[trun.body];
          const fl = u32(buf, trun.body) & 0xffffff;
          const n = u32(buf, trun.body + 4);
          let q = trun.body + 8;
          if (fl & 0x1) (dataPos = base + i32(buf, q)), (q += 4);
          let firstFlags: number | null = null;
          if (fl & 0x4) (firstFlags = u32(buf, q)), (q += 4);
          let runBytes = 0;
          const chunkSampleStart = t.sizes.len;
          for (let i = 0; i < n; i++) {
            const dur = fl & 0x100 ? u32(buf, (q += 4) - 4) : defDur;
            const size = fl & 0x200 ? u32(buf, (q += 4) - 4) : defSize;
            const flags = fl & 0x400 ? u32(buf, (q += 4) - 4) : i === 0 && firstFlags !== null ? firstFlags : defFlags;
            let cto = 0;
            if (fl & 0x800) {
              cto = v === 0 ? u32(buf, q) : i32(buf, q);
              q += 4;
            }
            t.sizes.push(size);
            t.durs.push(dur);
            t.dts += dur;
            if (cto !== 0 && !t.ctts) {
              t.ctts = new GrowI(Math.max(4096, t.sizes.arr.length));
              for (let k = 0; k < t.sizes.len - 1; k++) t.ctts.push(0);
            }
            t.ctts?.push(cto);
            const nonSync = (flags >>> 16) & 1;
            if (nonSync) t.anyNonSync = true;
            else t.sync.push(t.sizes.len);
            runBytes += size;
          }
          if (n === 0) continue;
          if (dataPos < 0 || dataPos + runBytes > buf.byteLength) throw new Error("fragment sample data out of range");
          const offset = this.sink.bytes;
          await this.sink.write(buf.subarray(dataPos, dataPos + runBytes));
          t.chunks.push({ offset, count: t.sizes.len - chunkSampleStart, sdi: t.sdi });
          this.samples += n;
          dataPos += runBytes;
        }
        prevTrafEnd = dataPos;
      }
    }
  }

  /** Append moov and patch the mdat size. */
  async finalize(): Promise<void> {
    await this.start();
    const mdatEnd = this.sink.bytes;
    const needCo64 = mdatEnd > 0xffffffff;
    const traks: Uint8Array[] = [];
    let movieDur = 0;
    for (const id of this.order) {
      const t = this.tracks.get(id)!;
      if (!t.sizes.len) continue;
      const mediaDur = t.dts;
      const dur = Math.round((mediaDur / t.timescale) * this.movieTimescale);
      movieDur = Math.max(movieDur, dur);
      traks.push(this.trak(t, mediaDur, dur, needCo64));
    }
    if (!traks.length) throw new Error("no samples were written");
    const nextId = this.order.length + 1;
    const mvhd = fullbox(
      "mvhd",
      1,
      0,
      be64(0),
      be64(0),
      be32(this.movieTimescale),
      be64(movieDur),
      be32(0x00010000),
      be16(0x0100),
      new Uint8Array(10),
      MATRIX,
      new Uint8Array(24),
      be32(nextId),
    );
    const moov = box("moov", mvhd, ...traks);
    await this.sink.write(moov);
    // patch 64-bit mdat size
    await this.sink.writeAt(this.mdatStart + 8, be64(mdatEnd - this.mdatStart));
  }

  private trak(t: Track, mediaDur: number, movieDur: number, co64: boolean): Uint8Array {
    const isVideo = t.handler === "vide";
    const isAudio = t.handler === "soun";
    const tkhd = fullbox(
      "tkhd",
      1,
      0x7,
      be64(0),
      be64(0),
      be32(t.id),
      be32(0),
      be64(movieDur),
      new Uint8Array(8),
      be16(0),
      be16(isAudio ? 1 : 0),
      be16(isAudio ? 0x0100 : 0),
      be16(0),
      MATRIX,
      be32(isVideo ? t.width : 0),
      be32(isVideo ? t.height : 0),
    );
    const mdhd = fullbox("mdhd", 1, 0, be64(0), be64(0), be32(t.timescale), be64(mediaDur), t.language.byteLength === 2 ? t.language : be16(0x55c4), be16(0));

    // stts (run-length)
    const stts = new U32Table();
    for (let i = 0; i < t.durs.len; ) {
      let j = i + 1;
      while (j < t.durs.len && t.durs.arr[j] === t.durs.arr[i]) j++;
      stts.row(j - i, t.durs.arr[i]);
      i = j;
    }
    const sttsBox = fullbox("stts", 0, 0, stts.bytes(2));

    let cttsBox: Uint8Array | null = null;
    if (t.ctts) {
      const ct = new U32Table();
      let neg = false;
      for (let i = 0; i < t.ctts.len; ) {
        let j = i + 1;
        while (j < t.ctts.len && t.ctts.arr[j] === t.ctts.arr[i]) j++;
        if (t.ctts.arr[i] < 0) neg = true;
        ct.row(j - i, t.ctts.arr[i] >>> 0);
        i = j;
      }
      cttsBox = fullbox("ctts", neg ? 1 : 0, 0, ct.bytes(2));
    }

    let stssBox: Uint8Array | null = null;
    if (t.anyNonSync) {
      const st = new U32Table();
      for (let i = 0; i < t.sync.len; i++) st.row(t.sync.arr[i]);
      stssBox = fullbox("stss", 0, 0, st.bytes(1));
    }

    // stsc (run-length over chunks)
    const stsc = new U32Table();
    let prev: { count: number; sdi: number } | null = null;
    t.chunks.forEach((c, i) => {
      if (!prev || prev.count !== c.count || prev.sdi !== c.sdi) {
        stsc.row(i + 1, c.count, c.sdi);
        prev = c;
      }
    });
    const stscBox = fullbox("stsc", 0, 0, stsc.bytes(3));

    const sizesBytes = new Uint8Array(t.sizes.len * 4);
    const dv = new DataView(sizesBytes.buffer);
    for (let i = 0; i < t.sizes.len; i++) dv.setUint32(i * 4, t.sizes.arr[i]);
    const stszBox = fullbox("stsz", 0, 0, be32(0), be32(t.sizes.len), sizesBytes);

    const offs = new Uint8Array(t.chunks.length * (co64 ? 8 : 4));
    const ov = new DataView(offs.buffer);
    t.chunks.forEach((c, i) => {
      if (co64) {
        ov.setUint32(i * 8, Math.floor(c.offset / 2 ** 32));
        ov.setUint32(i * 8 + 4, c.offset >>> 0);
      } else ov.setUint32(i * 4, c.offset);
    });
    const stcoBox = fullbox(co64 ? "co64" : "stco", 0, 0, be32(t.chunks.length), offs);

    const stsd = fullbox("stsd", 0, 0, be32(t.entries.length), ...t.entries);
    const stbl = box("stbl", ...[stsd, sttsBox, cttsBox, stssBox, stscBox, stszBox, stcoBox].filter((x): x is Uint8Array => !!x));
    const dinf = t.dinf ?? box("dinf", fullbox("dref", 0, 0, be32(1), fullbox("url ", 0, 1)));
    const xmhd = t.xmhd ?? (isVideo ? fullbox("vmhd", 0, 1, new Uint8Array(8)) : isAudio ? fullbox("smhd", 0, 0, new Uint8Array(4)) : fullbox("nmhd", 0, 0));
    const minf = box("minf", xmhd, dinf, stbl);
    const mdia = box("mdia", mdhd, t.hdlr, minf);
    return box("trak", tkhd, mdia);
  }
}
