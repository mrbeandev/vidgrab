import type { DownloadJob, HlsRendition, HlsVariant, MediaItem } from "@shared/types";
import { broadcast } from "@shared/messages";
import { hostOf, sanitizeFileName, uid } from "@shared/utils";
import { getSettings } from "./settings";
import { ensureRule, removeRule } from "./rules";
import { toOffscreen } from "./offscreen";

const KEY = "jobs";
let jobs: DownloadJob[] | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

async function load(): Promise<DownloadJob[]> {
  if (jobs) return jobs;
  const res = await chrome.storage.session.get(KEY);
  jobs = (res[KEY] as DownloadJob[]) ?? [];
  // Jobs that were mid-flight when the browser/SW died can't be resumed (offscreen state is gone).
  for (const j of jobs) {
    if (["queued", "preparing", "downloading", "muxing", "saving", "paused"].includes(j.status)) {
      j.status = "error";
      j.error = j.error || "Interrupted (browser restarted)";
    }
  }
  return jobs;
}

function persist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    chrome.storage.session.set({ [KEY]: jobs ?? [] }).catch(() => {});
  }, 300);
}

let bcastTimer: ReturnType<typeof setTimeout> | null = null;
function notify(): void {
  persist();
  if (bcastTimer) return;
  bcastTimer = setTimeout(() => {
    bcastTimer = null;
    broadcast({ type: "JOBS_UPDATED", jobs: jobs ?? [] });
  }, 150);
}

export async function getJobs(): Promise<DownloadJob[]> {
  return [...(await load())].sort((a, b) => b.createdAt - a.createdAt);
}

function find(id: string): DownloadJob | undefined {
  return jobs?.find((j) => j.id === id);
}

export function ruleKey(jobId: string): string {
  return `job:${jobId}`;
}

export async function startDownload(
  item: MediaItem,
  variant?: HlsVariant,
  audioRendition?: HlsRendition,
  fileName?: string,
): Promise<DownloadJob> {
  await load();
  const settings = await getSettings();
  const baseName = sanitizeFileName(
    fileName || (settings.filenameFrom === "title" ? item.pageTitle || item.name : item.name || item.pageTitle),
  );
  const job: DownloadJob = {
    id: uid(),
    item,
    variant,
    audioRendition,
    fileName: baseName, // extension appended by engine once container is known
    status: "queued",
    createdAt: Date.now(),
    totalSegments: 0,
    doneSegments: 0,
    failedSegments: 0,
    bytesDone: 0,
    bytesTotal: item.kind === "hls" ? 0 : item.size,
    speedBps: 0,
    etaSec: 0,
  };
  jobs!.unshift(job);
  notify();

  // Header rule for every host we already know about.
  const hosts = new Set<string>([hostOf(item.url)]);
  if (variant) hosts.add(hostOf(variant.url));
  if (audioRendition) hosts.add(hostOf(audioRendition.url));
  await ensureRule(ruleKey(job.id), item.headers, [...hosts]);

  toOffscreen({ type: "O_START_JOB", job, settings }).catch((e) => {
    job.status = "error";
    job.error = `Could not start engine: ${String(e)}`;
    notify();
  });
  return job;
}

export async function updateJob(patch: Partial<DownloadJob> & { id: string }): Promise<void> {
  await load();
  const j = find(patch.id);
  if (!j) return;
  Object.assign(j, patch);
  notify();
}

export async function pauseJob(id: string): Promise<void> {
  const j = find(id);
  if (!j) return;
  await toOffscreen({ type: "O_PAUSE_JOB", jobId: id }).catch(() => {});
}
export async function resumeJob(id: string): Promise<void> {
  const j = find(id);
  if (!j) return;
  await toOffscreen({ type: "O_RESUME_JOB", jobId: id }).catch(() => {});
}
export async function cancelJob(id: string): Promise<void> {
  const j = find(id);
  if (!j) return;
  await toOffscreen({ type: "O_CANCEL_JOB", jobId: id }).catch(() => {});
  j.status = "cancelled";
  await removeRule(ruleKey(id));
  notify();
}
export async function removeJob(id: string): Promise<void> {
  await load();
  const j = find(id);
  if (!j) return;
  if (!["done", "error", "cancelled"].includes(j.status)) await cancelJob(id);
  jobs = jobs!.filter((x) => x.id !== id);
  await removeRule(ruleKey(id));
  notify();
}
export async function skipFailed(id: string): Promise<void> {
  if (!find(id)) return;
  await toOffscreen({ type: "O_SKIP_FAILED", jobId: id }).catch(() => {});
}

