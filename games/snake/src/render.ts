// Draws a Snake board on a canvas: the arcade's black, a double blue wall, the snake and the apple. The page draws
// both boards with it; scripts/poster.ts draws the same picture into a PNG.
import { SIZE, type Cell, type GameState } from '../shared/engine.ts';

/** Pixels per cell on the canvas (the CSS scales it); the wall takes one cell on each side. */
export const CELL = 20;
export const CANVAS = (SIZE + 2) * CELL;

export interface Palette {
  body: string;
  head: string;
}
export const PLAYER: Palette = { body: '#22c55e', head: '#86efac' };
export const AI: Palette = { body: '#00b8d4', head: '#7df9ff' };

const WALL = '#2121de';
const APPLE = '#ff3b3b';
const DOT = '#14143a';

/** Rectangles and circles, so the page's canvas and the poster's pixel buffer draw the same board. */
export interface Painter {
  rect(x: number, y: number, w: number, h: number, color: string): void;
  circle(cx: number, cy: number, r: number, color: string): void;
}

export function canvasPainter(ctx: CanvasRenderingContext2D): Painter {
  return {
    rect(x, y, w, h, color) {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
    },
    circle(cx, cy, r, color) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    },
  };
}

/** The board at `scale` pixels per cell, from (ox, oy). A null state draws the empty board. */
export function paintBoard(p: Painter, s: GameState | null, palette: Palette, scale = CELL, ox = 0, oy = 0): void {
  const n = SIZE + 2;
  p.rect(ox, oy, n * scale, n * scale, '#000');
  // The double wall, as the jevman maze draws it: two thin blue lines.
  const t = Math.max(2, Math.round(scale / 7));
  const outer = Math.round(scale * 0.25);
  const inner = Math.round(scale * 0.7);
  for (const d of [outer, inner]) {
    p.rect(ox + d, oy + d, n * scale - 2 * d, t, WALL);
    p.rect(ox + d, oy + n * scale - d - t, n * scale - 2 * d, t, WALL);
    p.rect(ox + d, oy + d, t, n * scale - 2 * d, WALL);
    p.rect(ox + n * scale - d - t, oy + d, t, n * scale - 2 * d, WALL);
  }
  // A faint dot per cell, so the grid reads.
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) p.rect(ox + (x + 1) * scale + scale / 2 - 1, oy + (y + 1) * scale + scale / 2 - 1, 2, 2, DOT);
  if (!s) return;
  const at = (c: Cell) => [ox + (c.x + 1) * scale, oy + (c.y + 1) * scale] as const;
  if (s.apple) {
    const [x, y] = at(s.apple);
    p.circle(x + scale / 2, y + scale / 2 + scale * 0.05, scale * 0.36, APPLE);
    p.rect(x + scale / 2 - 1, y + scale * 0.08, Math.max(2, scale * 0.12), scale * 0.22, '#22c55e');
  }
  const g = Math.max(1, Math.round(scale * 0.1));
  // Tail first, so the head is drawn on top; each segment joins the next one.
  for (let i = s.body.length - 1; i >= 0; i--) {
    const c = s.body[i]!;
    if (c.x < 0 || c.y < 0 || c.x >= SIZE || c.y >= SIZE) continue;
    const [x, y] = at(c);
    p.rect(x + g, y + g, scale - 2 * g, scale - 2 * g, i === 0 ? palette.head : palette.body);
    const prev = s.body[i - 1];
    if (prev) {
      const [px, py] = at(prev);
      if (px !== x) p.rect(Math.min(x, px) + scale - g, y + g, 2 * g, scale - 2 * g, palette.body);
      if (py !== y) p.rect(x + g, Math.min(y, py) + scale - g, scale - 2 * g, 2 * g, palette.body);
    }
  }
  // Eyes on the head, facing the way it goes.
  const [hx, hy] = at(s.body[0]!);
  const e = Math.max(2, Math.round(scale * 0.14));
  const f = { up: [[0.3, 0.25], [0.7, 0.25]], down: [[0.3, 0.75], [0.7, 0.75]], left: [[0.25, 0.3], [0.25, 0.7]], right: [[0.75, 0.3], [0.75, 0.7]] }[s.heading];
  for (const [fx, fy] of f) p.rect(hx + fx! * scale - e / 2, hy + fy! * scale - e / 2, e, e, '#000');
}

export function drawBoard(ctx: CanvasRenderingContext2D, s: GameState | null, palette: Palette): void {
  paintBoard(canvasPainter(ctx), s, palette);
}
