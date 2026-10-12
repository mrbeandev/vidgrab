/**
 * Which captured request headers we keep for replay. Everything else (range, accept-*,
 * content-*, sec-*, cache-control, connection, host, …) is either browser-managed, request-specific,
 * or would corrupt a replayed fetch.
 */
const KEEP = new Set([
  "referer",
  "origin",
  "user-agent",
  "authorization",
  "cookie",
  "x-requested-with",
  "x-csrf-token",
  "x-xsrf-token",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-client-id",
  "x-session-id",
  "x-playback-session-id",
  "x-forwarded-for",
]);

export function sanitizeHeaders(list: chrome.webRequest.HttpHeader[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!list) return out;
  for (const h of list) {
    const name = h.name.toLowerCase();
    const value = h.value ?? "";
    if (!value) continue;
    if (KEEP.has(name) || (name.startsWith("x-") && value.length < 512)) out[name] = value;
  }
  return out;
}

/**
 * Headers that `fetch()` is forbidden to set and must instead be applied by a
 * declarativeNetRequest session rule (referer / origin / cookie / user-agent).
 */
export const DNR_ONLY = new Set(["referer", "origin", "cookie", "user-agent"]);

/** Split captured headers into the part fetch() may set and the part that needs a DNR rule. */
export function splitHeaders(h: Record<string, string>): {
  fetchHeaders: Record<string, string>;
  ruleHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[];
} {
  const fetchHeaders: Record<string, string> = {};
  const ruleHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [];
  for (const [k, v] of Object.entries(h)) {
    if (DNR_ONLY.has(k)) {
      // Cookie is supplied live by the browser (credentials:"include"); only set it if the
      // captured value exists – DNR "set" replaces whatever the browser would send.
      // string literal: this module also runs in the offscreen doc where chrome.declarativeNetRequest is undefined
      ruleHeaders.push({ header: k, operation: "set" as chrome.declarativeNetRequest.HeaderOperation, value: v });
    } else {
      fetchHeaders[k] = v;
    }
  }
  return { fetchHeaders, ruleHeaders };
}
