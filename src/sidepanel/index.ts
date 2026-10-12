import type { DownloadJob, Settings } from "@shared/types";
import { send, type Msg, type StorageInfo } from "@shared/messages";
import { el, formatBytes, formatDuration, formatSpeed, hostOf, icons } from "@shared/utils";
import { applyTheme, copyText, toast } from "@shared/ui";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const jobsHost = $("#jobs");
const summary = $("#summary");
const activeCount = $("#active-count");
let settings: Settings;
let jobs: DownloadJob[] = [];
const cards = new Map<string, HTMLElement>();
/** jobId → last time bytesDone changed (for the "stalled" hint) */
const lastMove = new Map<string, { b: number; t: number }>();
let menuFor: string | null = null;

const STATUS_LABEL: Record<DownloadJob["status"], string> = {
  queued: "Queued",
  preparing: "Preparing…",
  downloading: "Downloading",
  paused: "Paused",
  muxing: "Muxing…",
  saving: "Saving to disk…",
  done: "Completed",
  error: "Failed",
  cancelled: "Cancelled",
};
const ACTIVE = new Set<DownloadJob["status"]>(["queued", "preparing", "downloading", "muxing", "saving", "paused"]);

(async function init() {
  $("#btn-clear-done").innerHTML = icons.trash;
  settings = await send<Settings>({ type: "GET_SETTINGS" });
  applyTheme(settings.theme);
  renderSettings();

  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) => (b.onclick = () => showView(b.dataset.view!)));
  const { panelView } = await chrome.storage.session.get("panelView");
  if (panelView === "settings") {
    showView("settings");
    chrome.storage.session.remove("panelView").catch(() => {});
  }

  $("#btn-clear-done").onclick = async () => {
    for (const j of jobs) if (!ACTIVE.has(j.status)) await send({ type: "REMOVE_JOB", jobId: j.id });
  };

  chrome.runtime.onMessage.addListener((m: Msg) => {
    if (m.type === "JOBS_UPDATED") render(m.jobs);
    if (m.type === "SETTINGS_UPDATED") {
      settings = m.settings;
      applyTheme(settings.theme);
      renderSettings();
    }
  });
  render(await send<DownloadJob[]>({ type: "GET_JOBS" }));
  // light polling as a safety net if a broadcast was missed
  setInterval(async () => render(await send<DownloadJob[]>({ type: "GET_JOBS" })), 2000);
  void refreshStorage();
  setInterval(() => void refreshStorage(), 5000);
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".menu, [data-menu]")) closeMenu();
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());
})();

function showView(v: string) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", (t as HTMLElement).dataset.view === v));
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("active", s.id === `view-${v}`));
}

// ---------------------------------------------------------------- jobs
function render(list: DownloadJob[]) {
  jobs = list;
  const active = list.filter((j) => ACTIVE.has(j.status));
  activeCount.hidden = !active.length;
  activeCount.textContent = String(active.length);
  if (active.length) {
    const speed = active.reduce((s, j) => s + (j.speedBps || 0), 0);
    summary.hidden = false;
    summary.replaceChildren(
      el("span", { html: `<b>${active.length}</b> active` }),
      el("span", { html: `<b>${formatSpeed(speed)}</b>` }),
      el("span", { html: `<b>${list.filter((j) => j.status === "done").length}</b> done` }),
    );
  } else summary.hidden = true;

  for (const [id, c] of cards) if (!list.find((j) => j.id === id)) (c.remove(), cards.delete(id));
  if (!list.length) {
    jobsHost.replaceChildren(
      el(
        "div",
        { class: "empty" },
        el("div", { class: "big", html: icons.download }),
        el("h3", { text: "No downloads yet" }),
        el("p", { text: "Open VidGrab on a page with a video, pick a quality and press Download. Progress shows up here." }),
      ),
    );
    return;
  }
  jobsHost.querySelector(".empty")?.remove();
  let prev: HTMLElement | null = null;
  for (const job of list) {
    let card = cards.get(job.id);
    if (!card) {
      card = el("div", { class: "job" });
      cards.set(job.id, card);
    }
    updateCard(card, job);
    // keep DOM order == list order
    if (prev) prev.after(card);
    else jobsHost.prepend(card);
    prev = card;
  }
}

