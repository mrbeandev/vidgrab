import type { HlsRendition, HlsVariant, MediaItem, MediaProbe, Settings } from "@shared/types";
import { SKIPPED_PAGE_HOSTS } from "@shared/types";
import { send, type HlsInspectResult, type Msg } from "@shared/messages";
import { el, formatBytes, formatDuration, hostMatches, hostOf, icons } from "@shared/utils";
import { applyTheme, copyText, toast } from "@shared/ui";
import { describeTracks } from "@shared/probe-parsers";
import { openPicker, pickAudio, preselect } from "./picker";
import { captureThumbnail } from "./thumbs";

interface CardState {
  item: MediaItem;
  card: HTMLElement;
  selected: boolean;
  toolbar: HTMLElement;
  thumb: HTMLElement;
  inspect?: HlsInspectResult;
  probe?: MediaProbe;
  variant?: HlsVariant;
  audio?: HlsRendition;
  hls?: { destroy(): void } | null;
  hiddenByMaster?: boolean;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const main = $("#main");
const footer = $("#footer");
const countChip = $("#count");
const btnDownloadSel = $<HTMLButtonElement>("#btn-download-selected");
const selectAll = $<HTMLInputElement>("#select-all");

let tab: chrome.tabs.Tab;
let settings: Settings;
const cards = new Map<string, CardState>();

// ---------------------------------------------------------------- bootstrap
(async function init() {
  $("#btn-panel").innerHTML = icons.panel;
  $("#btn-clear").innerHTML = icons.trash;
  $("#btn-settings").innerHTML = icons.settings;
  btnDownloadSel.innerHTML = `${icons.download}<span>Download selected</span>`;

  settings = await send<Settings>({ type: "GET_SETTINGS" });
  applyTheme(settings.theme);
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url?.startsWith(chrome.runtime.getURL(""))) {
    // popup opened as a normal tab (dev / screenshots): fall back to the most recent http tab
    const tabs = await chrome.tabs.query({ currentWindow: true });
    tab = tabs.filter((t) => t.url?.startsWith("http")).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0] ?? tab;
  }

  $("#btn-panel").onclick = () => openPanelGesture();
  $("#btn-settings").onclick = () => openPanelGesture("settings");
  $("#btn-clear").onclick = async () => {
    await send({ type: "CLEAR_TAB_MEDIA", tabId: tab.id! });
    await refresh();
  };
  selectAll.onchange = () => {
    for (const c of visibleCards()) setSelected(c, selectAll.checked);
    updateFooter();
  };
  btnDownloadSel.onclick = () => {
    const sel = visibleCards().filter((c) => c.selected);
    if (!sel.length) return;
    // Multi-download: use preferred quality or best; no picker per item (would need N gestures).
    if (settings.autoOpenPanel) openPanelGesture();
    void (async () => {
      for (const c of sel) {
        if (c.item.kind === "hls" && !c.inspect) await inspect(c);
        if (c.item.kind === "hls" && c.inspect?.ok) {
          c.variant = preselect(c.inspect.variants, settings.preferredQuality) ?? c.inspect.variants[0];
          c.audio = pickAudio(c.variant, c.inspect.audioRenditions);
        }
        await startDownload(c);
      }
      window.close();
    })();
  };

  chrome.runtime.onMessage.addListener((m: Msg) => {
    if (m.type === "MEDIA_UPDATED" && m.tabId === tab.id) void refresh();
    if (m.type === "SETTINGS_UPDATED") {
      settings = m.settings;
      applyTheme(settings.theme);
    }
  });

  await refresh();
})();

/** Open the side panel. Works only inside a user gesture → call before any await. */
function openPanelGesture(view?: "settings") {
  if (view) chrome.storage.session.set({ panelView: view }).catch(() => {});
  if (tab?.windowId !== undefined && chrome.sidePanel?.open) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => send({ type: "OPEN_SIDE_PANEL", windowId: tab.windowId }));
  } else {
    void send({ type: "OPEN_SIDE_PANEL" });
  }
}

const visibleCards = () => [...cards.values()].filter((c) => !c.hiddenByMaster);

