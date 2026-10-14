// Rasterize the app icon to PNG + ICO with no external dependencies.
// zlib is built into Node, so we can write a real PNG encoder by hand.
//
// Usage: node tools/make-icons.mjs
//
// The mark: a rounded neutral tile with a white prompt chevron, a white
// four-point spark, and a grey cursor bar. Same geometry as assets/icon.svg
// (shared 512-unit space).

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "assets");
fs.mkdirSync(OUT, { recursive: true });

/* ---------------------------------- PNG ---------------------------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
/** rgba: Buffer of width*height*4 */
function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------------------------------- ICO ---------------------------------- */
// ICO supports PNG-compressed entries, which keeps this simple.
function encodeICO(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);   // type: icon
  header.writeUInt16LE(count, 4);
  const entries = [];
  let offset = 6 + count * 16;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);      // colour planes
    e.writeUInt16LE(32, 6);     // bits per pixel
    e.writeUInt32BE(0, 8);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map(p => p.data)]);
}

/* -------------------------------- RENDERER -------------------------------- */
const TILE_TOP = [0x1a, 0x1a, 0x1a];
const TILE_BOT = [0x0d, 0x0d, 0x0d];
const CHEV_TOP = [0xf5, 0xf5, 0xf5];
const CHEV_BOT = [0xbd, 0xbd, 0xbd];
const SPK_TOP = [0xff, 0xff, 0xff];
const SPK_BOT = [0xcf, 0xcf, 0xcf];
const BAR = [0x9a, 0x9a, 0x9a];
const BAR_ALPHA = 0.38;

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Rounded-rect coverage test in unit space (0..1). */
function inTile(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
/** Four-point spark: superellipse with exponent < 1 pinches the diagonals. */
function inSpark(x, y, r, p = 0.5) {
  const dx = Math.abs(x) / r, dy = Math.abs(y) / r;
  return Math.pow(dx, p) + Math.pow(dy, p) <= 1;
}
function inRoundedRect(x, y, cx, cy, hx, hy, r) {
  const dx = Math.abs(x - cx), dy = Math.abs(y - cy);
  if (dx > hx || dy > hy) return false;
  const qx = Math.max(dx - (hx - r), 0), qy = Math.max(dy - (hy - r), 0);
  return qx * qx + qy * qy <= r * r;
}
/** Distance from p to segment ab (capsule test for the chevron strokes). */
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
  const qx = ax + dx * t, qy = ay + dy * t;
  return Math.hypot(px - qx, py - qy);
}

// Mark geometry, straight from assets/icon.svg, converted to unit space.
const U = 1 / 512;
const CHEV_HALF = 23 * U;                       // stroke-width 46
const CHEV_A = [178 * U, 172 * U];
const CHEV_B = [298 * U, 256 * U];
const CHEV_C = [178 * U, 340 * U];
const BAR_C = [238 * U, 398 * U], BAR_HX = 61 * U, BAR_HY = 13 * U, BAR_R = 10 * U;
const SPK_C = [366 * U, 207 * U], SPK_R = 53 * U;

function renderIcon(size) {
  const SS = 3;                       // supersample factor for anti-aliasing
  const S = size * SS;
  const out = Buffer.alloc(size * size * 4);
  const radius = 0.219;               // 112 / 512

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // unit coordinates, sampled at subpixel centres
          const x = (px * SS + sx + 0.5) / S;
          const y = (py * SS + sy + 0.5) / S;

          if (!inTile(x, y, radius)) continue;

          // tile base with vertical gradient
          let col = mix(TILE_TOP, TILE_BOT, y);

          // cursor bar
          if (inRoundedRect(x, y, BAR_C[0], BAR_C[1], BAR_HX, BAR_HY, BAR_R)) {
            col = mix(col, BAR, BAR_ALPHA);
          }

          // chevron: union of the two capsules gives round caps and join
          const dc = Math.min(
            distToSeg(x, y, CHEV_A[0], CHEV_A[1], CHEV_B[0], CHEV_B[1]),
            distToSeg(x, y, CHEV_B[0], CHEV_B[1], CHEV_C[0], CHEV_C[1])
          );
          if (dc <= CHEV_HALF) {
            col = mix(CHEV_TOP, CHEV_BOT, clamp01((x + y - 304 * U) / (380 * U)));
          }

          // spark, drawn last (it sits clear of the chevron tip)
          const sdx = x - SPK_C[0], sdy = y - SPK_C[1];
          if (inSpark(sdx, sdy, SPK_R)) {
            col = mix(SPK_TOP, SPK_BOT, clamp01(0.5 + (sdx + sdy) / (4 * SPK_R)));
          }

          r += col[0]; g += col[1]; b += col[2]; a += 255;
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      const cov = a / (255 * n);          // coverage 0..1
      if (cov > 0) {
        out[i] = Math.round(r / (n * cov));
        out[i + 1] = Math.round(g / (n * cov));
        out[i + 2] = Math.round(b / (n * cov));
        out[i + 3] = Math.round(cov * 255);
      }
    }
  }
  return out;
}

/* --------------------------------- OUTPUT -------------------------------- */
// 1024 is required as a source for macOS (.icns wants 512@2x) and gives a
// crisp master for every other size.
const pngSizes = [16, 32, 48, 64, 128, 256, 512, 1024];
const made = [];
for (const s of pngSizes) {
  const rgba = renderIcon(s);
  const png = encodePNG(s, s, rgba);
  const file = path.join(OUT, "icon" + s + ".png");
  fs.writeFileSync(file, png);
  made.push({ size: s, bytes: png.length, file, png });
}

// multi-resolution .ico for Windows/Electron
const icoSizes = [16, 32, 48, 64, 128, 256];
const ico = encodeICO(made.filter(m => icoSizes.includes(m.size)).map(m => ({ size: m.size, data: m.png })));
fs.writeFileSync(path.join(OUT, "icon.ico"), ico);

// canonical icon used by electron-builder for macOS and Linux.
// macOS rejects anything under 512x512, so ship the 1024 master.
fs.copyFileSync(path.join(OUT, "icon1024.png"), path.join(OUT, "icon.png"));

console.log("generated:");
for (const m of made) console.log("  " + path.relative(process.cwd(), m.file).padEnd(28) + m.size + "px  " + m.bytes + "b");
console.log("  " + path.relative(process.cwd(), path.join(OUT, "icon.ico")).padEnd(28) + icoSizes.join("/") + "  " + ico.length + "b");
