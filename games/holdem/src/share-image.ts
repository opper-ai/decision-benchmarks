// The end of a game as a 1200×630 image for social posts, drawn on a canvas in the page: no server. The left is the
// end poster (title, places, the best moment's name), the right the felt with the best moment's protagonist, their
// cards, the board as it ended, and the end screen's sentence for it.
// Three steps, the first two pure so tests can check them without a canvas: what the card says (shareCardData), where
// everything goes (shareCardLayout), then drawing it (renderShareCard).
import { formatCard } from '../shared/cards.ts';
import type { Elimination } from '../shared/sitngo.ts';
import type { Review } from './driver.ts';
import { factsOf, momentOf, potText } from './highlights.ts';
import { avatarPath } from './roster.ts';
import { cardFace, ordinal, personOf } from './view-model.ts';

export const SHARE_W = 1200;
export const SHARE_H = 630;

export interface ShareCardData {
  title: string;
  sub: string;
  standings: { place: number; name: string; slug: string | null; line: string }[];
  /** The best moment's name and where it happened ("Hand 23, pot: 100 big blinds"), if the game had one. */
  moment: { title: string; where: string } | null;
  /** The best moment on the felt: its protagonist, their cards, the board as it ended, and the end screen's sentence. */
  featured: { name: string; slug: string | null; hole: string[]; board: string[]; caption: string } | null;
}

/** What the image says, from the finished game: the end screen's words. */
export function shareCardData(review: Review, places: readonly (number | null)[], eliminations: readonly Elimination[], hands: number, viewer: number | null): ShareCardData {
  const people = review.players.map((p) => personOf(p));
  const name = (seat: number) => people[seat]!.name;
  const inner = (seat: number) => (name(seat) === 'You' ? 'you' : name(seat));
  const winner = places.indexOf(1);
  const mine = viewer === null ? null : places[viewer];
  const title = viewer === null ? `${name(winner)} wins the table` : mine === 1 ? 'You won the table' : `You finished ${ordinal(mine ?? places.length)}`;
  const standings = places
    .map((p, seat) => ({ place: p ?? places.length, seat }))
    .sort((a, b) => a.place - b.place)
    .map(({ place, seat }) => {
      const out = eliminations.find((e) => e.seat === seat);
      const line = out ? `Out in hand ${out.hand}${out.by.length ? `, by ${out.by.map(inner).join(' and ')}` : ''}` : 'Took every chip';
      return { place, name: name(seat), slug: people[seat]!.slug, line };
    });
  const m = momentOf(review.hands, review.players, name);
  let featured: ShareCardData['featured'] = null;
  const hand = m && review.hands.find((h) => h.hand === m.highlight.hand);
  if (m && hand) {
    const f = factsOf(hand);
    const seat = m.highlight.featured;
    const hole = f.holes[seat];
    if (hole) featured = { name: name(seat), slug: people[seat]!.slug, hole: hole.map(formatCard), board: f.board.map(formatCard), caption: m.text };
  }
  const moment = m ? { title: m.title, where: `Hand ${m.highlight.hand}, pot: ${potText(m.highlight)}` } : null;
  return { title, sub: `No-limit Hold'em, ${hands} hands against AI models`, standings, moment, featured };
}

export type Item =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; r: number; fill: string; stroke?: string; line?: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; fill: string; stroke?: string; line?: number }
  | { kind: 'text'; x: number; y: number; text: string; font: string; size: number; weight: number; color: string; align: 'left' | 'center' | 'right' }
  | { kind: 'avatar'; cx: number; cy: number; r: number; slug: string | null; label: string; mood?: string; dim?: boolean; ring?: string }
  | { kind: 'card'; x: number; y: number; w: number; card: string; dim?: boolean; lit?: boolean }
  | { kind: 'back'; x: number; y: number; w: number }
  | { kind: 'bubble'; x: number; y: number; text: string; size: number; maxWidth: number };

/** How wide a line of text is: the canvas's own measure in the page, an estimate in tests. */
export type Measure = (text: string, font: string, size: number, weight: number) => number;
export const estimate: Measure = (text, font, size) => text.length * size * (font === 'Fraunces' ? 0.56 : 0.52);

export const C = { ink: '#211a12', red: '#b5342b', brass: '#d7aa52', brassDeep: '#9b7432', ivory: '#f7efdc', paper: '#fbf6ea', felt: '#155139', feltDeep: '#0a2e21', rail: '#5b2b18', text: '#f3e8cd', muted: '#6a5c48' };

/** Lines of at most `width`, by words; the last one cut with an ellipsis past `maxLines`. */
export function wrap(text: string, width: number, maxLines: number, fits: (s: string) => boolean): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (fits(next) || !line) line = next;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1]!;
  while (last && !fits(`${last}…`)) last = last.replace(/\s*\S+$/, '');
  kept[maxLines - 1] = `${last}…`;
  return kept;
}

