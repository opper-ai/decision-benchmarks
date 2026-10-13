// Snake's question (SPEC.md, "Questions"): one System One `choice` per step, named `snake`, options left, straight and
// right. The state is the board as text; each option states facts about the move (what is in the next cell, the
// distance to the apple, the room left from there), never which move is good. Everything is computed from a View, the
// board as the question shows it, so the page, the bench, the service's request check and the baselines word and read
// a question the same way. Isomorphic and Node-safe.
import { add, inside, isHeading, MOVES, SIZE, STARVE_STEPS, MAX_STEPS, turn, type Cell, type GameState, type Heading, type Move } from './engine.ts';
import type { ChoiceQuestion, SystemOneRequest } from '../../../packages/kit/shared/systemone.ts';

export const QUESTION = 'snake';

/** The board as a question shows it: SIZE rows of SIZE cells, `H` head, `o` body, `t` tail, `A` apple, `.` empty. */
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
  'You steer a snake on a 16 by 16 board, one cell per step: turn left, go straight or turn right, relative to the way it is heading. ' +
  'Eating the apple scores 1 and makes the snake one longer. The game ends when the head leaves the board or runs into the snake (the tail cell is free: the tail moves on this step), ' +
  `after ${STARVE_STEPS} steps without an apple, or after ${MAX_STEPS} steps. ` +
  'The board, top row first: # wall, H head, o body, t tail, A apple, . empty. Up is toward the top row. Eat as many apples as you can.';

/** The View of a game state. */
export function viewOf(s: GameState): View {
  const grid = Array.from({ length: SIZE }, () => Array<string>(SIZE).fill('.'));
  if (s.apple) grid[s.apple.y]![s.apple.x] = 'A';
  s.body.forEach((c, i) => {
    if (inside(c)) grid[c.y]![c.x] = i === 0 ? 'H' : i === s.body.length - 1 ? 't' : 'o';
  });
  return { rows: grid.map((r) => r.join('')), heading: s.heading, length: s.body.length, sinceApple: s.sinceApple, step: s.steps, head: s.body[0]!, apple: s.apple };
}

const at = (v: View, c: Cell): string => (inside(c) ? v.rows[c.y]![c.x]! : '#');

/** The facts of one move from a View. */
export function factsOf(v: View, move: Move): Facts {
  const heading = turn(v.heading, move);
  const next = add(v.head, heading);
  const ch = at(v, next);
  const kind: Facts['next'] = ch === '#' ? 'wall' : ch === 'o' || ch === 'H' ? 'body' : ch === 't' ? 'tail' : ch === 'A' ? 'apple' : 'empty';
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
    return ch === '#' || ch === 'o' || ch === 'H' || (ch === 't' && grows);
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

/** Where the apple is from the head, along the heading: "3 ahead and 2 to the left". */
export function applePosition(v: View): string {
  if (!v.apple) return 'none';
  const dx = v.apple.x - v.head.x;
  const dy = v.apple.y - v.head.y;
  const ahead = v.heading === 'up' ? -dy : v.heading === 'down' ? dy : v.heading === 'right' ? dx : -dx;
  const right = v.heading === 'up' ? dx : v.heading === 'down' ? -dx : v.heading === 'right' ? dy : -dy;
  const along = ahead > 0 ? `${ahead} ahead` : ahead < 0 ? `${-ahead} behind` : 'level with the head';
  const side = right > 0 ? `${right} to the right` : right < 0 ? `${-right} to the left` : 'straight in line';
  return `${along} and ${side}`;
}

const NEXT_TEXT: Record<Facts['next'], string> = {
  empty: 'empty',
  apple: 'the apple',
  tail: 'the tail, which moves on this step',
  wall: 'the wall',
  body: "the snake's body",
};

/** One option's text: facts only. */
export function criterion(f: Facts, length: number): string {
  const turnText = f.move === 'straight' ? `Keep heading ${f.heading}.` : `Turn ${f.move}, heading ${f.heading}.`;
  const parts = [turnText, `Next cell: ${NEXT_TEXT[f.next]}.`];
  if (!f.deadly) {
    if (f.distance !== null) parts.push(`Distance to the apple after the move: ${f.distance}.`);
    parts.push(`Cells reachable from there: ${f.reachable} (the snake is ${length + (f.next === 'apple' ? 1 : 0)} long after the move).`);
  }
  return parts.join(' ');
}

/** The question for a View. */
export function questionFor(v: View): ChoiceQuestion {
  const facts = allFacts(v);
  return { type: 'choice', instructions: INSTRUCTIONS, criteria: Object.fromEntries(facts.map((f) => [f.move, criterion(f, v.length)])) };
}

/** The request's state for a View: the board with its walls and the numbers the board does not show. */
export function stateFor(v: View): Record<string, unknown> {
  const wall = '#'.repeat(SIZE + 2);
  return {
    board: [wall, ...v.rows.map((r) => `#${r}#`), wall],
    heading: v.heading,
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
  if (keys !== 'apple,board,heading,length,step,stepsSinceApple') return null;
  const { board, heading } = state;
  if (!Array.isArray(board) || board.length !== SIZE + 2 || !board.every((r) => typeof r === 'string' && r.length === SIZE + 2)) return null;
  const wall = '#'.repeat(SIZE + 2);
  if (board[0] !== wall || board[SIZE + 1] !== wall) return null;
  const rows: string[] = [];
  let head: Cell | null = null;
  let apple: Cell | null = null;
  let heads = 0;
  let tails = 0;
  let apples = 0;
  let body = 0;
  for (let y = 0; y < SIZE; y++) {
    const r = board[y + 1] as string;
    if (r[0] !== '#' || r[SIZE + 1] !== '#') return null;
    const inner = r.slice(1, SIZE + 1);
    if (!/^[Hot.A]+$/.test(inner)) return null;
    for (let x = 0; x < SIZE; x++) {
      const ch = inner[x];
      if (ch === 'H') {
        heads += 1;
        head = { x, y };
      } else if (ch === 'A') {
        apples += 1;
        apple = { x, y };
      } else if (ch === 't') tails += 1;
      else if (ch === 'o') body += 1;
    }
    rows.push(inner);
  }
  if (heads !== 1 || tails !== 1 || apples > 1 || !isHeading(heading)) return null;
  const length = body + 2;
  if (state.length !== length || !intIn(state.stepsSinceApple, 0, STARVE_STEPS - 1) || !intIn(state.step, 0, MAX_STEPS - 1)) return null;
  const v: View = { rows, heading, length, sinceApple: state.stepsSinceApple as number, step: state.step as number, head: head!, apple };
  return state.apple === applePosition(v) ? v : null;
}
