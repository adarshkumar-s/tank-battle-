// Dev tool: rasterise a generated battlefield to a BMP so the layout can be
// eyeballed without a browser.  Usage: node tools/map-preview.mjs [seed] [out]
import fs from 'node:fs';
import zlib from 'node:zlib';
import { generateMap } from '../shared/mapgen.js';

const seed = Number(process.argv[2] || 4242);
const out = process.argv[3] || '/tmp/tankfall-map.bmp';
const map = generateMap(seed);
const SCALE = 0.5;
const W = Math.round(map.w * SCALE);
const H = Math.round(map.h * SCALE);

const buf = Buffer.alloc(W * H * 3);
const PNG = out.endsWith('.png');
const set = (x, y, r, g, b) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const row = PNG ? y : H - 1 - y;
  const i = (row * W + x) * 3;
  buf[i] = b; buf[i + 1] = g; buf[i + 2] = r;
};
const rectFill = (x0, y0, w, h, r, g, b) => {
  for (let y = Math.round(y0 * SCALE); y < Math.round((y0 + h) * SCALE); y++) {
    for (let x = Math.round(x0 * SCALE); x < Math.round((x0 + w) * SCALE); x++) set(x, y, r, g, b);
  }
};
const circleFill = (cx, cy, rad, r, g, b) => {
  const R = rad * SCALE;
  for (let y = Math.floor((cy - rad) * SCALE); y <= Math.ceil((cy + rad) * SCALE); y++) {
    for (let x = Math.floor((cx - rad) * SCALE); x <= Math.ceil((cx + rad) * SCALE); x++) {
      const dx = x - cx * SCALE, dy = y - cy * SCALE;
      if (dx * dx + dy * dy <= R * R) set(x, y, r, g, b);
    }
  }
};

// background
rectFill(0, 0, map.w, map.h, 40, 48, 34);
const decoColors = {
  grass: [30, 58, 30], sand: [92, 82, 54], road: [58, 58, 62],
  water: [26, 58, 84], bridge: [96, 72, 48], trench: [40, 32, 20],
};
for (const d of map.deco) {
  const c = decoColors[d.kind] || [70, 80, 60];
  rectFill(d.x, d.y, d.w, d.h, c[0], c[1], c[2]);
}

const matColors = {
  concrete: [150, 150, 156], building: [104, 112, 128], woodCrate: [150, 105, 60],
  metalCrate: [126, 138, 150], barrel: [170, 70, 46], sandbag: [176, 152, 96],
  tree: [72, 118, 66], rock: [116, 118, 114], metal: [96, 106, 114], barrier: [200, 162, 40],
};
for (const o of map.obstacles) {
  if (o.kind === 'water') continue;
  const c = matColors[o.material] || [120, 120, 120];
  if (o.shape === 'circle') circleFill(o.x, o.y, o.r, c[0], c[1], c[2]);
  else rectFill(o.x, o.y, o.w, o.h, c[0], c[1], c[2]);
}

// spawn markers (white crosses)
for (const s of map.spawns) {
  for (let i = -6; i <= 6; i++) {
    set(Math.round(s.x * SCALE) + i, Math.round(s.y * SCALE), 255, 255, 255);
    set(Math.round(s.x * SCALE), Math.round(s.y * SCALE) + i, 255, 255, 255);
  }
}

if (out.endsWith('.bmp')) {
  const rowSize = W * 3;
  const pad = (4 - (rowSize % 4)) % 4;
  const dataSize = (rowSize + pad) * H;
  const header = Buffer.alloc(54);
  header.write('BM', 0);
  header.writeUInt32LE(54 + dataSize, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(W, 18);
  header.writeInt32LE(H, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(dataSize, 34);
  fs.writeFileSync(out, Buffer.concat([header, buf]));
} else {
  // Minimal PNG encoder (truecolour, no interlace).
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    buf.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  }
  const table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc = (b) => {
    let c = 0xffffffff;
    for (const byte of b) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(out, png);
}
console.log(`wrote ${out} — ${W}x${H}, seed ${seed}, ${map.obstacles.length} obstacles, ${map.spawns.length} spawns`);
