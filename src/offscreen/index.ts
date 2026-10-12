import type { Msg } from "@shared/messages";
import { JobRunner } from "./engine/job";
import { listTemp, purgeAll, removeTemp } from "./engine/storage";
import type { StorageInfo } from "@shared/messages";

const runners = new Map<string, JobRunner>();
void purgeAll();

chrome.runtime.onMessage.addListener((raw: Msg & { __target?: string }, _sender, sendResponse) => {
  if (raw.__target !== "offscreen") return false;
  switch (raw.type) {
    case "O_PING":
      sendResponse({ ok: true, jobs: [...runners.keys()] });
      return true;
    case "O_START_JOB": {
      const r = new JobRunner(raw.job, raw.settings);
      runners.set(raw.job.id, r);
      sendResponse({ ok: true });
      void r.run().finally(() => {
        // keep the runner until background tells us the save finished (needs the blob URL alive)
      });
      return true;
    }
    case "O_SAVE": {
      const a = document.createElement("a");
      a.href = raw.blobUrl;
      a.download = raw.fileName;
      document.body.append(a);
      a.click();
      a.remove();
      sendResponse({ ok: true });
      return true;
    }
    case "O_SKIP_FAILED":
      void runners.get(raw.jobId)?.skipFailed();
      sendResponse({ ok: true });
      return true;
    case "O_STORAGE":
      void (async () => {
        const est = await navigator.storage.estimate();
        const temp = await listTemp();
        const info: StorageInfo = {
          quota: est.quota ?? 0,
          usage: est.usage ?? 0,
          temp: temp.map((t) => {
            const jobId = t.name.replace(/\.part$/, "");
            return { ...t, jobId, active: runners.has(jobId) };
          }),
          tempBytes: temp.reduce((s, t) => s + t.size, 0),
          pendingBytes: 0,
        };
        sendResponse(info);
      })();
      return true;
    case "O_CLEAN_STORAGE":
      void (async () => {
        let freed = 0;
        for (const t of await listTemp()) {
          const jobId = t.name.replace(/\.part$/, "");
          if (runners.has(jobId) || raw.keep.includes(jobId)) continue;
          await removeTemp(t.name);
          freed += t.size;
        }
        sendResponse({ ok: true, freed });
      })();
      return true;
    case "O_PAUSE_JOB":
      runners.get(raw.jobId)?.pause();
      sendResponse({ ok: true });
      return true;
    case "O_RESUME_JOB":
      void runners.get(raw.jobId)?.resume();
      sendResponse({ ok: true });
      return true;
    case "O_CANCEL_JOB": {
      const r = runners.get(raw.jobId);
      if (r) {
        // After hand-off the only thing left is to free the blob / OPFS file; before that, abort.
        if (r.handedOff) r.release();
        else r.cancel();
        runners.delete(raw.jobId);
      }
      sendResponse({ ok: true });
      return true;
    }
    default:
      return false;
  }
});