function displayName(j: DownloadJob): string {
  if (/\.[a-z0-9]{2,5}$/i.test(j.fileName)) return j.fileName;
  const ext = j.container || (j.item.kind === "hls" ? "mp4" : j.item.ext || "");
  return ext ? `${j.fileName}.${ext}` : j.fileName;
}

function updateCard(card: HTMLElement, j: DownloadJob) {
  card.dataset.status = j.status;
  const isHls = j.item.kind === "hls";
  const pct = j.bytesTotal
    ? Math.min(100, (j.bytesDone / j.bytesTotal) * 100)
    : j.totalSegments
      ? (j.doneSegments / j.totalSegments) * 100
      : 0;
  const indeterminate = ["preparing", "queued", "muxing"].includes(j.status) || (j.status === "downloading" && !pct);

  // stalled = downloading but no byte progress for 20 s
  const mv = lastMove.get(j.id);
  if (!mv || mv.b !== j.bytesDone) lastMove.set(j.id, { b: j.bytesDone, t: Date.now() });
  const stalled = j.status === "downloading" && !!mv && mv.b === j.bytesDone && Date.now() - mv.t > 20_000;
  card.classList.toggle("stalled", stalled);

  const stats: string[] = [`<b>${stalled ? "Stalled – retrying" : STATUS_LABEL[j.status]}</b>`];
  if (j.status === "downloading" || j.status === "paused") {
    if (isHls && j.totalSegments) stats.push(`${j.doneSegments}/${j.totalSegments} segments`);
    const total = j.bytesTotal || j.estTotal;
    stats.push(`${formatBytes(j.bytesDone)}${total ? ` / ${j.bytesTotal ? "" : "≈ "}${formatBytes(total)}` : ""}`);
    if (j.status === "downloading") {
      stats.push(formatSpeed(j.speedBps));
      if (j.etaSec) stats.push(`ETA ${formatDuration(j.etaSec)}`);
    }
    if (j.failedSegments) stats.push(`<span style="color:var(--warn)">${j.failedSegments} failed</span>`);
  } else if (j.status === "done") {
    stats.push(formatBytes(j.bytesTotal || j.bytesDone));
    if (j.startedAt && j.finishedAt) stats.push(formatDuration((j.finishedAt - j.startedAt) / 1000));
    if (j.failedSegments) stats.push(`<span style="color:var(--warn)">${j.failedSegments} segments skipped</span>`);
  } else if (j.status === "saving") {
    stats.push(formatBytes(j.bytesTotal || j.bytesDone));
  }
  if (j.variant?.label && j.variant.label !== "Default")
    stats.push(j.variant.width && j.variant.height ? `${j.variant.label.split(" • ")[0]} (${j.variant.width}×${j.variant.height})` : j.variant.label);

  const actions: HTMLElement[] = [];
  const act = (icon: string, title: string, fn: () => void, cls = "") => {
    const b = el("button", { class: `icon-btn ${cls}`, title, html: icon });
    b.onclick = fn;
    return b;
  };
  if (j.status === "downloading") actions.push(act(icons.pause, "Pause", () => send({ type: "PAUSE_JOB", jobId: j.id })));
  if (j.status === "paused") actions.push(act(icons.play, "Resume", () => send({ type: "RESUME_JOB", jobId: j.id })));
  if (ACTIVE.has(j.status) && j.status !== "saving")
    actions.push(act(icons.x, "Cancel", () => send({ type: "CANCEL_JOB", jobId: j.id }), "danger"));
  if (j.status === "error" || j.status === "cancelled")
    actions.push(act(icons.retry, "Retry", () => send({ type: "RETRY_JOB", jobId: j.id })));
  if (j.status === "done" && j.chromeDownloadId !== undefined)
    actions.push(act(icons.folder, "Show in folder", () => send({ type: "SHOW_IN_FOLDER", jobId: j.id })));
  const more = act(icons.more, "More", () => toggleMenu(j, more));
  more.dataset.menu = j.id;
  actions.push(more);

  const parts: Node[] = [
    el(
      "div",
      { class: "top" },
      el("span", { class: "status-dot" }),
      el("div", { class: "name ellipsis", text: displayName(j), title: displayName(j) }),
      el("span", { class: `chip ${j.item.kind}`, text: isHls ? "HLS" : j.item.ext.toUpperCase() || j.item.kind }),
      el("div", { class: "actions" }, ...actions),
    ),
    el("div", { class: `progress ${indeterminate ? "indeterminate" : ""}` }, el("i", { style: `width:${pct.toFixed(1)}%` })),
    el("div", { class: "stats", html: stats.map((x) => `<span>${x}</span>`).join("") }),
  ];
  if (j.error) {
    const errRow = el("div", { class: "err" }, el("span", { text: j.error }));
    if (j.status === "paused" && /keeps failing/.test(j.error)) {
      const skip = el("button", { class: "btn sm", html: `${icons.skip}<span>Skip & continue</span>` });
      skip.onclick = () => send({ type: "SKIP_FAILED", jobId: j.id });
      const resume = el("button", { class: "btn sm primary", html: `${icons.retry}<span>Retry</span>` });
      resume.onclick = () => send({ type: "RESUME_JOB", jobId: j.id });
      errRow.append(el("div", { class: "err-actions" }, resume, skip));
    }
    parts.push(errRow);
  }
  parts.push(el("div", { class: "host ellipsis", text: `${hostOf(j.item.url)} ← ${j.item.pageTitle}` }));
  card.replaceChildren(...parts);
  if (menuFor === j.id) positionMenu(more);
}

