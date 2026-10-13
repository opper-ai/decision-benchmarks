// Snake's question (SPEC.md, "Questions"): one System One `choice` per step, named `snake`, whose options are the three
// directions the head can move (up, right, down, left without the reverse), in a shuffled order. Every one is offered,
// a deadly one too. The state is the board as text; each option states facts about the move (what is in the next cell,
// the distance to the apple, the room left from there), never which move is good. The engine plays relative moves
// (left, straight, right): an answer's direction maps back with moveToward, so recordings keep L/S/R. Everything is computed from a View, the
// board as the question shows it, so the page, the bench, the service's request check and the baselines word and read
// a question the same way. Isomorphic and Node-safe.
import { add, HEADINGS, inside, isHeading, moveToward, MOVES, same, SIZE, STARVE_STEPS, MAX_STEPS, turn, type Cell, type GameState, type Heading, type Move } from './engine.ts';
import type { ChoiceQuestion, SystemOneRequest } from '../../../packages/kit/shared/systemone.ts';

export const QUESTION = 'snake';

/**
 * The board as a question shows it: SIZE rows of SIZE cells, `H` head, `n` neck (the body cell right behind the head),
 * `o` body, `t` tail, `A` apple, `.` empty. The heading is not shown: it is the way from the neck to the head.
 */
export interface View {
  rows: string[];
  heading: Heading;
  length: number;
  sinceApple: number;
  step: number;
  head: Cell;
  apple: Cell | null;
}

/** What a move leads to, as an option states it. */
export interface Facts {
  move: Move;
  heading: Heading;
  next: 'empty' | 'apple' | 'tail' | 'wall' | 'body';
  /** Wall or body: the game ends. */
  deadly: boolean;
  /** Manhattan distance from the next cell to the apple (null: no apple, or deadly). */
  distance: number | null;
  /** Cells the head could still reach from the next cell after the move (0 when deadly). */
  reachable: number;
}

export const INSTRUCTIONS =
  'You steer a snake on a 16 by 16 board, one cell per step. Pick the direction the head moves next (it cannot reverse). ' +
  'Eating the apple scores 1 and makes the snake one longer. The game ends when the head leaves the board or runs into the snake (the tail cell is free: the tail moves on this step), ' +
  `after ${STARVE_STEPS} steps without an apple, or after ${MAX_STEPS} steps. ` +
  'The board, top row first: # wall, H head, n neck (the body cell joined to the head), o body, t tail, A apple, . empty. Up is toward the top row. Eat as many apples as you can.';

/** The View of a game state. */
export function viewOf(s: GameState): View {
  const grid = Array.from({ length: SIZE }, () => Array<string>(SIZE).fill('.'));
  if (s.apple) grid[s.apple.y]![s.apple.x] = 'A';
  s.body.forEach((c, i) => {
    if (inside(c)) grid[c.y]![c.x] = i === 0 ? 'H' : i === s.body.length - 1 ? 't' : i === 1 ? 'n' : 'o';
  });
  return { rows: grid.map((r) => r.join('')), heading: s.heading, length: s.body.length, sinceApple: s.sinceApple, step: s.steps, head: s.body[0]!, apple: s.apple };
}

const at = (v: View, c: Cell): string => (inside(c) ? v.rows[c.y]![c.x]! : '#');

/** The facts of one move from a View. */
export function factsOf(v: View, move: Move): Facts {
  const heading = turn(v.heading, move);
  const next = add(v.head, heading);
  const ch = at(v, next);
  const kind: Facts['next'] = ch === '#' ? 'wall' : ch === 'o' || ch === 'n' || ch === 'H' ? 'body' : ch === 't' ? 'tail' : ch === 'A' ? 'apple' : 'empty';
  const deadly = kind === 'wall' || kind === 'body';
  if (deadly) return { move, heading, next: kind, deadly, distance: null, reachable: 0 };
  const distance = v.apple ? Math.abs(next.x - v.apple.x) + Math.abs(next.y - v.apple.y) : null;
  return { move, heading, next: kind, deadly, distance, reachable: reachableFrom(v, next, kind === 'apple') };
}

export const allFacts = (v: View): Facts[] => MOVES.map((m) => factsOf(v, m));

/**
 * Flood fill after the move: the old head becomes body, the tail leaves its cell unless the snake grows. Counts the
 * cells the new head can reach, itself not included.
 */
function reachableFrom(v: View, from: Cell, grows: boolean): number {
  const blocked = (c: Cell) => {
    const ch = at(v, c);
    return ch === '#' || ch === 'o' || ch === 'n' || ch === 'H' || (ch === 't' && grows);
  };
  const seen = new Set<number>([from.y * SIZE + from.x]);
  const queue: Cell[] = [from];
  let n = 0;
  while (queue.length) {
    const c = queue.pop()!;
    for (const h of ['up', 'right', 'down', 'left'] as const) {
      const d = add(c, h);
      const k = d.y * SIZE + d.x;
      if (!inside(d) || seen.has(k) || blocked(d)) continue;
      seen.add(k);
      n += 1;
      queue.push(d);
    }
  }
  return n;
}

/** The fallback (timeout, error, invalid answer): straight unless deadly, else the first of left and right that isn't, else straight. */
export function fallbackMove(facts: readonly Facts[]): Move {
  const of = (m: Move) => facts.find((f) => f.move === m)!;
  if (!of('straight').deadly) return 'straight';
  return (['left', 'right'] as const).find((m) => !of(m).deadly) ?? 'straight';
}