/** Every shape, word, face and card on the image, in drawing order. */
export function shareCardLayout(d: ShareCardData, measure: Measure = estimate): Item[] {
  const items: Item[] = [];
  const text = (x: number, y: number, t: string, size: number, o: { font?: string; weight?: number; color?: string; align?: 'left' | 'center' | 'right'; width?: number } = {}) => {
    const font = o.font ?? 'Wix Madefor Text';
    const weight = o.weight ?? 500;
    let s = size;
    // Shrink a line that does not fit, down to two thirds of its size, then cut it.
    while (o.width && s > size * 0.67 && measure(t, font, s, weight) > o.width) s -= 1;
    let line = t;
    while (o.width && line.length > 1 && measure(line, font, s, weight) > o.width) line = `${line.slice(0, -2)}…`;
    items.push({ kind: 'text', x, y, text: line, font, size: s, weight, color: o.color ?? C.ink, align: o.align ?? 'left' });
  };

  // The room.
  items.push({ kind: 'rect', x: 0, y: 0, w: SHARE_W, h: SHARE_H, r: 0, fill: '#1c100a' });
  // The poster.
  const px = 36;
  const py = 34;
  const pw = 640;
  const ph = SHARE_H - 2 * py;
  items.push({ kind: 'rect', x: px, y: py, w: pw, h: ph, r: 26, fill: C.paper });
  items.push({ kind: 'rect', x: px + 9, y: py + 9, w: pw - 18, h: ph - 18, r: 19, fill: 'transparent', stroke: C.red, line: 2 });
  const cx = px + pw / 2;
  // The title on one line, down to 44 px; past that, two lines at 44 px.
  const titleW = pw - 70;
  const fitsAt = (size: number) => (t: string) => measure(t, 'Fraunces', size, 800) <= titleW;
  let size = 60;
  while (size > 44 && !fitsAt(size)(d.title)) size -= 2;
  const titleLines = fitsAt(size)(d.title) ? [d.title] : wrap(d.title, titleW, 2, fitsAt(size));
  titleLines.forEach((l, i) => text(cx, py + 88 + i * (size + 2), l, size, { font: 'Fraunces', weight: 800, color: C.red, align: 'center', width: titleW }));
  const dy = (titleLines.length - 1) * (size + 2);
  text(cx, py + 124 + dy, d.sub, 21, { color: '#5d503e', align: 'center', width: pw - 80 });
  let y = py + 150 + dy;
  // Up to six rows: tighter as there are more (the moment's box keeps its place at the foot).
  const rows = d.standings.slice(0, 6);
  const rowH = rows.length > 4 ? (dy ? 40 : 44) : rows.length > 3 ? (dy ? 56 : 62) : 70;
  const small = rows.length > 4;
  for (const s of rows) {
    items.push({ kind: 'rect', x: px + 30, y, w: pw - 60, h: rowH - 8, r: 14, fill: 'rgba(120, 80, 30, 0.08)' });
    const mid = y + (rowH - 8) / 2;
    text(px + 76, mid + (small ? 8 : 11), ordinal(s.place), small ? 24 : 30, { font: 'Fraunces', weight: 800, color: C.red, align: 'center' });
    items.push({ kind: 'avatar', cx: px + 140, cy: mid, r: small ? 15 : 22, slug: s.slug, label: s.name });
    if (small) {
      // One line each: the name, and how they went out after it.
      text(px + 168, mid + 7, s.name, 20, { font: 'Wix Madefor Display', weight: 700, width: 220 });
      text(px + 168 + Math.min(220, measure(s.name, 'Wix Madefor Display', 20, 700)) + 14, mid + 6, s.line, 15, { color: C.muted, width: pw - 230 - Math.min(220, measure(s.name, 'Wix Madefor Display', 20, 700)) - 14 });
    } else {
      text(px + 176, mid - 3, s.name, 24, { font: 'Wix Madefor Display', weight: 700, width: pw - 230 });
      text(px + 176, mid + 21, s.line, 17, { color: C.muted, width: pw - 230 });
    }
    y += rowH;
  }
  if (d.moment) {
    const top = Math.max(y + 6, py + ph - 104);
    items.push({ kind: 'rect', x: px + 30, y: top, w: pw - 60, h: py + ph - 30 - top, r: 14, fill: 'transparent', stroke: 'rgba(155, 116, 50, 0.45)', line: 1.5 });
    text(px + 48, top + 34, `Best moment: ${d.moment.title}`, 22, { font: 'Fraunces', weight: 800, color: C.brassDeep, width: pw - 100 });
    text(px + 48, top + 60, d.moment.where, 17, { color: C.muted, width: pw - 100 });
  }

  // The felt.
  const fx = px + pw + (SHARE_W - px - pw) / 2;
  const fy = SHARE_H / 2 - 6;
  items.push({ kind: 'ellipse', cx: fx, cy: fy, rx: 232, ry: 262, fill: C.rail });
  items.push({ kind: 'ellipse', cx: fx, cy: fy, rx: 216, ry: 246, fill: C.felt });
  items.push({ kind: 'ellipse', cx: fx, cy: fy, rx: 196, ry: 226, fill: 'transparent', stroke: 'rgba(215, 170, 82, 0.45)', line: 1.5 });
  if (d.featured) {
    const f = d.featured;
    items.push({ kind: 'avatar', cx: fx, cy: fy - 160, r: 56, slug: f.slug, label: f.name });
    text(fx, fy - 80, f.name, 22, { font: 'Fraunces', weight: 800, color: C.ivory, align: 'center', width: 340 });
    const hw = 54;
    f.hole.forEach((c, i) => items.push({ kind: 'card', x: fx - hw - 5 + i * (hw + 10), y: fy - 64, w: hw, card: c }));
    const bw = 48;
    const gap = 7;
    const total = f.board.length * bw + Math.max(0, f.board.length - 1) * gap;
    f.board.forEach((c, i) => items.push({ kind: 'card', x: fx - total / 2 + i * (bw + gap), y: fy + 24, w: bw, card: c }));
    // The end screen's sentence, in up to three lines.
    const lines = wrap(f.caption, 360, 3, (t) => measure(t, 'Wix Madefor Text', 17, 500) <= 360);
    lines.forEach((l, i) => text(fx, fy + 122 + i * 22, l, 17, { color: C.text, align: 'center', width: 380 }));
  }
  text(fx, fy + 214, "AI Hold'em", 32, { font: 'Fraunces', weight: 800, color: C.brass, align: 'center' });
  text(fx, SHARE_H - 18, 'opper.ai/decision-benchmarks/holdem', 16, { color: 'rgba(243, 232, 205, 0.6)', align: 'center' });
  return items;
}

