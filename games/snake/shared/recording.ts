// What a benchmark game of Snake records, and the rules a recording is checked against (SPEC.md, "Recording and
// verify"). Isomorphic and Node-safe.
import type { GameResult } from '../../../packages/kit/shared/game.ts';
import type { End, Move } from './engine.ts';

/**
 * Bump when the rules, the question or the clock change: older submissions are then refused. 1: paused, up to 2 s per
 * answer. 2: real time, a step every 250 ms. 3: a step every 275 ms, and the question asks for an absolute direction.
 */
export const BENCH_VERSION = 3;

/**
 * One step: the move made, who made it (`fallback` when the answer was not in by the tick, failed or was unusable),
 * and the call behind it (when its answer came back, even too late).
 */
export interface Step {
  choice: Move;
  source: 'model' | 'fallback';
  probabilities?: Partial<Record<Move, number>>;
  latencyMs?: number;
  costUsd?: number;
  /** The server's signature on the answer (games played on the page; the bench has none). */
  sig?: string;
}

export interface Recording {
  format: 1;
  game: 'snake';
  benchVersion: number;
  seed: number;
  model: string;
  steps: Step[];
  /** What the game claims: the replay must end the same way. */
  result: { score: number; steps: number; end: End };
}

export interface SnakeResult extends GameResult {
  /** Steps played, and how the game ended. */
  steps: number;
  end: End;
}

/** Numbers per model for the leaderboard entry's `extra`: mean steps and how games ended. */
export function summarize(results: readonly SnakeResult[]): Record<string, number> {
  const n = Math.max(1, results.length);
  const share = (end: End) => Math.round((1000 * results.filter((r) => r.end === end).length) / n) / 1000;
  return {
    meanSteps: Math.round((10 * results.reduce((a, r) => a + r.steps, 0)) / n) / 10,
    wallShare: share('wall'),
    bodyShare: share('body'),
    starvedShare: share('starved'),
    capShare: share('steps'),
  };
}