// ---------------------------------------------------------------- "⋯" menu (single global popover)
let menuEl: HTMLElement | null = null;
function closeMenu() {
  menuEl?.remove();
  menuEl = null;
  menuFor = null;
}
function positionMenu(anchor: HTMLElement) {
  if (!menuEl) return;
  const r = anchor.getBoundingClientRect();
  const mw = menuEl.offsetWidth || 220;
  menuEl.style.top = `${Math.min(window.innerHeight - menuEl.offsetHeight - 8, r.bottom + 4) + window.scrollY}px`;
  menuEl.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw))}px`;
}
function toggleMenu(j: DownloadJob, anchor: HTMLElement) {
  if (menuFor === j.id) return closeMenu();
  closeMenu();
  const mediaUrl = j.variant?.url || j.item.url;
  const item = (icon: string, label: string, fn: () => unknown, cls = "") => {
    const b = el("button", { class: `menu-item ${cls}`, html: `${icon}<span>${label}</span>` });
    b.onclick = async () => {
      closeMenu();
      await fn();
    };
    return b;
  };
  const items: HTMLElement[] = [
    item(icons.link, "Copy stream link", async () => toast((await copyText(mediaUrl)) ? "Stream link copied" : "Copy failed")),
    item(icons.copy, "Copy page link", async () => toast((await copyText(j.item.pageUrl)) ? "Page link copied" : "Copy failed")),
    item(icons.external, "Open source page", () => send({ type: "OPEN_URL", url: j.item.pageUrl })),
  ];
  items.push(el("div", { class: "menu-sep" }));
  if (j.status === "paused" && j.error && /keeps failing/.test(j.error))
    items.push(item(icons.skip, "Skip failing segments", () => send({ type: "SKIP_FAILED", jobId: j.id })));
  if (j.status !== "saving")
    items.push(
      item(icons.retry, "Restart from beginning", async () => {
        if (ACTIVE.has(j.status) && !confirm("Discard the progress of this download and start again?")) return;
        await send({ type: "RESTART_JOB", jobId: j.id });
        toast("Restarted");
      }),
    );
  if (!ACTIVE.has(j.status)) items.push(item(icons.trash, "Remove from list", () => send({ type: "REMOVE_JOB", jobId: j.id }), "danger"));
  else if (j.status !== "saving") items.push(item(icons.x, "Cancel download", () => send({ type: "CANCEL_JOB", jobId: j.id }), "danger"));
  menuEl = el("div", { class: "menu" }, ...items);
  document.body.append(menuEl);
  menuFor = j.id;
  positionMenu(anchor);
}

// ---------------------------------------------------------------- storage card
async function refreshStorage() {
  const host = $("#storage");
  let s: StorageInfo;
  try {
    s = await send<StorageInfo>({ type: "GET_STORAGE" });
    if (!s || typeof s.quota !== "number") return;
  } catch {
    return;
  }
  const free = Math.max(0, s.quota - s.usage);
  const orphan = s.temp.filter((t) => !t.active);
  const orphanBytes = orphan.reduce((n, t) => n + t.size, 0);
  // While saving, Chrome copies the finished temp file into Downloads → peak ≈ 2× on the same disk.
  const needed = s.pendingBytes;
  const tight = needed > 0 && needed * 2 > free;
  const pct = (n: number) => (s.quota ? Math.max(0, Math.min(100, (n / s.quota) * 100)) : 0);
  const otherUse = Math.max(0, s.usage - s.tempBytes);

  const bar = el(
    "div",
    { class: "sbar" },
    el("i", { class: "seg other", style: `width:${pct(otherUse)}%`, title: `Other data: ${formatBytes(otherUse)}` }),
    el("i", { class: "seg temp", style: `width:${pct(s.tempBytes)}%`, title: `Download temp files: ${formatBytes(s.tempBytes)}` }),
    el("i", { class: "seg pending", style: `width:${pct(needed)}%`, title: `Still to download: ≈ ${formatBytes(needed)}` }),
  );
  const lines: Node[] = [
    el(
      "div",
      { class: "srow" },
      el("span", { class: "sicon", html: icons.disk }),
      el("span", { class: "stitle", text: "Storage" }),
      el("span", { class: "spacer" }),
      el("span", { class: "sfree", html: `<b>${formatBytes(free)}</b> free` }),
    ),
    bar,
    el(
      "div",
      { class: "slegend" },
      el("span", { html: `<i class="dot temp"></i>In progress ${formatBytes(s.tempBytes)}` }),
      needed ? el("span", { html: `<i class="dot pending"></i>Still to download ≈ ${formatBytes(needed)}` }) : "",
      el("span", { class: "faint", text: `Limit ${formatBytes(s.quota)}` }),
    ),
  ];
  if (tight)
    lines.push(
      el("div", {
        class: "swarn",
        html: `${icons.warn}<span>Low space: active downloads need ≈ <b>${formatBytes(needed * 2)}</b> while saving (temp file + final copy), only ${formatBytes(free)} free.</span>`,
      }),
    );
  if (orphanBytes > 0) {
    const btn = el("button", { class: "btn sm", text: `Free ${formatBytes(orphanBytes)}` });
    btn.onclick = async () => {
      const r = await send<{ freed: number }>({ type: "CLEAN_STORAGE" });
      toast(`Freed ${formatBytes(r?.freed ?? 0)}`);
      void refreshStorage();
    };
    lines.push(el("div", { class: "sclean" }, el("span", { class: "muted", text: `${orphan.length} leftover temp file${orphan.length > 1 ? "s" : ""}` }), btn));
  }
  host.replaceChildren(...lines);
  host.classList.toggle("warn", tight);
}

// ---------------------------------------------------------------- settings
function renderSettings() {
  const host = $("#view-settings");
  const save = async (patch: Partial<Settings>) => {
    settings = await send<Settings>({ type: "SET_SETTINGS", settings: patch });
    toast("Saved");
  };
  const row = (label: string, hint: string, control: HTMLElement) =>
    el("div", { class: "setting" }, el("div", { class: "lbl" }, el("div", { text: label }), el("small", { text: hint })), control);
  const toggle = (key: keyof Settings) => {
    const input = el("input", { type: "checkbox" }) as HTMLInputElement;
    input.checked = !!settings[key];
    input.onchange = () => save({ [key]: input.checked } as Partial<Settings>);
    return el("label", { class: "switch" }, input, el("i"));
  };
  const number = (key: keyof Settings, min: number, max: number) => {
    const input = el("input", { type: "number", class: "input", min, max, value: String(settings[key]) }) as HTMLInputElement;
    input.onchange = () => save({ [key]: Math.max(min, Math.min(max, Number(input.value) || min)) } as Partial<Settings>);
    return input;
  };
  const select = (key: keyof Settings, opts: [string, string][]) => {
    const s = el("select", { class: "select" }) as HTMLSelectElement;
    for (const [v, l] of opts) s.append(el("option", { value: v, text: l, selected: settings[key] === v }));
    s.onchange = () => save({ [key]: s.value } as Partial<Settings>);
    return s;
  };

  const hosts = el("div", { class: "hosts" });
  const renderHosts = () => {
    hosts.replaceChildren(
      ...(settings.blockedHosts.length
        ? settings.blockedHosts.map((h) => {
            const b = el("button", { html: icons.x, title: "Unblock" });
            b.onclick = () => save({ blockedHosts: settings.blockedHosts.filter((x) => x !== h) }).then(renderHosts);
            return el("span", { class: "host-chip" }, h, b);
          })
        : [el("span", { class: "faint", text: "No blocked hosts. Use the ⊘ button on a detected item to hide noisy CDNs." })]),
    );
  };
  renderHosts();
  const addHost = el("input", { class: "input", placeholder: "ads.example.com", style: "flex:1" }) as HTMLInputElement;
  const addBtn = el("button", { class: "btn sm", text: "Block" });
  addBtn.onclick = () => {
    const h = addHost.value.trim().toLowerCase();
    if (!h) return;
    save({ blockedHosts: [...settings.blockedHosts, h] }).then(renderHosts);
    addHost.value = "";
  };

  host.replaceChildren(
    el(
      "div",
      { class: "settings" },
      el(
        "div",
        { class: "group" },
        el("h4", { text: "Downloading" }),
        row("Parallel connections", "Segments fetched at once for HLS (1–16). Higher = faster, but some CDNs throttle.", number("threads", 1, 16)),
        row("Retries per segment", "How many times a failed segment is retried before being skipped.", number("maxRetries", 0, 10)),
        row("Remux TS → MP4", "Convert MPEG-TS segments to a fragmented MP4 while downloading (recommended). Off saves raw .ts.", toggle("remuxTs")),
        row("Open panel on download", "Automatically open this side panel when you start a download from the popup.", toggle("autoOpenPanel")),
        row("Ask where to save", "Show the system Save dialog for each file instead of using the default Downloads folder.", toggle("saveAsDialog")),
        row("File name from", "Use the web page title or the resource's own file name.", select("filenameFrom", [["title", "Page title"], ["resource", "Resource name"]])),
        row(
          "Preferred quality",
          "\"Ask\" shows a picker when a stream has several qualities. Otherwise the closest match is used automatically.",
          select("preferredQuality", [
            ["ask", "Always ask"],
            ["best", "Best available"],
            ["2160", "Up to 2160p"],
            ["1440", "Up to 1440p"],
            ["1080", "Up to 1080p"],
            ["720", "Up to 720p"],
            ["480", "Up to 480p"],
            ["360", "Up to 360p"],
            ["smallest", "Smallest file"],
          ]),
        ),
      ),
      el(
        "div",
        { class: "group" },
        el("h4", { text: "Detection" }),
        row("Thumbnails & track info", "Grab a frame and inspect the first segment to show video/audio details. Costs a little bandwidth per item.", toggle("showThumbnails")),
        row("Minimum size (KB)", "Direct files smaller than this are ignored (filters out ads & thumbnails). HLS is always listed.", number("minSizeKB", 0, 1_000_000)),
        el("div", { class: "setting", style: "flex-direction:column;align-items:stretch;gap:6px" },
          el("div", { class: "lbl" }, el("div", { text: "Blocked hosts" }), el("small", { text: "Media from these hosts is never listed." })),
          hosts,
          el("div", { style: "display:flex;gap:6px" }, addHost, addBtn),
        ),
      ),
      el(
        "div",
        { class: "group" },
        el("h4", { text: "Appearance" }),
        row("Theme", "", select("theme", [["dark", "Dark"], ["light", "Light"], ["system", "System"]])),
      ),
      el(
        "div",
        { class: "group" },
        el("h4", { text: "About" }),
        el("p", { class: "about", html:
          `VidGrab ${chrome.runtime.getManifest().version} — everything runs inside your browser. ` +
          `No external servers, no analytics, no ads. Files are assembled on disk (<code>OPFS</code>) and handed to Chrome's download manager.` }),
      ),
    ),
  );
}