// ---------- drawing ----------

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawCard(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, card: string): void {
  const h = w * 1.4;
  const face = cardFace(card);
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  roundRect(ctx, x, y, w, h, w * 0.1);
  ctx.fillStyle = '#fbf5e6';
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = face.red ? C.red : C.ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `800 ${Math.round(w * 0.44)}px Fraunces, Georgia, serif`;
  ctx.fillText(face.rank, x + w * 0.08, y + w * 0.44);
  ctx.font = `${Math.round(w * 0.28)}px system-ui, sans-serif`;
  ctx.fillText(face.suit, x + w * 0.1, y + w * 0.78);
  ctx.font = `${Math.round(w * 0.62)}px system-ui, sans-serif`;
  ctx.textAlign = 'right';
  ctx.fillText(face.suit, x + w * 0.92, y + h - w * 0.1);
}

async function loadImage(src: string): Promise<HTMLImageElement | null> {
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

/** The fonts a drawing uses, loaded before the first frame. */
export async function loadFonts(): Promise<void> {
  await Promise.all(['800 60px Fraunces', '500 20px "Wix Madefor Text"', '700 24px "Wix Madefor Display"', '700 30px Caveat'].map((f) => document.fonts.load(f).catch(() => [])));
}

const faceKey = (slug: string, mood = 'relaxed') => `${slug}/${mood}`;

/** Every avatar picture the items need, by slug and mood. */
export async function loadFaces(items: readonly Item[], asset: (path: string) => string, into = new Map<string, HTMLImageElement | null>()): Promise<Map<string, HTMLImageElement | null>> {
  await Promise.all(
    items.flatMap((it) => {
      if (it.kind !== 'avatar' || !it.slug) return [];
      const key = faceKey(it.slug, it.mood);
      if (into.has(key)) return [];
      into.set(key, null);
      return [loadImage(asset(avatarPath(it.slug, (it.mood ?? 'relaxed') as never))).then((img) => into.set(key, img))];
    }),
  );
  return into;
}

function drawBack(ctx: CanvasRenderingContext2D, x: number, y: number, w: number): void {
  const h = w * 1.4;
  roundRect(ctx, x, y, w, h, w * 0.1);
  ctx.fillStyle = C.paper;
  ctx.fill();
  roundRect(ctx, x + w * 0.06, y + w * 0.06, w * 0.88, h - w * 0.12, w * 0.07);
  ctx.fillStyle = '#8e2620';
  ctx.fill();
}

function drawBubble(ctx: CanvasRenderingContext2D, it: Extract<Item, { kind: 'bubble' }>): void {
  ctx.font = `700 ${it.size}px Caveat, cursive`;
  const lines = wrap(it.text, it.maxWidth, 2, (t) => ctx.measureText(t).width <= it.maxWidth);
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + it.size * 1.1;
  const h = lines.length * it.size * 1.05 + it.size * 0.6;
  const x = it.x - w / 2;
  const y = it.y - h;
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
  ctx.shadowBlur = 10;
  roundRect(ctx, x, y, w, h, it.size * 0.6);
  ctx.fillStyle = C.paper;
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.moveTo(it.x - 8, y + h - 1);
  ctx.lineTo(it.x, y + h + 9);
  ctx.lineTo(it.x + 8, y + h - 1);
  ctx.fillStyle = C.paper;
  ctx.fill();
  ctx.fillStyle = C.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  lines.forEach((l, i) => ctx.fillText(l, it.x, y + it.size * 1.0 + i * it.size * 1.05));
}

/** Draws items in order. Avatars come from `faces` (loadFaces); a missing face is a brass disc. */
export function drawItems(ctx: CanvasRenderingContext2D, items: readonly Item[], faces: ReadonlyMap<string, HTMLImageElement | null>): void {
  for (const it of items) {
    if (it.kind === 'rect') {
      roundRect(ctx, it.x, it.y, it.w, it.h, it.r);
      if (it.fill !== 'transparent') {
        ctx.fillStyle = it.fill;
        ctx.fill();
      }
      if (it.stroke) {
        ctx.strokeStyle = it.stroke;
        ctx.lineWidth = it.line ?? 1;
        ctx.stroke();
      }
    } else if (it.kind === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(it.cx, it.cy, it.rx, it.ry, 0, 0, Math.PI * 2);
      if (it.fill !== 'transparent') {
        ctx.fillStyle = it.fill;
        ctx.fill();
      }
      if (it.stroke) {
        ctx.strokeStyle = it.stroke;
        ctx.lineWidth = it.line ?? 1;
        ctx.stroke();
      }
    } else if (it.kind === 'text') {
      ctx.fillStyle = it.color;
      ctx.textAlign = it.align;
      ctx.textBaseline = 'alphabetic';
      ctx.font = `${it.weight} ${it.size}px "${it.font}", Georgia, sans-serif`;
      ctx.fillText(it.text, it.x, it.y);
    } else if (it.kind === 'avatar') {
      const img = it.slug ? faces.get(faceKey(it.slug, it.mood)) ?? faces.get(faceKey(it.slug)) : null;
      ctx.save();
      if (it.dim) ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.arc(it.cx, it.cy, it.r, 0, Math.PI * 2);
      ctx.fillStyle = C.brass;
      ctx.fill();
      ctx.clip();
      if (img) ctx.drawImage(img, it.cx - it.r, it.cy - it.r, it.r * 2, it.r * 2);
      else {
        ctx.fillStyle = C.ink;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `800 ${Math.round(it.r * 0.9)}px Fraunces, Georgia, serif`;
        ctx.fillText(it.label === 'You' || it.label === 'Human' ? '♠' : it.label.slice(0, 2), it.cx, it.cy + 2);
      }
      ctx.restore();
      ctx.beginPath();
      ctx.arc(it.cx, it.cy, it.r, 0, Math.PI * 2);
      ctx.strokeStyle = it.ring ?? C.brass;
      ctx.lineWidth = Math.max(2, it.r * (it.ring ? 0.1 : 0.07));
      ctx.stroke();
    } else if (it.kind === 'card') {
      ctx.save();
      if (it.dim) ctx.globalAlpha = 0.45;
      drawCard(ctx, it.x, it.y, it.w, it.card);
      if (it.lit) {
        roundRect(ctx, it.x, it.y, it.w, it.w * 1.4, it.w * 0.1);
        ctx.strokeStyle = '#ffc56b';
        ctx.lineWidth = Math.max(2, it.w * 0.06);
        ctx.stroke();
      }
      ctx.restore();
    } else if (it.kind === 'back') drawBack(ctx, it.x, it.y, it.w);
    else drawBubble(ctx, it);
  }
}

/** Draws the layout on a new canvas and returns it as a PNG. `asset` turns a path below the game into a URL. */
export async function renderShareCard(items: Item[], asset: (path: string) => string): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = SHARE_W;
  canvas.height = SHARE_H;
  const ctx = canvas.getContext('2d')!;
  await loadFonts();
  drawItems(ctx, items, await loadFaces(items, asset));
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the image could not be made'))), 'image/png'));
}

/** Saves a blob as a file. */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The canvas's own text measure. */
export function canvasMeasure(): Measure {
  const ctx = document.createElement('canvas').getContext('2d')!;
  return (text, font, size, weight) => {
    ctx.font = `${weight} ${size}px "${font}", Georgia, sans-serif`;
    return ctx.measureText(text).width;
  };
}

