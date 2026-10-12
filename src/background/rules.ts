import { splitHeaders } from "@shared/headers";

/**
 * declarativeNetRequest session rules that re-attach Referer/Origin/UA/Cookie to requests
 * the extension itself makes (offscreen document, popup preview, service worker).
 *
 * Scope: initiator = this extension (initiatorDomains), tabIds = [-1] (non-tab contexts),
 * requestDomains = the hosts we know belong to this job. Hosts are added as the engine
 * discovers them (playlist host → variant host → segment / key CDN hosts).
 */
interface RuleEntry {
  ruleId: number;
  hosts: Set<string>;
  headers: chrome.declarativeNetRequest.ModifyHeaderInfo[];
}

const entries = new Map<string, RuleEntry>(); // key: "job:<id>" | "item:<id>"
let nextId = 1000;

async function allocId(): Promise<number> {
  if (nextId === 1000) {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    for (const r of existing) nextId = Math.max(nextId, r.id + 1);
  }
  return nextId++;
}

function extensionHost(): string {
  return chrome.runtime.id;
}

async function apply(entry: RuleEntry): Promise<void> {
  if (!entry.headers.length || !entry.hosts.size) return;
  const rule: chrome.declarativeNetRequest.Rule = {
    id: entry.ruleId,
    priority: 10,
    action: { type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType, requestHeaders: entry.headers },
    condition: {
      requestDomains: [...entry.hosts],
      initiatorDomains: [extensionHost()],
      tabIds: [-1],
      resourceTypes: ["xmlhttprequest", "media", "other"] as chrome.declarativeNetRequest.ResourceType[],
    },
  };
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [entry.ruleId], addRules: [rule] });
}

/** Create (or extend) the header rule for `key`, adding `hosts`. */
export async function ensureRule(key: string, headers: Record<string, string>, hosts: string[]): Promise<void> {
  const { ruleHeaders } = splitHeaders(headers);
  let entry = entries.get(key);
  const clean = hosts.map((h) => h.toLowerCase()).filter(Boolean);
  if (!entry) {
    entry = { ruleId: await allocId(), hosts: new Set(clean), headers: ruleHeaders };
    entries.set(key, entry);
    await apply(entry);
    return;
  }
  let changed = false;
  for (const h of clean) if (!entry.hosts.has(h)) (entry.hosts.add(h), (changed = true));
  if (changed) await apply(entry);
}

export async function removeRule(key: string): Promise<void> {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [entry.ruleId] }).catch(() => {});
}

/** Drop rules left over from a previous service-worker life (ids ≥ 1000 are ours). */
export async function cleanupOrphanRules(): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const ids = existing.filter((r) => r.id >= 1000).map((r) => r.id);
  if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids }).catch(() => {});
}
