/**
 * Tiny container sniffers used to answer: "does this media have video? audio? which codecs? what size?"
 * Pure functions over a Uint8Array prefix – no DOM, no decoding. Good enough for UI badges.
 */
export interface TrackInfo {
  video: boolean;
  audio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  duration?: number; // seconds, when the container tells us (MP4 mvhd)
  container?: "ts" | "mp4" | "webm" | "aac" | "mp3" | "unknown";
}

const td = new TextDecoder("latin1");
const fourcc = (b: Uint8Array, o: number) => td.decode(b.subarray(o, o + 4));
const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];

export function probeBytes(bytes: Uint8Array): TrackInfo {
  if (bytes.length < 16) return { video: false, audio: false, container: "unknown" };
  if (bytes[0] === 0x47 && (bytes.length < 376 || bytes[188] === 0x47)) return probeTs(bytes);
  if (fourcc(bytes, 4) === "ftyp" || fourcc(bytes, 4) === "moov" || fourcc(bytes, 4) === "styp" || fourcc(bytes, 4) === "moof")
    return probeMp4(bytes);
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return probeWebm(bytes);
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return { video: false, audio: true, audioCodec: "mp3/aac(ID3)", container: "mp3" };
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return { video: false, audio: true, audioCodec: "aac", container: "aac" };
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return { video: false, audio: true, audioCodec: "mp3", container: "mp3" };
  return { video: false, audio: false, container: "unknown" };
}

// ------------------------------------------------------------------ MPEG-TS
const TS_VIDEO: Record<number, string> = { 0x01: "mpeg1", 0x02: "mpeg2", 0x10: "mpeg4", 0x1b: "avc", 0x24: "hevc", 0x51: "vvc" };
const TS_AUDIO: Record<number, string> = { 0x03: "mp3", 0x04: "mp3", 0x0f: "aac", 0x11: "aac-latm", 0x81: "ac3", 0x87: "eac3", 0x82: "dts", 0x8a: "dts" };

function probeTs(b: Uint8Array): TrackInfo {
  const info: TrackInfo = { video: false, audio: false, container: "ts" };
  let pmtPid = -1;
  for (let o = 0; o + 188 <= b.length; o += 188) {
    if (b[o] !== 0x47) {
      // resync
      const n = b.indexOf(0x47, o + 1);
      if (n < 0) break;
      o = n - 188;
      continue;
    }
    const pusi = (b[o + 1] & 0x40) !== 0;
    const pid = ((b[o + 1] & 0x1f) << 8) | b[o + 2];
    const afc = (b[o + 3] >> 4) & 0x3;
    let p = o + 4;
    if (afc & 2) p += 1 + b[p]; // adaptation field
    if (!(afc & 1) || !pusi) continue;
    p += 1 + b[p]; // pointer_field
    if (p >= o + 188) continue;
    const tableId = b[p];
    const sectionLen = ((b[p + 1] & 0x0f) << 8) | b[p + 2];
    const end = Math.min(p + 3 + sectionLen - 4, o + 188); // minus CRC
    if (pid === 0 && tableId === 0 && pmtPid < 0) {
      for (let q = p + 8; q + 4 <= end; q += 4) {
        const prog = u16(b, q);
        if (prog !== 0) {
          pmtPid = ((b[q + 2] & 0x1f) << 8) | b[q + 3];
          break;
        }
      }
    } else if (pid === pmtPid && tableId === 2) {
      const pil = ((b[p + 10] & 0x0f) << 8) | b[p + 11];
      let q = p + 12 + pil;
      while (q + 5 <= end) {
        const st = b[q];
        const esLen = ((b[q + 3] & 0x0f) << 8) | b[q + 4];
        const desc = b.subarray(q + 5, q + 5 + esLen);
        if (TS_VIDEO[st]) (info.video = true), (info.videoCodec ||= TS_VIDEO[st]);
        else if (TS_AUDIO[st]) (info.audio = true), (info.audioCodec ||= TS_AUDIO[st]);
        else if (st === 0x06) {
          // private PES – look for AC-3 / E-AC-3 / DTS / Opus descriptors
          for (let d = 0; d + 2 <= desc.length; d += 2 + desc[d + 1]) {
            const tag = desc[d];
            if (tag === 0x6a || tag === 0x81) (info.audio = true), (info.audioCodec ||= "ac3");
            else if (tag === 0x7a) (info.audio = true), (info.audioCodec ||= "eac3");
            else if (tag === 0x7b) (info.audio = true), (info.audioCodec ||= "dts");
            else if (tag === 0x05 && td.decode(desc.subarray(d + 2, d + 6)) === "Opus") (info.audio = true), (info.audioCodec ||= "opus");
          }
        }
        q += 5 + esLen;
      }
      return info;
    }
  }
  return info;
}

