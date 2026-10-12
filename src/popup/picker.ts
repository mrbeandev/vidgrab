import type { HlsRendition, HlsVariant, MediaItem, MediaProbe, Settings } from "@shared/types";
import { el, formatBytes, formatDuration, icons } from "@shared/utils";
import { describeTracks } from "@shared/probe-parsers";
import { equivHeight, qualityClass } from "@shared/m3u8";

export interface PickerChoice {
  variant: HlsVariant;
  audio?: HlsRendition;
}

/** Pick the variant matching the user's preference (undefined → must ask). */
export function preselect(variants: HlsVariant[], pref: Settings["preferredQuality"]): HlsVariant | undefined {
  if (!variants.length) return undefined;
  if (pref === "ask") return undefined;
  if (pref === "best") return variants[0];
  if (pref === "smallest") return [...variants].sort((a, b) => a.bandwidth - b.bandwidth)[0];
  const want = parseInt(pref, 10);
  const eq = (v: HlsVariant) => equivHeight(v.width, v.height);
  const withH = variants.filter((v) => eq(v));
  if (!withH.length) return variants[0];
  // best class not exceeding `want` (8 % tolerance: 1920×800 counts as 1080p), else the smallest above it
  const le = withH.filter((v) => eq(v) <= want * 1.08).sort((a, b) => eq(b) - eq(a) || b.bandwidth - a.bandwidth)[0];
  return le ?? withH.sort((a, b) => eq(a) - eq(b))[0];
}

/**
 * Modal quality picker. Resolves with the choice or null when dismissed.
 * Rendered inside the popup root so it overlays the list.
 */
export function openPicker(opts: {
  item: MediaItem;
  variants: HlsVariant[];
  audioRenditions: HlsRendition[];
  probe?: MediaProbe;
  duration?: number;
  current?: HlsVariant;
  settings: Settings;
  onRemember?: (pref: Settings["preferredQuality"]) => void;
  /** Called synchronously inside the confirm click (user gesture) – used to open the side panel. */
  onConfirmGesture?: () => void;
  /** free bytes available to the extension (navigator.storage.estimate) */
  freeBytes?: number;
}): Promise<PickerChoice | null> {
  return new Promise((resolve) => {
    const { item, variants, audioRenditions, probe, settings } = opts;
    let selected = opts.current ?? preselect(variants, settings.preferredQuality) ?? variants[0];
    let audio = pickAudio(selected, audioRenditions);

    const close = (r: PickerChoice | null) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(r);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(null);
      if (e.key === "Enter") confirm.click();
    };

    const list = el("div", { class: "qlist" });
    const renderList = () => {
      list.replaceChildren(
        ...variants.map((v) => {
          const tr = rowTracks(v, audioRenditions);
          const row = el(
            "button",
            { class: `qrow ${v === selected ? "active" : ""}` },
            el("span", { class: "qcheck", html: v === selected ? icons.check : "" }),
            el(
              "span",
              { class: "qmain" },
              el("span", { class: "qres", text: qualityClass(v.width, v.height) || "Auto" }),
              v.frameRate && v.frameRate > 31 ? el("span", { class: "qfps", text: `${Math.round(v.frameRate)}fps` }) : null,
              el(
                "span",
                { class: "qsub muted" },
                v.width && v.height ? el("span", { class: "qdims", text: `${v.width}×${v.height}` }) : null,
                el("span", { class: "qbits", text: v.bandwidth ? `${(v.bandwidth / 1e6).toFixed(v.bandwidth >= 1e7 ? 0 : 1)} Mbps` : "" }),
              ),
            ),
            el(
              "span",
              { class: "qside" },
              el(
                "span",
                { class: "qline" },
                tr.label ? el("span", { class: `qtrack ${tr.tone}`, text: tr.label.replace(" · no audio", "") }) : null,
                v.estSize ? el("span", { class: "qsize", text: `≈ ${formatBytes(v.estSize)}` }) : null,
              ),
              v.codecs ? el("span", { class: "qcodec faint", text: shortCodecs(v.codecs) }) : null,
            ),
          );
          row.onclick = () => {
            selected = v;
            audio = pickAudio(v, audioRenditions);
            renderList();
            renderAudio();
            renderSpace();
          };
          row.ondblclick = () => confirm.click();
          return row;
        }),
      );
    };

    const spaceWarn = el("div", { class: "qspace" });
    const renderSpace = () => {
      spaceWarn.replaceChildren();
      const need = selected.estSize ? selected.estSize * 2 : 0; // temp file + final copy while saving
      if (!opts.freeBytes || !need) return;
      if (need > opts.freeBytes)
        spaceWarn.append(
          el("div", {
            class: "hint warn",
            html: `${icons.warn}<span>Needs ≈ <b>${formatBytes(need)}</b> of free space while saving, only <b>${formatBytes(opts.freeBytes)}</b> available. Pick a lower quality or free some disk space.</span>`,
          }),
        );
      else spaceWarn.append(el("div", { class: "qfree faint", text: `${formatBytes(opts.freeBytes)} free on disk` }));
    };

    const audioWrap = el("div", { class: "qaudio" });
    const renderAudio = () => {
      audioWrap.replaceChildren();
      if (!audio) return;
      const group = audioRenditions.filter((a) => a.groupId === selected.audioGroup);
      if (group.length > 1) {
        const sel = el("select", { class: "select" }) as HTMLSelectElement;
        for (const a of group) sel.append(el("option", { value: a.url, text: a.name + (a.language ? ` (${a.language})` : ""), selected: a === audio }));
        sel.onchange = () => (audio = group.find((a) => a.url === sel.value));
        audioWrap.append(el("label", { text: "Audio track" }), sel);
      }
      audioWrap.append(el("div", { class: "hint", html: "Audio comes as a <b>separate stream</b> on this site – VidGrab downloads both and merges them into one MP4." }));
    };

    const remember = el("input", { type: "checkbox" }) as HTMLInputElement;
    const confirm = el("button", { class: "btn primary", html: `${icons.download}<span>Download</span>` });
    confirm.onclick = () => {
      opts.onConfirmGesture?.();
      if (remember.checked && opts.onRemember) {
        const cls = qualityClass(selected.width, selected.height);
        const map: Record<string, Settings["preferredQuality"]> = { "4K": "2160", "1440p": "1440", "1080p": "1080", "720p": "720", "480p": "480", "360p": "360" };
        const pref: Settings["preferredQuality"] = selected === variants[0] ? "best" : map[cls] ?? "best";
        opts.onRemember(pref);
      }
      close({ variant: selected, audio });
    };
    const cancel = el("button", { class: "btn", text: "Cancel" });
    cancel.onclick = () => close(null);

    const sep = describeTracks(probe, probe?.audioSeparate);
    const tr = probe?.audioSeparate ? { label: "Video + audio", tone: "ok" as const } : sep;
    const header = el(
      "div",
      { class: "qhead" },
      item.thumbnail ? el("img", { class: "qthumb", src: item.thumbnail, alt: "" }) : el("div", { class: "qthumb ph", html: icons.film }),
      el(
        "div",
        { class: "qinfo" },
        el("div", { class: "qtitle ellipsis", text: item.pageTitle || item.name, title: item.pageTitle }),
        el(
          "div",
          { class: "qmeta muted" },
          el("span", { text: opts.duration ? formatDuration(opts.duration) : "" }),
          tr.label ? el("span", { class: `qtrack ${tr.tone}`, text: tr.label }) : null,
          probe?.encrypted ? el("span", { class: "chip", text: "AES-128" }) : null,
        ),
      ),
      el("button", { class: "icon-btn", html: icons.x, title: "Close", onclick: () => close(null) }),
    );

    const overlay = el(
      "div",
      { class: "qoverlay" },
      el(
        "div",
        { class: "qmodal" },
        header,
        el("div", { class: "qlabel", text: `Choose quality · ${variants.length} available` }),
        list,
        audioWrap,
        spaceWarn,
        el(
          "div",
          { class: "qfoot" },
          el("label", { class: "check" }, remember, el("span", { text: "Remember for next time" })),
          el("div", { class: "spacer" }),
          cancel,
          confirm,
        ),
      ),
    );
    overlay.onclick = (e) => {
      if (e.target === overlay) close(null);
    };
    renderList();
    renderAudio();
    renderSpace();
    document.body.append(overlay);
    document.addEventListener("keydown", onKey);
    (list.querySelector(".qrow.active") as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
  });
}

