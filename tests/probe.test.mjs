import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { probeBytes, tracksFromCodecs, describeTracks } from "../src/shared/probe-parsers.ts";

const fx = (n, head = 512 * 1024) => new Uint8Array(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)).subarray(0, head));

test("MP4 video+audio (moov at end → needs whole file)", () => {
  const t = probeBytes(fx("src.mp4", 1 << 20));
  assert.equal(t.container, "mp4");
  assert.equal(t.video, true); assert.equal(t.audio, true);
  assert.equal(t.videoCodec, "avc1"); assert.equal(t.audioCodec, "mp4a");
  assert.deepEqual([t.width, t.height], [160, 90]);
  assert.ok(Math.abs(t.duration - 6) < 0.2, `duration ${t.duration}`);
});
test("MP4 faststart video-only (moov at head)", () => {
  const t = probeBytes(fx("src_videoonly.mp4", 4096));
  assert.equal(t.video, true); assert.equal(t.audio, false);
  assert.equal(describeTracks(t).label, "Video only · no audio");
});
test("M4A audio-only", () => {
  const t = probeBytes(fx("src_audioonly.m4a", 1 << 20));
  assert.equal(t.video, false); assert.equal(t.audio, true); assert.equal(t.audioCodec, "mp4a");
  assert.equal(describeTracks(t).label, "Audio only");
});
test("fMP4 init segment", () => {
  const t = probeBytes(fx("fmp4_init.mp4"));
  assert.equal(t.video, true); assert.equal(t.audio, true);
});
test("MPEG-TS video+audio and video-only", () => {
  const t = probeBytes(fx("src.ts", 64 * 1024));
  assert.equal(t.container, "ts"); assert.equal(t.video, true); assert.equal(t.audio, true);
  assert.equal(t.videoCodec, "avc"); assert.equal(t.audioCodec, "aac");
  const v = probeBytes(fx("src_videoonly.ts", 64 * 1024));
  assert.equal(v.video, true); assert.equal(v.audio, false);
});
test("WebM vp9+opus", () => {
  const t = probeBytes(fx("src.webm", 64 * 1024));
  assert.equal(t.container, "webm"); assert.equal(t.video, true); assert.equal(t.audio, true);
  assert.match(t.videoCodec, /VP9/); assert.match(t.audioCodec, /OPUS/);
  assert.deepEqual([t.width, t.height], [160, 90]);
});
test("raw ADTS AAC", () => {
  const t = probeBytes(fx("src.aac", 4096));
  assert.equal(t.audio, true); assert.equal(t.video, false);
});
test("HLS CODECS attribute", () => {
  assert.deepEqual(tracksFromCodecs("avc1.64001f,mp4a.40.2"), { video: true, audio: true, videoCodec: "avc1", audioCodec: "mp4a" });
  assert.equal(tracksFromCodecs("avc1.64001f").audio, false);
  assert.equal(tracksFromCodecs("mp4a.40.2").video, false);
  assert.equal(describeTracks(tracksFromCodecs("avc1.4d401f"), true).label, "Video + separate audio");
});