// ------------------------------------------------------------------ MP4 / fMP4
interface Box {
  type: string;
  start: number; // payload start
  end: number;
}

function* boxes(b: Uint8Array, from: number, to: number): Generator<Box> {
  let o = from;
  while (o + 8 <= to) {
    let size = u32(b, o);
    const type = fourcc(b, o + 4);
    let hdr = 8;
    if (size === 1) {
      if (o + 16 > to) return;
      size = u32(b, o + 8) * 2 ** 32 + u32(b, o + 12);
      hdr = 16;
    } else if (size === 0) size = to - o;
    if (size < hdr) return;
    yield { type, start: o + hdr, end: Math.min(to, o + size) };
    o += size;
  }
}

function findBox(b: Uint8Array, from: number, to: number, type: string): Box | undefined {
  for (const bx of boxes(b, from, to)) if (bx.type === type) return bx;
  return undefined;
}

/** Locate the `moov` box in `b` (which may be the head or the tail of a file). */
export function findMoov(b: Uint8Array): Box | undefined {
  // fast path: well-formed from offset 0
  const top = findBox(b, 0, b.length, "moov");
  if (top && top.end - top.start > 8) return top;
  // tail scan: look for "moov" tag whose size reaches exactly the end of the buffer (moov is last box)
  for (let o = b.length - 8; o >= 0; o--) {
    if (b[o + 4] === 0x6d && b[o + 5] === 0x6f && b[o + 6] === 0x6f && b[o + 7] === 0x76) {
      const size = u32(b, o);
      if (size >= 8 && o + size <= b.length && o + size >= b.length - 64) return { type: "moov", start: o + 8, end: o + size };
    }
  }
  return undefined;
}

export function probeMp4(b: Uint8Array): TrackInfo {
  const info: TrackInfo = { video: false, audio: false, container: "mp4" };
  const moov = findMoov(b);
  if (!moov) return info; // moov not in this slice
  const mvhd = findBox(b, moov.start, moov.end, "mvhd");
  if (mvhd) {
    const v = b[mvhd.start];
    const ts = v === 1 ? u32(b, mvhd.start + 20) : u32(b, mvhd.start + 12);
    const dur = v === 1 ? u32(b, mvhd.start + 24) * 2 ** 32 + u32(b, mvhd.start + 28) : u32(b, mvhd.start + 16);
    if (ts && dur && dur !== 0xffffffff) info.duration = dur / ts;
  }
  for (const trak of boxes(b, moov.start, moov.end)) {
    if (trak.type !== "trak") continue;
    const mdia = findBox(b, trak.start, trak.end, "mdia");
    if (!mdia) continue;
    const hdlr = findBox(b, mdia.start, mdia.end, "hdlr");
    const handler = hdlr ? fourcc(b, hdlr.start + 8) : "";
    const minf = findBox(b, mdia.start, mdia.end, "minf");
    const stbl = minf && findBox(b, minf.start, minf.end, "stbl");
    const stsd = stbl && findBox(b, stbl.start, stbl.end, "stsd");
    let codec = "";
    let w = 0;
    let h = 0;
    if (stsd && stsd.end - stsd.start > 16) {
      const e = stsd.start + 8; // version/flags + entry_count
      codec = fourcc(b, e + 4);
      if (handler === "vide" && e + 36 <= stsd.end) {
        w = u16(b, e + 32);
        h = u16(b, e + 34);
      }
    }
    if (handler === "vide") {
      info.video = true;
      info.videoCodec ||= codec;
      if (w && h && !info.width) (info.width = w), (info.height = h);
    } else if (handler === "soun") {
      info.audio = true;
      info.audioCodec ||= codec;
    }
  }
  return info;
}

