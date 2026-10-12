import type { HlsRendition, HlsVariant } from "./types";

/** Minimal, dependency-free HLS playlist parser (RFC 8216 subset needed for downloading). */

export interface ByteRange {
  length: number;
  offset: number;
}

export interface SegmentKey {
  method: "NONE" | "AES-128" | "SAMPLE-AES" | "SAMPLE-AES-CTR" | string;
  uri?: string;
  iv?: Uint8Array;
  keyFormat?: string;
}

export interface InitMap {
  uri: string;
  byteRange?: ByteRange;
}

export interface Segment {
  index: number;           // position in our list
  sn: number;              // media sequence number
  uri: string;             // absolute
  duration: number;
  byteRange?: ByteRange;
  key?: SegmentKey;        // effective key (undefined = clear)
  map?: InitMap;           // effective init segment
  discontinuity: boolean;
}

export interface MediaPlaylist {
  kind: "media";
  targetDuration: number;
  mediaSequence: number;
  endList: boolean;
  playlistType?: string;
  segments: Segment[];
  duration: number;
  encrypted: boolean;
  unsupportedEncryption?: string;
  fmp4: boolean;
}

export interface MasterPlaylist {
  kind: "master";
  variants: HlsVariant[];
  audio: HlsRendition[];
}

export type Playlist = MediaPlaylist | MasterPlaylist;

/** Parse an attribute list:  KEY=VALUE,KEY="quoted, value" */
export function parseAttrs(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[m[1].toUpperCase()] = v;
  }
  return out;
}

export function resolveUrl(uri: string, base: string): string {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

function parseByteRange(v: string, prevEnd: number): ByteRange {
  const [len, off] = v.split("@");
  const length = parseInt(len, 10);
  const offset = off !== undefined ? parseInt(off, 10) : prevEnd;
  return { length, offset };
}

function hexToBytes(hex: string): Uint8Array {
  let h = hex.replace(/^0x/i, "");
  if (h.length % 2) h = "0" + h;
  const out = new Uint8Array(16);
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.substr(i * 2, 2), 16);
  out.set(bytes.slice(-16), 16 - Math.min(16, bytes.length));
  return out;
}

export function isPlaylistText(text: string): boolean {
  return text.trimStart().startsWith("#EXTM3U");
}

