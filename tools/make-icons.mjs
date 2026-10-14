// Rasterize the app icon to PNG + ICO with no external dependencies.
// zlib is built into Node, so we can write a real PNG encoder by hand.
//
// Usage: node tools/make-icons.mjs
//
// The mark: a rounded dark tile with a rust four-point spark.

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
const TILE_TOP = [0x24, 0x24, 0x24];
const TILE_BOT = [0x14, 0x14, 0x14];
const SPARK_TOP = [0xef, 0xa1, 0x83];
const SPARK_BOT = [0xd9, 0x77, 0x57];
const GLOW = [0xd9, 0x77, 0x57];

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

function renderIcon(size) {
  const SS = 3;                       // supersample factor for anti-aliasing
  const S = size * SS;
  const out = Buffer.alloc(size * size * 4);
  const radius = 0.219;               // 112 / 512
  const sparkR = 0.365;               // tuned so the mark stays legible at 16px

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

          // radial glow behind the spark
          const gdx = x - 0.5, gdy = y - 0.4;
          const gd = Math.sqrt(gdx * gdx + gdy * gdy) / 0.58;
          if (gd < 1) col = mix(col, GLOW, (1 - gd) * (1 - gd) * 0.26);

          // spark
          const sdx = x - 0.5, sdy = y - 0.5;
          if (inSpark(sdx, sdy, sparkR)) col = mix(SPARK_TOP, SPARK_BOT, clamp01(y));

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
const pngSizes = [16, 32, 48, 64, 128, 256, 512];
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

// canonical icon.png used by Electron
fs.copyFileSync(path.join(OUT, "icon256.png"), path.join(OUT, "icon.png"));

console.log("generated:");
for (const m of made) console.log("  " + path.relative(process.cwd(), m.file).padEnd(28) + m.size + "px  " + m.bytes + "b");
console.log("  " + path.relative(process.cwd(), path.join(OUT, "icon.ico")).padEnd(28) + icoSizes.join("/") + "  " + ico.length + "b");
