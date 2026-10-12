import type { DownloadJob, HlsRendition, HlsVariant, MediaItem, Settings } from "./types";

/**
 * Message protocol. Every message is { type, ...payload }.
 * Direction legend:  P = popup, S = side panel, B = background SW, O = offscreen doc
 */
export type Msg =
  // ---- P/S -> B
  | { type: "GET_TAB_MEDIA"; tabId: number }
  | { type: "CLEAR_TAB_MEDIA"; tabId: number }
  | { type: "GET_SETTINGS" }
  | { type: "SET_SETTINGS"; settings: Partial<Settings> }
  | { type: "INSPECT_HLS"; item: MediaItem }                      // returns HlsInspectResult
  | { type: "PROBE_MEDIA"; item: MediaItem }                      // returns MediaProbe
  | { type: "SET_THUMBNAIL"; tabId: number; id: string; dataUrl: string }
  | { type: "FETCH_TEXT"; url: string; headers: Record<string, string> } // generic text fetch through offscreen (for preview etc.)
  | { type: "START_DOWNLOAD"; item: MediaItem; variant?: HlsVariant; audioRendition?: HlsRendition; fileName?: string }
  | { type: "PAUSE_JOB"; jobId: string }
  | { type: "RESUME_JOB"; jobId: string }
  | { type: "CANCEL_JOB"; jobId: string }
  | { type: "REMOVE_JOB"; jobId: string }
  | { type: "RETRY_JOB"; jobId: string }
  | { type: "RESTART_JOB"; jobId: string }                      // discard progress, start from scratch
  | { type: "SKIP_FAILED"; jobId: string }                      // drop segments that keep failing, continue
  | { type: "GET_STORAGE" }                                     // returns StorageInfo
  | { type: "CLEAN_STORAGE" }                                   // remove orphan temp files
  | { type: "GET_JOBS" }
  | { type: "OPEN_SIDE_PANEL"; tabId?: number; windowId?: number }
  | { type: "SHOW_IN_FOLDER"; jobId: string }
  | { type: "OPEN_URL"; url: string }
  | { type: "ENSURE_HEADER_RULE"; item: MediaItem }               // make DNR rule for popup preview
  // ---- B -> O
  | { type: "O_START_JOB"; job: DownloadJob; settings: Settings }
  | { type: "O_PAUSE_JOB"; jobId: string }
  | { type: "O_RESUME_JOB"; jobId: string }
  | { type: "O_CANCEL_JOB"; jobId: string }
  | { type: "O_SKIP_FAILED"; jobId: string }
  | { type: "O_SAVE"; blobUrl: string; fileName: string }
  | { type: "O_STORAGE" }
  | { type: "O_CLEAN_STORAGE"; keep: string[] }
  | { type: "O_INSPECT_HLS"; item: MediaItem }
  | { type: "O_FETCH_TEXT"; url: string; headers: Record<string, string> }
  | { type: "O_PING" }
  // ---- O -> B
  | { type: "JOB_PROGRESS"; job: Partial<DownloadJob> & { id: string } }
  | { type: "JOB_READY_TO_SAVE"; jobId: string; blobUrl: string; fileName: string; size: number }
  | { type: "JOB_FAILED"; jobId: string; error: string }
  | { type: "ADD_RULE_HOSTS"; jobId: string; hosts: string[]; headers: Record<string, string> }
  // ---- B -> P/S broadcast
  | { type: "MEDIA_UPDATED"; tabId: number }
  | { type: "JOBS_UPDATED"; jobs: DownloadJob[] }
  | { type: "SETTINGS_UPDATED"; settings: Settings };

export type MsgType = Msg["type"];
export type MsgOf<T extends MsgType> = Extract<Msg, { type: T }>;

export interface StorageInfo {
  /** origin quota (bytes) reported by navigator.storage.estimate() – ≈ what this extension may use */
  quota: number;
  /** bytes this extension currently uses (OPFS temp files + storage) */
  usage: number;
  /** temp files of in-progress / finished-but-not-cleaned downloads */
  temp: { name: string; size: number; jobId: string; active: boolean }[];
  tempBytes: number;
  /** bytes still needed to finish active jobs (estimate) */
  pendingBytes: number;
}

export interface HlsInspectResult {
  ok: boolean;
  error?: string;
  isMaster: boolean;
  variants: HlsVariant[];
  audioRenditions: HlsRendition[];
  duration?: number;
  isLive?: boolean;
  segmentCount?: number;
  encrypted?: boolean;
  fmp4?: boolean;
}

export function send<R = unknown>(msg: Msg): Promise<R> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve(res as R);
      });
    } catch (e) {
      reject(e);
    }
  });
}

/** Fire-and-forget broadcast; swallow "no receiver" errors. */
export function broadcast(msg: Msg): void {
  try {
    chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
  } catch {
    /* ignore */
  }
}
