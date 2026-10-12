import test from "node:test";
import assert from "node:assert/strict";
import { parsePlaylist, ivFromSequence, parseAttrs } from "../src/shared/m3u8.ts";

const BASE = "https://cdn.example.com/v/main.m3u8";

test("parseAttrs handles quoted commas", () => {
  const a = parseAttrs('BANDWIDTH=1280000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720');
  assert.equal(a.CODECS, "avc1.4d401f,mp4a.40.2");
  assert.equal(a.RESOLUTION, "1280x720");
});

test("master playlist → sorted variants + audio renditions", () => {
  const txt = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42e01e,mp4a.40.2",AUDIO="aud"
360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,AVERAGE-BANDWIDTH=2300000,RESOLUTION=1280x720,FRAME-RATE=29.970
720/index.m3u8
`;
  const pl = parsePlaylist(txt, BASE);
  assert.equal(pl.kind, "master");
  assert.equal(pl.variants.length, 2);
  assert.equal(pl.variants[0].height, 720);
  assert.equal(pl.variants[0].url, "https://cdn.example.com/v/720/index.m3u8");
  assert.equal(pl.variants[0].bandwidth, 2300000);
  assert.match(pl.variants[0].label, /720p/);
  assert.equal(pl.audio[0].url, "https://cdn.example.com/v/audio/en.m3u8");
  assert.equal(pl.audio[0].isDefault, true);
});

test("media playlist: segments, keys, byteranges, maps, discontinuity", () => {
  const txt = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"
#EXT-X-KEY:METHOD=AES-128,URI="k.key",IV=0x0000000000000000000000000000000A
#EXTINF:6.0,
#EXT-X-BYTERANGE:1000@720
seg.m4s
#EXTINF:6.0,
#EXT-X-BYTERANGE:2000
seg.m4s
#EXT-X-DISCONTINUITY
#EXT-X-KEY:METHOD=NONE
#EXTINF:4.5,
s3.m4s
#EXT-X-ENDLIST`;
  const pl = parsePlaylist(txt, BASE);
  assert.equal(pl.kind, "media");
  assert.equal(pl.segments.length, 3);
  assert.equal(pl.endList, true);
  assert.equal(pl.fmp4, true);
  assert.equal(pl.encrypted, true);
  assert.equal(pl.unsupportedEncryption, undefined);
  assert.equal(pl.duration, 16.5);
  const [a, b, c] = pl.segments;
  assert.equal(a.sn, 10);
  assert.deepEqual(a.byteRange, { length: 1000, offset: 720 });
  assert.deepEqual(b.byteRange, { length: 2000, offset: 1720 }); // continues previous
  assert.equal(a.key.method, "AES-128");
  assert.equal(a.key.uri, "https://cdn.example.com/v/k.key");
  assert.equal(a.key.iv[15], 0x0a);
  assert.equal(a.map.uri, "https://cdn.example.com/v/init.mp4");
  assert.deepEqual(a.map.byteRange, { length: 720, offset: 0 });
  assert.equal(c.key, undefined);
  assert.equal(c.discontinuity, true);
});

test("SAMPLE-AES and DRM are flagged unsupported", () => {
  const sa = parsePlaylist(`#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST`, BASE);
  assert.equal(sa.unsupportedEncryption, "SAMPLE-AES");
  const drm = parsePlaylist(`#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,KEYFORMAT="com.widevine",URI="data:..."\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST`, BASE);
  assert.match(drm.unsupportedEncryption, /DRM/);
  assert.equal(drm.fmp4, false);
});

test("live playlist (no ENDLIST) and VOD type", () => {
  const live = parsePlaylist(`#EXTM3U\n#EXTINF:4,\na.ts`, BASE);
  assert.equal(live.endList, false);
  const vod = parsePlaylist(`#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4,\na.ts`, BASE);
  assert.equal(vod.endList, true);
});

test("ivFromSequence is 128-bit big-endian", () => {
  const iv = ivFromSequence(258);
  assert.equal(iv.length, 16);
  assert.equal(iv[14], 1);
  assert.equal(iv[15], 2);
});

import { qualityClass, variantLabel } from "../src/shared/m3u8.ts";
test("quality class follows the 16:9-equivalent height (cinemascope)", () => {
  assert.equal(qualityClass(1920, 800), "1080p");
  assert.equal(qualityClass(1280, 534), "720p");
  assert.equal(qualityClass(640, 266), "360p");
  assert.equal(qualityClass(1920, 1080), "1080p");
  assert.equal(qualityClass(3840, 1608), "4K");
  assert.equal(qualityClass(1280, 720), "720p");
  assert.equal(qualityClass(1080, 1920), "1080p"); // portrait video
  assert.equal(qualityClass(undefined, 480), "480p");
  assert.equal(variantLabel({ width: 1920, height: 800, bandwidth: 4_600_000 }), "1080p • 4.6 Mbps");
});
