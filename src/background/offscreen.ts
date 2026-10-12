import type { Msg } from "@shared/messages";

const OFFSCREEN_URL = "offscreen.html";
let creating: Promise<void> | null = null;

async function exists(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

export async function ensureOffscreen(): Promise<void> {
  if (await exists()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.WORKERS],
        justification: "Downloads media segments, decrypts/remuxes them and prepares the file for saving.",
      })
      .catch((e: unknown) => {
        // "Only a single offscreen document may be created" → race, fine.
        if (!String(e).includes("single offscreen")) throw e;
      })
      .finally(() => (creating = null));
  }
  await creating;
}

/** Send a message to the offscreen document (creating it if needed). */
export async function toOffscreen<R = unknown>(msg: Msg): Promise<R> {
  await ensureOffscreen();
  return new Promise<R>((resolve, reject) => {
    chrome.runtime.sendMessage({ ...msg, __target: "offscreen" }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(res as R);
    });
  });
}