/**
 * The audio rendition to download alongside a variant.
 * Per RFC 8216 the variant's CODECS lists *every* codec of the presentation, including audio that lives in
 * a separate #EXT-X-MEDIA playlist – so "mp4a" in CODECS does NOT mean the audio is muxed into the video.
 * The reliable signal is: the variant references an AUDIO group whose renditions have their own URI
 * (renditions without URI are muxed and never reach this list).
 */
export function pickAudio(v: HlsVariant | undefined, renditions: HlsRendition[]): HlsRendition | undefined {
  if (!v || !renditions.length || !v.audioGroup) return undefined;
  const inGroup = renditions.filter((a) => a.groupId === v.audioGroup);
  if (!inGroup.length) return undefined;
  return inGroup.find((a) => a.isDefault) ?? inGroup[0];
}

/** Track label for a picker row – accounts for audio delivered as a separate rendition. */
function rowTracks(v: HlsVariant, renditions: HlsRendition[]) {
  if (pickAudio(v, renditions)) return { label: "Video + audio", tone: "ok" as const };
  return describeTracks({ video: !!v.height || v.hasAudio === false, audio: v.hasAudio }, false);
}

const CODEC_NAME: Record<string, string> = { avc1: "H.264", avc3: "H.264", hvc1: "HEVC", hev1: "HEVC", av01: "AV1", vp09: "VP9", vp8: "VP8", mp4a: "AAC", "ec-3": "DD+", "ac-3": "AC3", opus: "Opus", flac: "FLAC" };
const isVideoCodec = (k: string) => /^(avc|hvc|hev|av01|vp0?9|vp8|dvh|mp4v)/.test(k);

/** "mp4a.40.2,avc1.64001f" → "H.264 + AAC" (video first). */
function shortCodecs(c: string): string {
  const keys = c.split(",").map((x) => x.trim().toLowerCase().split(".")[0]).filter(Boolean);
  keys.sort((a, b) => Number(isVideoCodec(b)) - Number(isVideoCodec(a)));
  return [...new Set(keys.map((k) => CODEC_NAME[k] ?? k))].join(" + ");
}