/** Where the apple is from the head, in board directions: "3 up and 2 left of the head", "4 right of the head". */
export function applePosition(v: View): string {
  if (!v.apple) return 'none';
  const dx = v.apple.x - v.head.x;
  const dy = v.apple.y - v.head.y;
  const parts = [dy < 0 ? `${-dy} up` : dy > 0 ? `${dy} down` : '', dx < 0 ? `${-dx} left` : dx > 0 ? `${dx} right` : ''].filter(Boolean);
  return `${parts.join(' and ')} of the head`;
}

const NEXT_TEXT: Record<Facts['next'], string> = {
  empty: 'empty',
  apple: 'the apple',
  tail: 'the tail, which moves on this step',
  wall: 'the wall',
  body: "the snake's body",
};

/** One option's text: facts only, and plainly that a deadly move ends the game. */
export function criterion(f: Facts, length: number): string {
  const parts = [`Go ${f.heading}: Next cell: ${NEXT_TEXT[f.next]}.`];
  if (f.deadly) parts.push('The game ends.');
  else {
    if (f.distance !== null) parts.push(`Distance to the apple after the move: ${f.distance}.`);
    parts.push(`Cells reachable from there: ${f.reachable} (the snake is ${length + (f.next === 'apple' ? 1 : 0)} long after the move).`);
  }
  return parts.join(' ');
}

/**
 * The options' order for a View: shuffled per step, so no position (first, middle) means anything. Deterministic from
 * what the request itself shows (the step, the head and the apple), so the bench, the page and the service's request
 * check put them in the same order; the apple's place comes from the game's seed.
 */
export function optionOrder(v: View): Facts[] {
  const fs = allFacts(v);
  let h = Math.imul(v.step + 1, 0x9e3779b1) ^ Math.imul(v.head.y * SIZE + v.head.x + 1, 0x85ebca6b) ^ Math.imul(v.apple ? v.apple.y * SIZE + v.apple.x + 1 : 0, 0xc2b2ae35);
  for (let i = fs.length - 1; i > 0; i--) {
    h = (Math.imul(h, 1103515245) + 12345) >>> 0;
    const j = (h >>> 16) % (i + 1);
    [fs[i], fs[j]] = [fs[j]!, fs[i]!];
  }
  return fs;
}

/** The question for a View: one option per direction the head can move, keyed by that direction. */
export function questionFor(v: View): ChoiceQuestion {
  return { type: 'choice', instructions: INSTRUCTIONS, criteria: Object.fromEntries(optionOrder(v).map((f) => [f.heading, criterion(f, v.length)])) };
}

/** The move an answered direction makes (null for a direction that isn't an option: the reverse, or no direction). */
export const moveFor = (v: Pick<View, 'heading'>, direction: unknown): Move | null => (isHeading(direction) ? moveToward(v.heading, direction) : null);

/**
 * The request's state for a View: the board with its walls and the numbers the board does not show. No heading: a
 * heading word drew models to answer it (straight on into the wall); the neck on the board gives it to anyone who
 * needs it.
 */
export function stateFor(v: View): Record<string, unknown> {
  const wall = '#'.repeat(SIZE + 2);
  return {
    board: [wall, ...v.rows.map((r) => `#${r}#`), wall],
    length: v.length,
    apple: applePosition(v),
    stepsSinceApple: v.sinceApple,
    step: v.step,
  };
}

/** The request body (state and question) for a View. */
export const requestFor = (v: View): Pick<SystemOneRequest, 'state' | 'questions'> => ({ state: stateFor(v), questions: { [QUESTION]: questionFor(v) } });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const intIn = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/**
 * A request's state read back into a View, or null unless it is exactly what `stateFor` writes for some board: the
 * service's request check and the baselines read requests with it.
 */
export function parseState(state: unknown): View | null {
  if (!isObj(state)) return null;
  const keys = Object.keys(state).sort().join(',');
  if (keys !== 'apple,board,length,step,stepsSinceApple') return null;
  const { board } = state;
  if (!Array.isArray(board) || board.length !== SIZE + 2 || !board.every((r) => typeof r === 'string' && r.length === SIZE + 2)) return null;
  const wall = '#'.repeat(SIZE + 2);
  if (board[0] !== wall || board[SIZE + 1] !== wall) return null;
  const rows: string[] = [];
  let head: Cell | null = null;
  let neck: Cell | null = null;
  let necks = 0;
  let apple: Cell | null = null;
  let heads = 0;
  let tails = 0;
  let apples = 0;
  let body = 0;
  for (let y = 0; y < SIZE; y++) {
    const r = board[y + 1] as string;
    if (r[0] !== '#' || r[SIZE + 1] !== '#') return null;
    const inner = r.slice(1, SIZE + 1);
    if (!/^[Hnot.A]+$/.test(inner)) return null;
    for (let x = 0; x < SIZE; x++) {
      const ch = inner[x];
      if (ch === 'H') {
        heads += 1;
        head = { x, y };
      } else if (ch === 'A') {
        apples += 1;
        apple = { x, y };
      } else if (ch === 'n') {
        necks += 1;
        neck = { x, y };
      } else if (ch === 't') tails += 1;
      else if (ch === 'o') body += 1;
    }
    rows.push(inner);
  }
  if (heads !== 1 || necks !== 1 || tails !== 1 || apples > 1) return null;
  // The heading is the way from the neck to the head, which must be next to each other.
  const heading = HEADINGS.find((h) => same(add(neck!, h), head!));
  if (!heading) return null;
  const length = body + 3;
  if (state.length !== length || !intIn(state.stepsSinceApple, 0, STARVE_STEPS - 1) || !intIn(state.step, 0, MAX_STEPS - 1)) return null;
  const v: View = { rows, heading, length, sinceApple: state.stepsSinceApple as number, step: state.step as number, head: head!, apple };
  return state.apple === applePosition(v) ? v : null;
}