// ---------------------------------------------------------------- list
async function refresh() {
  const url = tab?.url || "";
  if (!url.startsWith("http")) {
    main.replaceChildren(emptyState("Nothing to grab here", "VidGrab works on regular web pages (http / https)."));
    footer.hidden = true;
    return;
  }
  if (hostMatches(hostOf(url), SKIPPED_PAGE_HOSTS)) {
    main.replaceChildren(
      emptyState(
        "YouTube isn't supported",
        "YouTube serves video as signed, throttled chunks that only its player can assemble – a sniffer can't produce a playable file. Use yt-dlp for YouTube. Every other site with HLS/m3u8 or MP4 works.",
      ),
    );
    footer.hidden = true;
    return;
  }
  const items = await send<MediaItem[]>({ type: "GET_TAB_MEDIA", tabId: tab.id! });

  for (const [id, c] of cards) {
    if (!items.find((i) => i.id === id)) {
      c.hls?.destroy();
      c.card.remove();
      cards.delete(id);
    }
  }
  if (!items.length) {
    main.replaceChildren(
      emptyState(
        "No media detected yet",
        "Play the video on the page – most players only request the stream once playback starts. Then reopen VidGrab.",
      ),
    );
    footer.hidden = true;
    countChip.hidden = true;
    return;
  }
  if (main.querySelector(".empty")) main.replaceChildren();
  for (const item of [...items].reverse()) {
    const existing = cards.get(item.id);
    if (existing) {
      // pick up lazily-filled fields (probe / thumbnail / variants) from the store
      if (item.probe && !existing.probe) applyProbe(existing, item.probe);
      if (item.thumbnail && !existing.item.thumbnail) setThumb(existing, item.thumbnail);
      existing.item = { ...existing.item, ...item };
      continue;
    }
    const state = createCard(item);
    cards.set(item.id, state);
    main.prepend(state.card);
  }
  dedupeVariants();
  footer.hidden = false;
  updateFooter();
}

