/**
 * 生成应用图标源图（scripts/icon-source.png，1024×1024）。
 * 纯 Node 实现（zlib + 手写 PNG 编码），无原生依赖。
 * 之后由 `tauri icon` 生成 Windows 所需的 icon.png / icon.ico 等全套尺寸。
 *
 * 设计：青色渐变圆角底板 + 白色"书页行" + 琥珀色书签。
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 1024;
const H = 1024;
const RADIUS = 224;

const px = new Uint8Array(W * H * 4);

// ---------- 颜色工具 ----------
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

const TOP = hex('#0f766e'); // teal-700
const BOTTOM = hex('#14b8a6'); // teal-500
const WHITE = [255, 255, 255];
const AMBER = hex('#fbbf24');

function setPx(x, y, [r, g, b], a) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  // 简单源-over 混合（底板已是不透明时等同直接覆盖）
  const dstA = px[i + 3] / 255;
  const outA = a + dstA * (1 - a);
  if (outA <= 0) return;
  px[i] = Math.round((r * a + px[i] * dstA * (1 - a)) / outA);
  px[i + 1] = Math.round((g * a + px[i + 1] * dstA * (1 - a)) / outA);
  px[i + 2] = Math.round((b * a + px[i + 2] * dstA * (1 - a)) / outA);
  px[i + 3] = Math.round(outA * 255);
}

function inRoundedRect(x, y, x0, y0, w, h, r) {
  if (x < x0 || y < y0 || x >= x0 + w || y >= y0 + h) return false;
  const cx = Math.max(x0 + r, Math.min(x, x0 + w - r - 1));
  const cy = Math.max(y0 + r, Math.min(y, y0 + h - r - 1));
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// ---------- 1. 渐变圆角底板 ----------
for (let y = 0; y < H; y++) {
  const t = y / (H - 1);
  const c = [lerp(TOP[0], BOTTOM[0], t), lerp(TOP[1], BOTTOM[1], t), lerp(TOP[2], BOTTOM[2], t)];
  for (let x = 0; x < W; x++) {
    if (inRoundedRect(x, y, 0, 0, W, H, RADIUS)) setPx(x, y, c, 1);
  }
}

// ---------- 2. 白色书页行（圆角横条，长短错落模拟文字） ----------
const LINE_X = 236;
const LINE_H = 46;
const LINE_GAP = 62;
const LINE_START_Y = 322;
const LINES = [552, 460, 552, 340];

function fillRoundedRect(x0, y0, w, h, r, color, alpha) {
  for (let y = Math.floor(y0); y < y0 + h; y++) {
    for (let x = Math.floor(x0); x < x0 + w; x++) {
      if (inRoundedRect(x, y, x0, y0, w, h, r)) setPx(x, y, color, alpha);
    }
  }
}

LINES.forEach((w, i) => {
  fillRoundedRect(LINE_X, LINE_START_Y + i * (LINE_H + LINE_GAP), w, LINE_H, LINE_H / 2, WHITE, 0.92);
});

// ---------- 3. 琥珀书签（右上角，底部带三角缺口） ----------
const BK_X = 700;
const BK_Y = 120;
const BK_W = 96;
const BK_H = 240;
const NOTCH = 40;
for (let y = BK_Y; y < BK_Y + BK_H; y++) {
  for (let x = BK_X; x < BK_X + BK_W; x++) {
    // 底部三角缺口：y 超过 BK_H - NOTCH 后按斜线裁剪
    const remain = BK_Y + BK_H - y;
    if (remain < NOTCH) {
      const half = (BK_W / 2) * (remain / NOTCH);
      const cx = BK_X + BK_W / 2;
      if (x < cx - half || x > cx + half) continue;
    }
    setPx(x, y, AMBER, 1);
  }
}

// ---------- PNG 编码 ----------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
// 10-12: compression/filter/interlace = 0

const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  const rowStart = y * (1 + W * 4);
  raw[rowStart] = 0; // filter: None
  Buffer.from(px.buffer, y * W * 4, W * 4).copy(raw, rowStart + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'icon-source.png');
mkdirSync(here, { recursive: true });
writeFileSync(out, png);
console.log(`图标源图已生成: ${out} (${(png.length / 1024).toFixed(1)} KB)`);
