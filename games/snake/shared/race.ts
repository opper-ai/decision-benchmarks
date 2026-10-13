// The page's race (you against an AI) in real time: both boards step together on one clock, at the speed the visitor
// picks. The AI is asked about the board as soon as its last step is applied; an answer that has arrived by the tick
// moves the snake, and one that hasn't is too late, so the game's fallback moves it instead (the same rule playSnake
// uses for a late or failed answer). One request is in flight at a time: while a stale one is still out, the next
// question waits for it to come back. The benchmark never plays this way (playSnake is paused); this is only the page.
// Isomorphic, so it can be tested without a page.
import { askPaused } from '../../../packages/kit/client/scheduler.ts';
import type { Transport } from '../../../packages/kit/shared/systemone.ts';
import { createGame, step, type GameState } from './engine.ts';
import { resultOf, SNAKE_SCHEDULER, stepKey, type SnakeDecision, type SnakePoint } from './play.ts';
import { PLAYER_STEP_MS } from './player-check.ts';
import type { SnakeResult, Step } from './recording.ts';

export type RaceSpeed = 'relaxed' | 'normal' | 'fast';
export const RACE_SPEEDS: readonly RaceSpeed[] = ['relaxed', 'normal', 'fast'];
export const DEFAULT_SPEED: RaceSpeed = 'normal';
/** Milliseconds between steps. Fast is the fastest the high-score check allows for. */
export const SPEED_STEP_MS: Record<RaceSpeed, number> = { relaxed: 400, normal: 250, fast: PLAYER_STEP_MS };
export const SPEED_NAMES: Record<RaceSpeed, string> = { relaxed: 'Relaxed', normal: 'Normal', fast: 'Fast' };
export const isRaceSpeed = (v: unknown): v is RaceSpeed => RACE_SPEEDS.includes(v as RaceSpeed);

export interface RealtimeSnakeOptions {
  transport: Transport;
  seed: number;
  /** The model a request names (the page's; a baseline's transport needs none). */
  requestModel?: string;
  /** How long one request may take before askPaused gives up on it (a late answer falls back at the tick anyway). */
  timeoutMs: number;
  now?: () => number;
}

/** An open question: the step it is for, and its decision once the answer (or askPaused's fallback) is in. */
interface Pending {
  key: string;
  decision: SnakeDecision | null;
  latencyMs?: number;
  costUsd?: number;
}

/** The AI's side of a real-time race. The caller's clock calls tick(); the answers come in between ticks. */
export class RealtimeSnake {
  state: GameState;
  readonly steps: Step[] = [];
  /** Every call's cost, the stale ones' too. */
  costUsd = 0;
  /** Requests sent so far. */
  requests = 0;
  private pending: Pending | null = null;
  /** The request in flight (at most one). */
  private busy = false;
  /** A question is waiting for the request in flight to come back. */
  private waiting = false;
  private stopped = false;
  private readonly o: RealtimeSnakeOptions;

  constructor(o: RealtimeSnakeOptions) {
    this.o = o;
    this.state = createGame(o.seed);
    this.ask();
  }

  get over(): boolean {
    return this.state.over !== null;
  }

  /** Asks about the board as it is now, or once the request in flight comes back. */
  private ask(): void {
    if (this.stopped || this.over) return;
    if (this.busy) {
      this.waiting = true;
      return;
    }
    const slot: Pending = { key: stepKey(this.state), decision: null };
    this.pending = slot;
    this.busy = true;
    this.requests += 1;
    const settle = () => {
      this.busy = false;
      if (this.waiting) {
        this.waiting = false;
        this.ask();
      }
    };
    const transport: Transport = (body) => {
      const p = this.o.transport(body);
      void p.then(settle, settle);
      return p;
    };
    void askPaused(SNAKE_SCHEDULER, this.state, [{ key: slot.key, actor: 'snake' } satisfies SnakePoint], {
      transport,
      now: this.o.now ?? (() => performance.now()),
      timeoutMs: this.o.timeoutMs,
      ...(this.o.requestModel ? { model: this.o.requestModel } : {}),
      onEvent: (e) => {
        if (e.type !== 'call') return;
        slot.latencyMs = Math.max(0, Math.round(e.latencyMs));
        if (typeof e.costUsd === 'number' && Number.isFinite(e.costUsd) && e.costUsd > 0) {
          slot.costUsd = e.costUsd;
          this.costUsd += e.costUsd;
        }
      },
    }).then(([d]) => {
      slot.decision = d!;
    });
  }

  /** One step on the clock: the answer for this board if it is in, else the fallback. Null once the game is over. */
  tick(): Step | null {
    if (this.stopped || this.over) return null;
    const key = stepKey(this.state);
    const slot = this.pending?.key === key ? this.pending : null;
    this.pending = null;
    let rec: Step;
    if (slot?.decision) {
      const d = slot.decision;
      rec = { choice: d.choice, source: d.source };
      if (d.source === 'model') {
        if (slot.latencyMs !== undefined) rec.latencyMs = slot.latencyMs;
        if (slot.costUsd !== undefined) rec.costUsd = slot.costUsd;
        if (d.probabilities) rec.probabilities = d.probabilities;
        if (d.sig) rec.sig = d.sig;
      }
    } else {
      const point: SnakePoint = { key, actor: 'snake' };
      rec = { choice: SNAKE_SCHEDULER.fallback(this.state, SNAKE_SCHEDULER.prepare(this.state, point), 'late').choice, source: 'fallback' };
    }
    this.state = step(this.state, rec.choice);
    this.steps.push(rec);
    this.ask();
    return rec;
  }

  /** Steps that used the fallback (late, failed or unusable answers). */
  get fallbacks(): number {
    return this.steps.filter((s) => s.source === 'fallback').length;
  }

  result(): SnakeResult {
    return resultOf(this.state, this.steps);
  }

  /** No more questions; answers still out are ignored. */
  stop(): void {
    this.stopped = true;
    this.pending = null;
  }
}

/**
 * The race's one clock: calls onTick every stepMs until it returns false or the returned stop is called. Both boards
 * step inside the same onTick, so neither can run ahead of the other.
 */
export function startClock(stepMs: number, onTick: () => boolean): () => void {
  const timer = setInterval(() => {
    if (!onTick()) clearInterval(timer);
  }, stepMs);
  return () => clearInterval(timer);
}