/** Throw away all progress and start the same download again (fresh playlist / URLs). */
export async function restartJob(id: string): Promise<DownloadJob | undefined> {
  await load();
  const j = find(id);
  if (!j) return;
  await toOffscreen({ type: "O_CANCEL_JOB", jobId: id }).catch(() => {});
  await removeRule(ruleKey(id));
  jobs = jobs!.filter((x) => x.id !== id);
  notify();
  return startDownload(j.item, j.variant, j.audioRendition, j.fileName.replace(/\.[a-z0-9]{2,4}$/i, ""));
}

export async function storageInfo(): Promise<import("@shared/messages").StorageInfo> {
  await load();
  const info = await toOffscreen<import("@shared/messages").StorageInfo>({ type: "O_STORAGE" });
  const active = jobs!.filter((j) => ["queued", "preparing", "downloading", "paused", "muxing"].includes(j.status));
  info.pendingBytes = active.reduce((s, j) => {
    const total = j.bytesTotal || j.estTotal || j.variant?.estSize || 0;
    return s + Math.max(0, total - j.bytesDone);
  }, 0);
  return info;
}

export async function cleanStorage(): Promise<{ freed: number }> {
  await load();
  const keep = jobs!.filter((j) => j.status === "saving").map((j) => j.id);
  return toOffscreen<{ freed: number }>({ type: "O_CLEAN_STORAGE", keep });
}

export async function retryJob(id: string): Promise<DownloadJob | undefined> {
  await load();
  const j = find(id);
  if (!j) return;
  jobs = jobs!.filter((x) => x.id !== id);
  notify();
  return startDownload(j.item, j.variant, j.audioRendition, j.fileName.replace(/\.[a-z0-9]{2,4}$/i, ""));
}

/**
 * Downloads started by the offscreen document's <a download> (see offscreen/index.ts O_SAVE) appear here.
 * Match them to the job by blob URL so we can track completion.
 */
const awaitingCreate = new Map<string, string>(); // blobUrl → jobId
chrome.downloads.onCreated.addListener(async (d) => {
  const jobId = awaitingCreate.get(d.url) ?? awaitingCreate.get(d.finalUrl);
  if (!jobId) return;
  awaitingCreate.delete(d.url);
  await load();
  const j = find(jobId);
  if (!j) return;
  j.chromeDownloadId = d.id;
  notify();
});

/** Offscreen prepared a blob URL → hand it to chrome.downloads. */
export async function saveJob(jobId: string, blobUrl: string, fileName: string, size: number): Promise<void> {
  await load();
  const j = find(jobId);
  if (!j) return;
  const settings = await getSettings();
  j.status = "saving";
  j.fileName = fileName;
  j.bytesTotal = size || j.bytesTotal;
  notify();
  try {
    if (settings.saveAsDialog) {
      // explicit Save-As dialog: the user picks the name, so other extensions can't mangle it
      j.chromeDownloadId = await chrome.downloads.download({ url: blobUrl, filename: fileName, saveAs: true, conflictAction: "uniquify" });
    } else {
      // <a download="name"> in the offscreen document. Unlike chrome.downloads.download({filename}),
      // this name survives other download-manager extensions that answer
      // onDeterminingFilename with an empty suggestion, which made Chrome fall back to the blob GUID.
      awaitingCreate.set(blobUrl, jobId);
      setTimeout(() => awaitingCreate.delete(blobUrl), 120_000);
      await toOffscreen({ type: "O_SAVE", blobUrl, fileName });
    }
    notify();
  } catch (e) {
    j.status = "error";
    j.error = `Save failed: ${String(e)}`;
    notify();
  }
}

/** Track chrome.downloads completion so we can release the blob / OPFS file. */
chrome.downloads.onChanged.addListener(async (delta) => {
  await load();
  const j = jobs!.find((x) => x.chromeDownloadId === delta.id);
  if (!j) return;
  if (delta.state?.current === "complete") {
    j.status = "done";
    j.finishedAt = Date.now();
    j.bytesDone = j.bytesTotal || j.bytesDone;
    await removeRule(ruleKey(j.id));
    notify();
    toOffscreen({ type: "O_CANCEL_JOB", jobId: j.id }).catch(() => {}); // frees blob+OPFS
  } else if (delta.state?.current === "interrupted") {
    const reason = delta.error?.current ?? "unknown";
    if (reason === "USER_CANCELED") {
      j.status = "cancelled";
      j.error = undefined;
    } else {
      j.status = "error";
      j.error = `Save interrupted: ${reason}`;
    }
    notify();
  }
});

export async function showInFolder(jobId: string): Promise<void> {
  const j = find(jobId);
  if (j?.chromeDownloadId !== undefined) chrome.downloads.show(j.chromeDownloadId);
}
