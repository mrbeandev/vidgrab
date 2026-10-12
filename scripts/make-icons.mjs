// Generates public/icons/icon-{16,32,48,128}.png without any dependency.
// Design: rounded violet→cyan gradient tile with a white "download arrow into a play tray".
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../public/icons");
mkdirSync(outDir, { recursive: true });

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
// signed distance helpers
const sdRoundBox = (px, py, hx, hy, r) => {
  const qx = Math.abs(px) - hx + r, qy = Math.abs(py) - hy + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
};
const sdSeg = (px, py, ax, ay, bx, by) => {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const t = clamp01((wx * vx + wy * vy) / (vx * vx + vy * vy));
  return Math.hypot(wx - vx * t, wy - vy * t);
};

function pixel(x, y, s) {
  const u = x / s, v = y / s; // 0..1
  const cx = (u - 0.5) * s, cy = (v - 0.5) * s;
  const aa = 1.0; // antialias width in px
  // tile
  const tile = sdRoundBox(cx, cy, s * 0.46, s * 0.46, s * 0.22);
  const tileA = clamp01(0.5 - tile / aa);
  if (tileA <= 0) return [0, 0, 0, 0];
  // gradient violet (124,58,237) → cyan (34,211,238)
  const t = clamp01(u * 0.6 + v * 0.6 - 0.1);
  let r = lerp(124, 34, t), g = lerp(58, 211, t), b = lerp(237, 238, t);
  // glyph: arrow shaft, arrow head, tray
  const w = Math.max(1.2, s * 0.085);
  const shaft = sdSeg(cx, cy, 0, -s * 0.30, 0, s * 0.10) - w;
  const headL = sdSeg(cx, cy, 0, s * 0.12, -s * 0.19, -s * 0.07) - w;
  const headR = sdSeg(cx, cy, 0, s * 0.12, s * 0.19, -s * 0.07) - w;
  const tray = Math.min(
    sdSeg(cx, cy, -s * 0.28, s * 0.18, -s * 0.28, s * 0.30) - w,
    sdSeg(cx, cy, -s * 0.28, s * 0.30, s * 0.28, s * 0.30) - w,
    sdSeg(cx, cy, s * 0.28, s * 0.18, s * 0.28, s * 0.30) - w,
  );
  const glyph = Math.min(shaft, headL, headR, tray);
  const gA = clamp01(0.5 - glyph / aa);
  r = lerp(r, 255, gA); g = lerp(g, 255, gA); b = lerp(b, 255, gA);
  return [Math.round(r), Math.round(g), Math.round(b), Math.round(tileA * 255)];
}

for (const size of [16, 32, 48, 128]) {
  const file = resolve(outDir, `icon-${size}.png`);
  if (existsSync(file) && process.argv.includes("--skip-existing")) continue;
  writeFileSync(file, png(size, pixel));
}
console.log("icons written to", outDir);