export function formatBandwidth(bps: number): string {
  if (!bps) return "";
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1e3)} kbps`;
}

/**
 * Industry-standard quality class. Wide films (1920×800, 2.4:1) are "1080p" even though only 800 lines
 * tall – the class follows whichever dimension fills the 16:9 frame (YouTube/Netflix behaviour).
 */
export function qualityClass(width?: number, height?: number): string {
  if (!width && !height) return "";
  let w = width ?? Math.round(((height ?? 0) * 16) / 9);
  let h = height ?? Math.round((w * 9) / 16);
  if (h > w) [w, h] = [h, w]; // portrait video (1080×1920) is "1080p", not "4K"
  const eq = Math.max(h, Math.round((w * 9) / 16)); // 16:9-equivalent height
  const ladder: [number, string][] = [
    [4320, "8K"],
    [2160, "4K"],
    [1440, "1440p"],
    [1080, "1080p"],
    [720, "720p"],
    [540, "540p"],
    [480, "480p"],
    [360, "360p"],
    [240, "240p"],
    [144, "144p"],
  ];
  for (const [min, name] of ladder) if (eq >= min * 0.92) return name;
  return `${h}p`;
}

export function variantLabel(v: Pick<HlsVariant, "height" | "width" | "bandwidth">): string {
  const parts: string[] = [];
  const q = qualityClass(v.width, v.height);
  if (q) parts.push(q);
  const bw = formatBandwidth(v.bandwidth);
  if (bw) parts.push(bw);
  return parts.join(" • ") || "Default";
}

/** 16:9-equivalent height, used to sort and match "Up to 1080p" preferences. */
export function equivHeight(width?: number, height?: number): number {
  if (!width && !height) return 0;
  let w = width ?? 0;
  let h = height ?? 0;
  if (h > w && w) [w, h] = [h, w];
  return Math.max(h, Math.round((w * 9) / 16));
}

export function parsePlaylist(text: string, baseUrl: string): Playlist {
  if (!isPlaylistText(text)) throw new Error("Not an HLS playlist (missing #EXTM3U)");
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"))) return parseMaster(lines, baseUrl);
  return parseMedia(lines, baseUrl);
}

function parseMaster(lines: string[], base: string): MasterPlaylist {
  const variants: HlsVariant[] = [];
  const audio: HlsRendition[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const a = parseAttrs(line.slice(18));
      // next non-comment line is the URI
      let uri = "";
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].startsWith("#")) {
          uri = lines[j];
          i = j;
          break;
        }
      }
      if (!uri) continue;
      const [w, h] = (a.RESOLUTION || "").split("x").map((n) => parseInt(n, 10));
      const bandwidth = parseInt(a["AVERAGE-BANDWIDTH"] || a.BANDWIDTH || "0", 10);
      const v: HlsVariant = {
        url: resolveUrl(uri, base),
        bandwidth,
        width: Number.isFinite(w) ? w : undefined,
        height: Number.isFinite(h) ? h : undefined,
        codecs: a.CODECS,
        frameRate: a["FRAME-RATE"] ? parseFloat(a["FRAME-RATE"]) : undefined,
        audioGroup: a.AUDIO,
        label: "",
      };
      v.label = variantLabel(v);
      variants.push(v);
    } else if (line.startsWith("#EXT-X-MEDIA:")) {
      const a = parseAttrs(line.slice(13));
      if ((a.TYPE || "").toUpperCase() === "AUDIO" && a.URI) {
        audio.push({
          url: resolveUrl(a.URI, base),
          groupId: a["GROUP-ID"] || "",
          name: a.NAME || a.LANGUAGE || "Audio",
          language: a.LANGUAGE,
          isDefault: (a.DEFAULT || "").toUpperCase() === "YES",
        });
      }
    }
  }
  // de-duplicate identical URLs, keep highest bandwidth first
  const seen = new Set<string>();
  const uniq = variants
    .sort((x, y) => equivHeight(y.width, y.height) - equivHeight(x.width, x.height) || y.bandwidth - x.bandwidth)
    .filter((v) => (seen.has(v.url) ? false : (seen.add(v.url), true)));
  return { kind: "master", variants: uniq, audio };
}

function parseMedia(lines: string[], base: string): MediaPlaylist {
  const segments: Segment[] = [];
  let targetDuration = 0;
  let mediaSequence = 0;
  let endList = false;
  let playlistType: string | undefined;
  let curKey: SegmentKey | undefined;
  let curMap: InitMap | undefined;
  let pendingDuration = 0;
  let pendingRange: ByteRange | undefined;
  let pendingDisc = false;
  let lastRangeEnd = 0;
  let mapLastEnd = 0;
  let encrypted = false;
  let unsupportedEncryption: string | undefined;

  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      pendingDuration = parseFloat(line.slice(8).split(",")[0]) || 0;
    } else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = parseFloat(line.slice(22)) || 0;
    } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = parseInt(line.slice(22), 10) || 0;
    } else if (line.startsWith("#EXT-X-PLAYLIST-TYPE:")) {
      playlistType = line.slice(21).trim().toUpperCase();
    } else if (line === "#EXT-X-ENDLIST") {
      endList = true;
    } else if (line === "#EXT-X-DISCONTINUITY") {
      pendingDisc = true;
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      pendingRange = parseByteRange(line.slice(17), lastRangeEnd);
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const a = parseAttrs(line.slice(11));
      const method = (a.METHOD || "NONE").toUpperCase();
      const keyFormat = a.KEYFORMAT;
      if (method === "NONE") {
        curKey = undefined;
      } else if (keyFormat && keyFormat !== "identity") {
        // DRM key systems (widevine/fairplay/playready) – we can't decrypt these; ignore if an identity key also exists
        unsupportedEncryption = unsupportedEncryption || `DRM (${keyFormat})`;
        continue;
      } else {
        curKey = {
          method,
          uri: a.URI ? resolveUrl(a.URI, base) : undefined,
          iv: a.IV ? hexToBytes(a.IV) : undefined,
          keyFormat,
        };
        encrypted = true;
        if (method !== "AES-128") unsupportedEncryption = method;
      }
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const a = parseAttrs(line.slice(11));
      if (a.URI) {
        curMap = {
          uri: resolveUrl(a.URI, base),
          byteRange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, mapLastEnd) : undefined,
        };
        if (curMap.byteRange) mapLastEnd = curMap.byteRange.offset + curMap.byteRange.length;
      }
    } else if (!line.startsWith("#")) {
      const seg: Segment = {
        index: segments.length,
        sn: mediaSequence + segments.length,
        uri: resolveUrl(line, base),
        duration: pendingDuration,
        byteRange: pendingRange,
        key: curKey,
        map: curMap,
        discontinuity: pendingDisc,
      };
      if (pendingRange) lastRangeEnd = pendingRange.offset + pendingRange.length;
      segments.push(seg);
      pendingDuration = 0;
      pendingRange = undefined;
      pendingDisc = false;
    }
  }

  const duration = segments.reduce((s, x) => s + x.duration, 0);
  const fmp4 =
    !!segments[0]?.map ||
    segments.slice(0, 3).some((s) => /\.(m4s|mp4|m4v|m4a|cmfv|cmfa)(\?|$)/i.test(s.uri));
  if (playlistType === "VOD") endList = true;

  // Unsupported when: any segment uses a non AES-128 method (SAMPLE-AES…), or a DRM key
  // system was declared and no identity (clear-key) AES-128 key is available for segments.
  const badMethod = segments.find((s) => s.key && s.key.method !== "AES-128")?.key?.method;
  const drmOnly = unsupportedEncryption?.startsWith("DRM") && !encrypted ? unsupportedEncryption : undefined;

  return {
    kind: "media",
    targetDuration,
    mediaSequence,
    endList,
    playlistType,
    segments,
    duration,
    encrypted,
    unsupportedEncryption: badMethod || drmOnly,
    fmp4,
  };
}

/** Default IV for AES-128 when the tag has none: media sequence number as 128-bit big-endian. */
export function ivFromSequence(sn: number): Uint8Array {
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  view.setUint32(8, Math.floor(sn / 2 ** 32));
  view.setUint32(12, sn >>> 0);
  return iv;
}
