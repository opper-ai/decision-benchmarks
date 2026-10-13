// Snake's rules (SPEC.md, "Rules"): a pure, deterministic engine. A game is its seed plus one move per step, so the
// bench, the submissions check, the page and the high-score check all replay the same game from the same moves.
// Isomorphic and Node-safe (erasable TypeScript only): the service runs it as is.

/** The board is SIZE x SIZE cells, with walls around it. */
export const SIZE = 16;
export const START_LENGTH = 3;
/** Steps without an apple before the snake starves, so a model that loops cannot stall a game. */
export const STARVE_STEPS = 150;
/** The longest game, in steps. */
export const MAX_STEPS = 1000;

export type Heading = 'up' | 'right' | 'down' | 'left';
/** A move, relative to the snake's heading. */
export type Move = 'left' | 'straight' | 'right';
export const MOVES: readonly Move[] = ['left', 'straight', 'right'];
/** How a game ended: into a wall, into its own body, starved, at the step cap, or with the board full. */
export type End = 'wall' | 'body' | 'starved' | 'steps' | 'full';

export interface Cell {
  x: number;
  y: number;
}

export interface GameState {
  seed: number;
  /** The apple PRNG's state: it moves on once per apple placed, so the apples depend on the seed and the count eaten. */
  rng: number;
  heading: Heading;
  /** Head first, tail last. */
  body: Cell[];
  apple: Cell | null;
  apples: number;
  steps: number;
  sinceApple: number;
  over: End | null;
}

export const HEADINGS: readonly Heading[] = ['up', 'right', 'down', 'left'];
const VEC: Record<Heading, Cell> = { up: { x: 0, y: -1 }, right: { x: 1, y: 0 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 } };

export const isMove = (v: unknown): v is Move => v === 'left' || v === 'straight' || v === 'right';
export const isHeading = (v: unknown): v is Heading => HEADINGS.includes(v as Heading);

/** The heading after a move. */
export function turn(heading: Heading, move: Move): Heading {
  const i = HEADINGS.indexOf(heading);
  return move === 'straight' ? heading : HEADINGS[(i + (move === 'right' ? 1 : 3)) % 4]!;
}

/** The move that turns `from` toward the absolute direction `to`, or null for a U-turn (the player's keys). */
export function moveToward(from: Heading, to: Heading): Move | null {
  return MOVES.find((m) => turn(from, m) === to) ?? null;
}

export const add = (c: Cell, h: Heading): Cell => ({ x: c.x + VEC[h].x, y: c.y + VEC[h].y });
export const inside = (c: Cell): boolean => c.x >= 0 && c.y >= 0 && c.x < SIZE && c.y < SIZE;
export const same = (a: Cell, b: Cell): boolean => a.x === b.x && a.y === b.y;

/**
 * mulberry32 (Tommy Ettinger's 32-bit PRNG), as a step on its state: the next number in [0, 1) and the next state.
 * Kept as plain numbers so a game state stays a plain, copyable value.
 */
export function mulberry32(state: number): [number, number] {
  const a = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, a];
}

/** The next apple: a free cell (row by row, top left first) picked by the PRNG; null when the board is full. */
export function placeApple(body: readonly Cell[], rng: number): [Cell | null, number] {
  const taken = new Set(body.map((c) => c.y * SIZE + c.x));
  const free: Cell[] = [];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (!taken.has(y * SIZE + x)) free.push({ x, y });
  if (!free.length) return [null, rng];
  const [r, next] = mulberry32(rng);
  return [free[Math.floor(r * free.length)]!, next];
}

/** A new game: the snake, 3 long, in the middle heading right, and the first apple. */
export function createGame(seed: number): GameState {
  const mid = SIZE / 2;
  const body = Array.from({ length: START_LENGTH }, (_, i) => ({ x: mid - i, y: mid }));
  const [apple, rng] = placeApple(body, seed | 0);
  return { seed, rng, heading: 'right', body, apple, apples: 0, steps: 0, sinceApple: 0, over: null };
}

/**
 * One step: the snake turns (or not) and moves a cell. Moving into the cell the tail leaves this step is allowed; an
 * apple grows the snake by one (the tail stays) and places the next. Returns the new state; a game over stays as is.
 */
export function step(s: GameState, move: Move): GameState {
  if (s.over) return s;
  const heading = turn(s.heading, move);
  const next = add(s.body[0]!, heading);
  const steps = s.steps + 1;
  if (!inside(next)) return { ...s, heading, steps, over: 'wall' };
  const eats = s.apple !== null && same(next, s.apple);
  const kept = eats ? s.body : s.body.slice(0, -1);
  if (kept.some((c) => same(c, next))) return { ...s, heading, steps, over: 'body' };
  const body = [next, ...kept];
  let { apple, rng, apples } = s;
  let sinceApple = s.sinceApple + 1;
  if (eats) {
    apples += 1;
    sinceApple = 0;
    [apple, rng] = placeApple(body, rng);
  }
  const over: End | null = eats && !apple ? 'full' : sinceApple >= STARVE_STEPS ? 'starved' : steps >= MAX_STEPS ? 'steps' : null;
  return { seed: s.seed, rng, heading, body, apple, apples, steps, sinceApple, over };
}

/** Replays `moves` from the seed (stopping at game over) and returns the final state. */
export function replay(seed: number, moves: Iterable<Move>): GameState {
  let s = createGame(seed);
  for (const m of moves) {
    if (s.over) break;
    s = step(s, m);
  }
  return s;
}
