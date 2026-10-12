// Renders public/poster.png (16:9, for the hub's game card) from a real recorded game: the flood-fill baseline's demo,
// at the step it has the most apples before it ends. Node only, no dependencies: the board is drawn with the page's
// own renderer into a pixel buffer, the lettering with a small 5 x 7 pixel font, and the PNG encoded with zlib.
// Run: node games/snake/scripts/poster.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createGame, step, type GameState, type Move } from '../shared/engine.ts';
import { AI, paintBoard, type Painter } from '../src/render.ts';

const W = 1280;
const H = 720;
const px = new Uint8Array(W * H * 3);
const hex = (c: string): [number, number, number] => {
  const n = c.replace('#', '');
  const full = n.length === 3 ? [...n].map((d) => d + d).join('') : n;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
};
const rect = (x: number, y: number, w: number, h: number, color: string) => {
  const [r, g, b] = hex(color);
  for (let j = Math.max(0, Math.round(y)); j < Math.min(H, Math.round(y + h)); j++) {
    for (let i = Math.max(0, Math.round(x)); i < Math.min(W, Math.round(x + w)); i++) {
      const k = (j * W + i) * 3;
      px[k] = r;
      px[k + 1] = g;
      px[k + 2] = b;
    }
  }
};
const painter: Painter = {
  rect,
  circle(cx, cy, rad, color) {
    for (let j = Math.floor(cy - rad); j <= cy + rad; j++) for (let i = Math.floor(cx - rad); i <= cx + rad; i++) if ((i + 0.5 - cx) ** 2 + (j + 0.5 - cy) ** 2 <= rad * rad) rect(i, j, 1, 1, color);
  },
};

// A 5 x 7 pixel font, only the letters the poster uses.
const FONT: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  '0': ['01110', '10011', '10101', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};
function text(s: string, x: number, y: number, size: number, color: string): void {
  [...s].forEach((ch, n) => {
    const g = FONT[ch];
    if (!g) throw new Error(`no glyph for ${ch}`);
    g.forEach((row, j) => [...row].forEach((bit, i) => bit === '1' && rect(x + (n * 6 + i) * size, y + j * size, size, size, color)));
  });
}

// The flood-fill baseline's recorded game, at its last step before the end.
const rec = JSON.parse(readFileSync(new URL('../public/demo/flood.json', import.meta.url), 'utf8')) as { seed: number; steps: { choice: Move }[] };
let s: GameState = createGame(rec.seed);
let shown = s;
for (const st of rec.steps) {
  const next = step(s, st.choice);
  if (next.over) break;
  s = next;
  shown = s;
}

rect(0, 0, W, H, '#000');
// The board on the left, as the page draws it (18 cells of 36 px = 648 px).
paintBoard(painter, shown, AI, 36, 56, 36);
// Lettering on the right, in the arcade's colours.
text('SNAKE', 762, 130, 16, '#ffd800');
text('A DECISION', 762, 300, 7, '#ffffff');
text('BENCHMARK', 762, 370, 7, '#ffffff');
text('FLOOD FILL', 762, 500, 5, '#00e5ff');
text(`${shown.apples} APPLES`, 762, 560, 5, '#8f97ff');
rect(762, 640, 440, 6, '#2121de');

// PNG: 8-bit RGB, no filter, zlib.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Uint8Array) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // RGB
const raw = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) Buffer.from(px.subarray(y * W * 3, (y + 1) * W * 3)).copy(raw, y * (1 + W * 3) + 1);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array())]);
const out = new URL('../public/poster.png', import.meta.url);
writeFileSync(out, png);
console.log(`wrote ${out.pathname}: ${W}x${H}, ${Math.ceil(png.length / 1024)} KB, step ${shown.steps}, ${shown.apples} apples`);
