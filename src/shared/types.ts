/** A media resource detected by the sniffer for one tab. */
export type MediaKind = "hls" | "dash" | "video" | "audio";

export interface MediaItem {
  id: string;            // stable id (hash of url)
  tabId: number;
  url: string;
  kind: MediaKind;
  ext: string;           // m3u8 | mp4 | webm | mkv | mp3 | ...
  mime: string;
  size: number;          // bytes (0 if unknown / HLS)
  name: string;          // suggested file name (no extension)
  pageUrl: string;
  pageTitle: string;
  headers: Record<string, string>; // sanitized original request headers for replay
  method: "GET" | "POST";
  detectedAt: number;
  /** filled in lazily by popup when the playlist is inspected */
  variants?: HlsVariant[];
  duration?: number;
  isLive?: boolean;
  /** lazily probed track info (see background/probe.ts) */
  probe?: MediaProbe;
  /** data: URL of a captured frame / poster (popup-generated) */
  thumbnail?: string;
}

export interface MediaProbe {
  at: number;
  video?: boolean;
  audio?: boolean;
  audioSeparate?: boolean; // HLS: audio is a separate rendition
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  duration?: number;
  estSize?: number;   // bytes, estimated for HLS / exact for direct
  segments?: number;
  encrypted?: boolean;
  live?: boolean;
  error?: string;
}

export interface HlsVariant {
  url: string;
  bandwidth: number;
  width?: number;
  height?: number;
  codecs?: string;
  frameRate?: number;
  audioGroup?: string;
  label: string;         // "1080p • 5.2 Mbps"
  estSize?: number;      // bandwidth × duration, filled after inspect
  hasAudio?: boolean;    // from CODECS
}

export interface HlsRendition {
  url: string;
  groupId: string;
  name: string;
  language?: string;
  isDefault: boolean;
}

export type JobStatus =
  | "queued"
  | "preparing"
  | "downloading"
  | "paused"
  | "muxing"
  | "saving"
  | "done"
  | "error"
  | "cancelled";

export interface DownloadJob {
  id: string;
  item: MediaItem;
  /** chosen variant for HLS; undefined for direct files */
  variant?: HlsVariant;
  audioRendition?: HlsRendition;
  fileName: string;       // final name with extension
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  // progress
  totalSegments: number;
  doneSegments: number;
  failedSegments: number;
  bytesDone: number;
  bytesTotal: number;     // 0 when unknown
  /** HLS: running estimate of the final size from bytes-per-segment so far */
  estTotal?: number;
  speedBps: number;
  etaSec: number;
  error?: string;
  chromeDownloadId?: number;
  /** output container decided by engine */
  container?: "mp4" | "ts" | "webm" | "mkv" | "mp3" | "m4a" | "bin";
}

export interface Settings {
  threads: number;            // parallel segment fetches (1-16)
  minSizeKB: number;          // ignore direct files smaller than this
  blockedHosts: string[];     // never list media from these hosts
  autoOpenPanel: boolean;     // open side panel when a download starts
  saveAsDialog: boolean;      // chrome.downloads saveAs prompt
  remuxTs: boolean;           // TS → fMP4 remux (otherwise save .ts)
  filenameFrom: "title" | "resource";
  maxRetries: number;
  theme: "dark" | "light" | "system";
  /** resolution label style: "short" uses the short side (800p), "standard" maps to 4K/1080p/720p… */
  /** "ask" = always show picker; "best" | "720" | "1080" | … = preselect */
  preferredQuality: "ask" | "best" | "smallest" | "2160" | "1440" | "1080" | "720" | "480" | "360";
  showThumbnails: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  threads: 6,
  minSizeKB: 300,
  blockedHosts: [],
  autoOpenPanel: true,
  saveAsDialog: false,
  remuxTs: true,
  filenameFrom: "title",
  maxRetries: 4,
  theme: "dark",
  preferredQuality: "ask",
  showThumbnails: true,
};

export const SKIPPED_PAGE_HOSTS = ["youtube.com", "youtu.be", "music.youtube.com", "globo.com"];
