// The recorded games Watch plays (public/demo/), one per player: the baselines now, each decision model's with the
// official run. Watch plays recordings only: no live model game ever runs for a visitor who did not ask to play.
import { isMove, replay, type GameState, type Move } from '../shared/engine.ts';

export interface DemoEntry {
  model: string;
  name: string;
  path: string;
}

/** Chip order under the board: the first plays when the page opens. */
export const RECORDINGS: readonly DemoEntry[] = [
  { model: 'baseline/flood', name: 'Flood fill', path: 'demo/flood.json' },
  { model: 'baseline/greedy', name: 'Greedy', path: 'demo/greedy.json' },
  { model: 'baseline/random', name: 'Random', path: 'demo/random.json' },
];

export interface Demo {
  seed: number;
  moves: Move[];
  /** The game's final state (its apples, for the chip). */
  final: GameState;
}

/** A recording's seed and moves, if it replays to the game it claims; anything else is not shown. */
export function demoFrom(raw: unknown): Demo | null {
  const r = raw as { game?: unknown; seed?: unknown; steps?: unknown; result?: { score?: unknown } } | null;
  if (!r || r.game !== 'snake' || !Number.isInteger(r.seed) || !Array.isArray(r.steps)) return null;
  const moves = r.steps.map((s) => (s as { choice?: unknown })?.choice);
  if (!moves.every(isMove)) return null;
  const final = replay(r.seed as number, moves as Move[]);
  return final.over && final.apples === r.result?.score ? { seed: r.seed as number, moves: moves as Move[], final } : null;
}

export async function loadDemo(url: string): Promise<Demo | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return res.ok ? demoFrom(await res.json()) : null;
  } catch {
    return null;
  }
}