/** Hide media playlists that are one of the qualities of a master playlist already listed. */
function dedupeVariants() {
  const masters = [...cards.values()].filter((c) => c.inspect?.ok && c.inspect.isMaster);
  const bare = (u: string) => u.split(/[?#]/)[0];
  const variantUrls = new Set(masters.flatMap((m) => m.inspect!.variants.map((v) => bare(v.url))));
  const audioUrls = new Set(masters.flatMap((m) => m.inspect!.audioRenditions.map((a) => bare(a.url))));
  for (const c of cards.values()) {
    const isMaster = c.inspect?.ok && c.inspect.isMaster;
    const hide = c.item.kind === "hls" && !isMaster && (variantUrls.has(bare(c.item.url)) || audioUrls.has(bare(c.item.url)));
    if (hide !== !!c.hiddenByMaster) {
      c.hiddenByMaster = hide;
      c.card.hidden = hide;
      if (hide && c.selected) setSelected(c, false);
    }
  }
  const n = visibleCards().length;
  countChip.hidden = !n;
  countChip.textContent = `${n}`;
}

function emptyState(title: string, body: string): HTMLElement {
  return el("div", { class: "empty" }, el("div", { class: "big", html: icons.film }), el("h3", { text: title }), el("p", { text: body }));
}

function updateFooter() {
  const vis = visibleCards();
  const n = vis.filter((c) => c.selected).length;
  btnDownloadSel.disabled = n === 0;
  btnDownloadSel.querySelector("span")!.textContent = n === 0 ? "Download selected" : n === 1 ? "Download 1 item" : `Download ${n} items`;
  selectAll.checked = n > 0 && n === vis.length;
  selectAll.indeterminate = n > 0 && n < vis.length;
}

function setSelected(c: CardState, v: boolean) {
  c.selected = v;
  c.card.classList.toggle("selected", v);
  (c.card.querySelector(".cb") as HTMLInputElement).checked = v;
}

// ---------------------------------------------------------------- card
function createCard(item: MediaItem): CardState {
  const kindIcon = item.kind === "hls" ? icons.stream : item.kind === "audio" ? icons.music : icons.film;
  const cb = el("input", { type: "checkbox", class: "cb" }) as HTMLInputElement;
  const thumb = el("div", { class: `thumb kind ${item.kind}`, html: kindIcon });
  const title = el("div", { class: "title ellipsis", text: item.name, title: item.name });
  const meta = el(
    "div",
    { class: "meta" },
    el("span", { class: `chip ${item.kind}`, text: item.kind === "hls" ? "HLS" : item.ext.toUpperCase() || item.kind }),
    item.size && item.kind !== "hls" ? el("span", { class: "size", text: formatBytes(item.size) }) : null,
    item.duration ? el("span", { class: "dur", text: formatDuration(item.duration) }) : null,
    el("span", { class: "host ellipsis", text: hostOf(item.url) }),
  );
  const tracks = el("div", { class: "tracks" });
  const btnPlay = el("button", { class: "icon-btn", title: "Preview", html: icons.play });
  const btnCopy = el("button", { class: "icon-btn", title: "Copy URL", html: icons.copy });
  const btnBlock = el("button", { class: "icon-btn danger", title: "Block this host", html: icons.ban });
  const btnMore = el("button", { class: "icon-btn", title: "Details", html: icons.chevron });
  const btnDl = el("button", { class: "btn primary sm", html: `${icons.download}<span>Download</span>` });
  const extra = el("div", { class: "extra" });
  const card = el("div", { class: "card" }, cb, thumb, title, meta, tracks, el("div", { class: "dl" }, btnDl), extra);
  const state: CardState = {
    item,
    card,
    selected: false,
    thumb,
    toolbar: el("div", { class: "actions" }, btnPlay, btnCopy, btnBlock, btnMore),
  };

  cb.onchange = () => {
    setSelected(state, cb.checked);
    updateFooter();
  };
  title.onclick = () => toggleExtra(state);
  thumb.onclick = () => toggleExtra(state);
  btnMore.onclick = () => toggleExtra(state);
  btnCopy.onclick = async () => toast((await copyText(item.url)) ? "URL copied" : "Copy failed");
  btnBlock.onclick = async () => {
    const host = hostOf(item.url);
    if (!confirm(`Hide media from "${host}" from now on?`)) return;
    await send({ type: "SET_SETTINGS", settings: { blockedHosts: [...settings.blockedHosts, host] } });
    toast(`Blocked ${host}`);
  };
  btnPlay.onclick = () => togglePreview(state, extra);
  btnDl.onclick = () => onDownloadClick(state, btnDl);

  if (item.probe) applyProbe(state, item.probe);
  if (item.thumbnail) setThumb(state, item.thumbnail);
  if (item.kind === "hls") void inspect(state).then(() => void probe(state));
  else void probe(state);
  return state;
}

function setThumb(state: CardState, url: string) {
  if (!settings.showThumbnails) return;
  state.item.thumbnail = url;
  state.thumb.classList.add("has-img");
  state.thumb.replaceChildren(el("img", { src: url, alt: "" }));
}

function applyProbe(state: CardState, p: MediaProbe) {
  state.probe = p;
  const tr = p.audioSeparate && p.video ? { label: "Video + audio", tone: "ok" as const } : describeTracks(p, p.audioSeparate);
  const tracks = state.card.querySelector(".tracks") as HTMLElement;
  tracks.replaceChildren();
  if (tr.label) {
    const parts = [tr.label];
    const codecs = [p.videoCodec, p.audioCodec].filter((c): c is string => !!c).map(prettyCodec);
    tracks.append(el("span", { class: `track ${tr.tone}`, text: parts.join("") }));
    if (codecs.length) tracks.append(el("span", { class: "faint codec", text: codecs.join(" + ") }));
    if (p.width && p.height) tracks.append(el("span", { class: "faint", text: `${p.width}×${p.height}` }));
  } else if (p.error) {
    tracks.append(el("span", { class: "faint", text: "Could not inspect" , title: p.error }));
  }
  const meta = state.card.querySelector(".meta")!;
  if (p.duration && !meta.querySelector(".dur")) meta.insertBefore(el("span", { class: "dur", text: formatDuration(p.duration) }), meta.querySelector(".host"));
  if (p.estSize && state.item.kind === "hls" && !meta.querySelector(".size"))
    meta.insertBefore(el("span", { class: "size", text: `≈ ${formatBytes(p.estSize)}` }), meta.querySelector(".host"));
  // keep the row short enough for the host to stay visible
  if (meta.querySelector(".size") && meta.querySelector(".qcount")) meta.querySelector(".qcount")!.remove();
}

async function probe(state: CardState) {
  if (state.probe) return;
  if (state.item.kind === "hls" && state.inspect?.isLive) return;
  const p = await send<MediaProbe>({ type: "PROBE_MEDIA", item: state.item }).catch(() => null);
  if (p) applyProbe(state, p);
  // thumbnail after the probe (so we don't fight for bandwidth)
  if (settings.showThumbnails && !state.item.thumbnail && (p?.video ?? state.item.kind !== "audio")) {
    const url = await captureThumbnail(state.item, state.inspect?.ok ? [...state.inspect.variants].sort((a, b) => a.bandwidth - b.bandwidth)[0]?.url : undefined);
    if (url) setThumb(state, url);
  }
}

function prettyCodec(c: string): string {
  const k = c.toLowerCase().split(".")[0];
  return (
    { avc: "H.264", avc1: "H.264", avc3: "H.264", hevc: "HEVC", hvc1: "HEVC", hev1: "HEVC", av01: "AV1", vp09: "VP9", v_vp9: "VP9", v_vp8: "VP8", mp4a: "AAC", aac: "AAC", "ec-3": "DD+", eac3: "DD+", ac3: "AC3", "ac-3": "AC3", opus: "Opus", a_opus: "Opus", mp3: "MP3" }[k] ?? c
  );
}

function toggleExtra(state: CardState) {
  const open = state.card.classList.toggle("open");
  if (open && !state.card.querySelector(".extra .url")) renderExtra(state);
  const chev = state.toolbar.querySelector('[title="Details"]') as HTMLElement | null;
  if (chev) chev.style.transform = open ? "rotate(180deg)" : "";
}

function renderExtra(state: CardState) {
  const extra = state.card.querySelector(".extra") as HTMLElement;
  const { item } = state;
  const qualityHost = el("div", { class: "quality-wrap" });
  extra.replaceChildren(
    item.kind === "hls" ? qualityHost : "",
    el("div", { class: "url mono", text: item.url }),
    el("div", { class: "toolbar" }, el("span", { class: "faint ellipsis from", text: `From: ${item.pageTitle}`, title: item.pageUrl }), state.toolbar),
  );
  if (item.kind === "hls") renderQuality(state, qualityHost);
}

async function inspect(state: CardState) {
  if (state.inspect) return state.inspect;
  const r = await send<HlsInspectResult>({ type: "INSPECT_HLS", item: state.item });
  state.inspect = r;
  if (r.ok) {
    state.variant = preselect(r.variants, settings.preferredQuality) ?? r.variants[0];
    state.audio = pickAudio(state.variant, r.audioRenditions);
    const meta = state.card.querySelector(".meta")!;
    meta.querySelectorAll("[data-inspect]").forEach((n) => n.remove());
    const add = (node: HTMLElement) => {
      node.dataset.inspect = "1";
      meta.insertBefore(node, meta.querySelector(".host"));
    };
    if (r.isMaster && r.variants.length) add(el("span", { class: "qcount", text: `${r.variants.length} qualities` }));
    if (r.duration && !meta.querySelector(".dur")) add(el("span", { class: "dur", text: formatDuration(r.duration) }));
    if (r.isLive) add(el("span", { class: "tag-live", text: "LIVE" }));
    const qh = state.card.querySelector(".quality-wrap") as HTMLElement | null;
    if (qh) renderQuality(state, qh);
    dedupeVariants();
  }
  return r;
}

/** Compact quality summary inside the expanded card (the real picker is the modal). */
function renderQuality(state: CardState, host: HTMLElement) {
  const r = state.inspect;
  host.replaceChildren();
  if (!r) return void host.append(el("span", { class: "muted", text: "Reading playlist…" }));
  if (!r.ok) return void host.append(el("div", { class: "hint", html: `<b>Could not read playlist:</b> ${escapeHtml(r.error || "")}` }));
  if (r.isMaster && r.variants.length > 1) {
    const group = el("div", { class: "pill-group" });
    for (const v of r.variants) {
      const p = el("button", { class: `pill ${state.variant?.url === v.url ? "active" : ""}`, text: v.label, title: v.estSize ? `≈ ${formatBytes(v.estSize)}` : "" });
      p.onclick = () => {
        state.variant = v;
        state.audio = pickAudio(v, r.audioRenditions);
        group.querySelectorAll(".pill").forEach((x) => x.classList.remove("active"));
        p.classList.add("active");
        const v2 = state.card.querySelector("video.preview") as HTMLVideoElement | null;
        if (state.hls && v2) {
          state.hls.destroy();
          state.hls = null;
          void startPreview(state, v2);
        }
      };
      group.append(p);
    }
    host.append(el("label", { text: "Preview quality" }), group);
  }
  if (r.encrypted) host.append(el("span", { class: "chip", text: "AES-128" }));
  if (r.fmp4) host.append(el("span", { class: "chip", text: "fMP4" }));
  if (r.isLive) host.append(el("div", { class: "hint", html: "<b>Live stream</b> – downloading live streams is not supported yet." }));
}

// ---------------------------------------------------------------- preview
async function togglePreview(state: CardState, extra: HTMLElement) {
  if (!state.card.classList.contains("open")) toggleExtra(state);
  const existing = state.card.querySelector("video.preview") as HTMLVideoElement | null;
  if (existing) {
    state.hls?.destroy();
    state.hls = null;
    existing.pause();
    existing.removeAttribute("src");
    existing.remove();
    return;
  }
  const video = el("video", { class: "preview", controls: true, autoplay: true, playsInline: true }) as HTMLVideoElement;
  video.volume = 0.5;
  extra.prepend(video);
  await startPreview(state, video);
}

async function startPreview(state: CardState, video: HTMLVideoElement) {
  const { item } = state;
  await send({ type: "ENSURE_HEADER_RULE", item });
  if (item.kind !== "hls") {
    video.src = item.url;
    return;
  }
  const { default: Hls } = await import("hls.js");
  if (!Hls.isSupported()) return void toast("HLS preview not supported in this browser", { error: true });
  const hls = new Hls({
    enableWorker: true,
    xhrSetup: (xhr) => {
      xhr.withCredentials = true;
      for (const [k, v] of Object.entries(item.headers)) {
        if (["referer", "origin", "cookie", "user-agent"].includes(k)) continue;
        try {
          xhr.setRequestHeader(k, v);
        } catch {
          /* forbidden header */
        }
      }
    },
  });
  hls.on(Hls.Events.ERROR, (_e, data) => {
    if (data.fatal) {
      toast(`Preview error: ${data.details}`, { error: true });
      hls.destroy();
      state.hls = null;
    }
  });
  hls.loadSource(state.variant?.url || item.url);
  hls.attachMedia(video);
  state.hls = hls;
}

// ---------------------------------------------------------------- download
async function onDownloadClick(state: CardState, btn: HTMLElement) {
  const { item } = state;
  const needsPicker = item.kind === "hls" && (!state.inspect || (state.inspect.ok && state.inspect.isMaster && state.inspect.variants.length > 1));
  if (!needsPicker) {
    if (settings.autoOpenPanel) openPanelGesture();
    btn.setAttribute("disabled", "");
    await startDownload(state);
    window.close();
    return;
  }
  // HLS with several qualities → modal picker (unless a preferred quality is set)
  if (!state.inspect) {
    btn.setAttribute("disabled", "");
    await inspect(state);
    btn.removeAttribute("disabled");
  }
  const r = state.inspect!;
  if (!r.ok) return void toast(`Cannot read playlist: ${r.error}`, { error: true });
  if (r.isLive) return void toast("Live streams are not supported yet", { error: true });
  if (!(r.isMaster && r.variants.length > 1)) {
    // single quality after all
    if (settings.autoOpenPanel) openPanelGesture();
    await startDownload(state);
    window.close();
    return;
  }
  const pre = preselect(r.variants, settings.preferredQuality);
  if (pre && settings.preferredQuality !== "ask") {
    state.variant = pre;
    state.audio = pickAudio(pre, r.audioRenditions);
    if (settings.autoOpenPanel) openPanelGesture();
    toast(`Using preferred quality: ${pre.label}`);
    await startDownload(state);
    window.close();
    return;
  }
  const est = await navigator.storage.estimate().catch(() => undefined);
  const freeBytes = est?.quota !== undefined ? Math.max(0, est.quota - (est.usage ?? 0)) : undefined;
  const choice = await openPicker({
    freeBytes,
    item,
    variants: r.variants,
    audioRenditions: r.audioRenditions,
    probe: state.probe,
    duration: r.duration ?? state.probe?.duration,
    current: state.variant,
    settings,
    onRemember: (pref) => void send({ type: "SET_SETTINGS", settings: { preferredQuality: pref } }),
    onConfirmGesture: () => settings.autoOpenPanel && openPanelGesture(),
  });
  if (!choice) return;
  state.variant = choice.variant;
  state.audio = choice.audio;
  btn.setAttribute("disabled", "");
  await startDownload(state);
  window.close();
}

async function startDownload(state: CardState) {
  const { item } = state;
  if (item.kind === "hls" && !state.inspect) await inspect(state);
  if (item.kind === "hls" && state.inspect?.isLive) return void toast("Live streams are not supported yet", { error: true });
  try {
    // a separate audio rendition is downloaded by the same job and muxed into one MP4
    await send({ type: "START_DOWNLOAD", item, variant: state.variant, audioRendition: state.audio });
    toast(state.audio ? "Download started (video + audio)" : "Download started");
  } catch (e) {
    toast(`Failed to start: ${(e as Error).message}`, { error: true });
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
