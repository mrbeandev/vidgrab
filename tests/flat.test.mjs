import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, openSync, writeSync, closeSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
mkdirSync(fileURLToPath(new URL("../.smoke-out/", import.meta.url)), { recursive: true });
import { FlatMp4Writer } from "../src/offscreen/engine/flatmp4.ts";

class FileSink {
  constructor(path) { this.fd = openSync(path, "w"); this.bytes = 0; }
  async write(d) { writeSync(this.fd, d, 0, d.byteLength, this.bytes); this.bytes += d.byteLength; }
  async writeAt(pos, d) { writeSync(this.fd, d, 0, d.byteLength, pos); }
  close() { closeSync(this.fd); }
}

/** split a fragmented file into [init, ...fragments] the way HLS would deliver them */
function splitFragmented(buf) {
  const parts = []; let o = 0, initEnd = 0, cur = null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (o + 8 <= buf.length) {
    let sz = dv.getUint32(o); const t = String.fromCharCode(...buf.subarray(o + 4, o + 8));
    if (sz === 1) sz = Number(dv.getBigUint64(o + 8));
    if (t === "moof") { cur = o; } else if (t === "mdat" && cur !== null) { parts.push(buf.subarray(cur, o + sz)); cur = null; } else if (t === "moov") initEnd = o + sz;
    o += sz;
  }
  return [buf.subarray(0, initEnd), parts];
}

const probe = (f) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,nb_frames,duration", "-of", "json", f]).toString());

async function flatten(src, dst) {
  const [init, frags] = splitFragmented(new Uint8Array(readFileSync(src)));
  const sink = new FileSink(dst); const w = new FlatMp4Writer(sink);
  w.addInit(init); for (const f of frags) await w.addFragment(f); await w.finalize(); sink.close();
  return frags.length;
}

test("fixture fMP4 (ffmpeg-generated) → flat MP4 keeps every frame", async () => {
  // build a fragmented version of src.mp4 with separate per-track fragments
  const src = fileURLToPath(new URL("./fixtures/src.mp4", import.meta.url));
  const frag = fileURLToPath(new URL("../.smoke-out/fix_frag.mp4", import.meta.url));
  const flat = fileURLToPath(new URL("../.smoke-out/fix_flat.mp4", import.meta.url));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", src, "-c", "copy", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "1000000", frag]);
  const n = await flatten(frag, flat);
  assert.ok(n > 2);
  const a = probe(src), b = probe(flat);
  const vf = (p) => Number(p.streams.find((s) => s.codec_type === "video").nb_frames);
  assert.equal(vf(b), vf(a), "video frame count");
  assert.ok(Math.abs(Number(b.format.duration) - Number(a.format.duration)) < 0.1, "duration");
  // decode without errors
  const err = execFileSync("ffmpeg", ["-v", "error", "-i", flat, "-f", "null", "-"], { stdio: ["ignore", "pipe", "pipe"] }).toString();
  assert.equal(err.trim(), "");
});

// Optional: point VG_FRAGMENTED_MP4 at any large fragmented MP4 to stress-test the writer.
const user = process.env.VG_FRAGMENTED_MP4;
test("external fragmented MP4 → flat MP4", { skip: !user || !existsSync(user) }, async () => {
  const flat = fileURLToPath(new URL("../.smoke-out/external_flat.mp4", import.meta.url));
  const n = await flatten(user, flat);
  const p = probe(flat);
  console.log("fragments:", n, "→", JSON.stringify(p.streams), p.format.duration);
  assert.equal(p.streams.length, 2);
});