// ------------------------------------------------------------------ WebM / Matroska (heuristic)
export function probeWebm(b: Uint8Array): TrackInfo {
  const info: TrackInfo = { video: false, audio: false, container: "webm" };
  const s = td.decode(b.subarray(0, Math.min(b.length, 1 << 20)));
  // TrackType (0x83) with 1-byte size (0x81): 1 = video, 2 = audio
  for (let i = 0; i + 2 < b.length && i < 1 << 20; i++) {
    if (b[i] === 0x83 && b[i + 1] === 0x81) {
      if (b[i + 2] === 1) info.video = true;
      else if (b[i + 2] === 2) info.audio = true;
    }
  }
  const v = /V_(?:VP8|VP9|AV1|MPEG4\/ISO\/AVC|MPEGH\/ISO\/HEVC|THEORA|MPEG1|MPEG2)/.exec(s);
  const a = /A_(?:OPUS|VORBIS|AAC|MPEG\/L3|FLAC|AC3|EAC3|DTS|PCM)/.exec(s);
  if (v) (info.video = true), (info.videoCodec = v[0]);
  if (a) (info.audio = true), (info.audioCodec = a[0]);
  // PixelWidth 0xB0 / PixelHeight 0xBA with 1–2 byte sizes
  const dim = (id: number) => {
    for (let i = 0; i + 3 < b.length && i < 1 << 20; i++) {
      if (b[i] === id && (b[i + 1] === 0x81 || b[i + 1] === 0x82)) {
        const val = b[i + 1] === 0x81 ? b[i + 2] : u16(b, i + 2);
        if (val > 15 && val < 10000) return val;
      }
    }
    return 0;
  };
  if (info.video) {
    const w = dim(0xb0);
    const h = dim(0xba);
    if (w && h) (info.width = w), (info.height = h);
  }
  return info;
}

/** Interpret an HLS CODECS attribute. */
export function tracksFromCodecs(codecs?: string, resolution?: boolean): Partial<TrackInfo> | undefined {
  if (!codecs) return resolution ? { video: true } : undefined;
  const parts = codecs.toLowerCase().split(",").map((x) => x.trim());
  const out: Partial<TrackInfo> = { video: false, audio: false };
  for (const p of parts) {
    if (/^(avc|hvc|hev|av01|vp0?9|vp8|dvh|mp4v|h26)/.test(p)) (out.video = true), (out.videoCodec ||= p.split(".")[0]);
    else if (/^(mp4a|ec-3|ac-3|opus|flac|alac|mp3|vorbis|dts)/.test(p)) (out.audio = true), (out.audioCodec ||= p.split(".")[0]);
  }
  if (!out.video && resolution) out.video = true;
  return out;
}

export function describeTracks(t?: Partial<TrackInfo> | null, audioSeparate?: boolean): { label: string; tone: "ok" | "warn" | "info" | "none" } {
  if (!t || (t.video === undefined && t.audio === undefined)) return { label: "", tone: "none" };
  if (t.video && t.audio) return { label: "Video + audio", tone: "ok" };
  if (t.video && !t.audio) return audioSeparate ? { label: "Video + separate audio", tone: "info" } : { label: "Video only · no audio", tone: "warn" };
  if (!t.video && t.audio) return { label: "Audio only", tone: "info" };
  return { label: "", tone: "none" };
}
