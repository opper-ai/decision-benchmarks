import type { GameState, Side } from './engine/engine.ts';
import type { MoveId } from './engine/moves.ts';
import type { Question } from './question.ts';

export interface Answer {
  move: MoveId;
  /** Probability per offered move, summing to 1. Null when the model gave none (uncalibrated). */
  probabilities: Partial<Record<MoveId, number>> | null;
  latencyMs: number;
  costUsd: number | null;
  inputTokens?: number;
  traceId?: string | null;
}

export interface Adapter {
  id: string;
  kind: 'systemone' | 'decisions' | 'chat' | 'baseline' | 'human' | 'remote';
  warmUp(): Promise<void>;
  /** `view` is the state the question describes (only in-process baselines use it). */
  decide(q: Question, signal: AbortSignal, view?: GameState): Promise<Answer>;
  /** A human player: no questions, the match reads this whenever the fighter is free to act. */
  human?: HumanInput;
  /**
   * A scripted player on a fixed thinking time (the benchmark's baselines): asked as a model is (ahead, by its
   * latency, one question at a time), but its answer comes exactly `delayTicks` frames after it was asked, computed by
   * `decide`, with no clock. Deterministic, so a recording's moves for it can be recomputed (ScriptedPlayer).
   */
  scripted?: { decide: (q: Question, view: GameState) => Answer; delayTicks: number };
}

export interface HumanInput {
  /**
   * The move the player wants now, if any, and when they asked for it (performance.now() time).
   * `consume` takes a pressed key out of the buffer; false only looks.
   */
  next(s: GameState, i: Side, consume: boolean): { move: MoveId; at: number } | null;
}

/** The model answered, but not with one of the offered moves. */
export class InvalidAnswer extends Error {
  override name = 'InvalidAnswer';
}

/** Clamp to >= 0 over the offered moves and normalise. Null if nothing usable. */
export function normalise(raw: unknown, offered: MoveId[]): Partial<Record<MoveId, number>> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out: Partial<Record<MoveId, number>> = {};
  let sum = 0;
  for (const m of offered) {
    const v = Number(r[m]);
    const p = Number.isFinite(v) && v > 0 ? v : 0;
    out[m] = p;
    sum += p;
  }
  if (sum <= 0) return null;
  for (const m of offered) out[m] = out[m]! / sum;
  return out;
}

export function confidenceOf(a: Answer): number | null {
  return a.probabilities ? (a.probabilities[a.move] ?? 0) : null;
}
