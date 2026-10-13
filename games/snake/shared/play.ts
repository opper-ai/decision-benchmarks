// One game of Snake played by a model in real time, on a fixed clock: a step every STEP_MS (250 ms), the benchmark's
// one speed for every model. The model is asked about the board as soon as its last step is applied, one request at
// a time, so every step gives it a fresh, full 250 ms. An answer that is in by the tick moves the snake; if the tick
// comes first, the request is cancelled and the game's fallback moves the snake instead. The score is decision quality and speed together. The bench plays it
// headless with real timers (playSnake); the page's race steps a RealtimeSnake on its own clock next to your board.
// Isomorphic.
import { askPaused, type BaseDecision, type SchedulerGame } from '../../../packages/kit/client/scheduler.ts';
import { parseChoice, type Transport } from '../../../packages/kit/shared/systemone.ts';
import { createGame, MOVES, step, type GameState, type Move } from './engine.ts';
import { allFacts, fallbackMove, QUESTION, requestFor, viewOf, type Facts } from './questions.ts';
import { BENCH_VERSION, type Recording, type SnakeResult, type Step } from './recording.ts';

export interface SnakePoint {
  key: string;
  actor: 'snake';
}

interface SnakeQuestion {
  point: SnakePoint;
  facts: Facts[];
}

export interface SnakeDecision extends BaseDecision {
  choice: Move;
  source: 'model' | 'fallback';
  probabilities?: Partial<Record<Move, number>>;
}

/** Snake as the kit's scheduler sees it. */
export const SNAKE_SCHEDULER: Pick<SchedulerGame<GameState, SnakePoint, SnakeQuestion, SnakeDecision>, 'prepare' | 'name' | 'build' | 'parse' | 'fallback'> = {
  prepare: (s, point) => ({ point, facts: allFacts(viewOf(s)) }),
  name: () => QUESTION,
  build: (s) => requestFor(viewOf(s)),
  parse(answer) {
    const p = parseChoice(answer, MOVES);
    if (!p) return null;
    return { choice: p.choice, source: 'model', ...(Object.keys(p.probabilities).length ? { probabilities: p.probabilities } : {}) };
  },
  fallback: (_s, q) => ({ choice: fallbackMove(q.facts), source: 'fallback' }),
};

/** The question key of a step: what the server signs an answer for. */
export const stepKey = (s: GameState): string => `s${s.steps}`;

/** The benchmark's clock: a step every 250 ms, for every model (the race's Normal speed). */
export const STEP_MS = 250;

export interface RealtimeSnakeOptions {
  transport: Transport;
  seed: number;
  /** The model a request names (the page's; the bench's transports and a baseline's need none). */
  requestModel?: string;
  /** How long one request may take before askPaused gives up on it (the tick cancels it long before). */
  timeoutMs: number;
  now?: () => number;
}

/** An open question: the step it is for, its request, and its decision once the answer (or askPaused's fallback) is in. */
interface Pending {
  key: string;
  decision: SnakeDecision | null;
  /** Cancels the request when its step passes without an answer. */
  abort: AbortController;
  sentAt: number;
  latencyMs?: number;
  costUsd?: number;
  /** The step the fallback played for it, once the request was cancelled. */
  step?: Step;
}

/**
 * A model's side of a real-time game. The caller's clock calls tick(); the answers come in between ticks. Every step
 * gives the model a fresh, full step's time: the question is asked as soon as the previous step is applied, and if the
 * tick comes first, the request is cancelled and the fallback moves the snake. One request is in flight at a time.
 */
export class RealtimeSnake {
  state: GameState;
  readonly steps: Step[] = [];
  /** Every answered call's cost (a cancelled call's cost is unknown; see estimateCancelledCosts). */
  costUsd = 0;
  /** Requests sent so far, and how many of them were cancelled at the tick. */
  requests = 0;
  cancelled = 0;
  private pending: Pending | null = null;
  /** The steps the fallback played for a cancelled request. */
  private readonly cancelledSteps = new Set<Step>();
  private stopped = false;
  private readonly o: RealtimeSnakeOptions;
  private readonly now: () => number;

  constructor(o: RealtimeSnakeOptions) {
    this.o = o;
    this.now = o.now ?? (() => performance.now());
    this.state = createGame(o.seed);
    this.ask();
  }

  get over(): boolean {
    return this.state.over !== null;
  }

  /** Asks about the board as it is now. */
  private ask(): void {
    if (this.stopped || this.over) return;
    const slot: Pending = { key: stepKey(this.state), decision: null, abort: new AbortController(), sentAt: this.now() };
    this.pending = slot;
    this.requests += 1;
    const transport: Transport = (body) => this.o.transport(body, { signal: slot.abort.signal });
    void askPaused(SNAKE_SCHEDULER, this.state, [{ key: slot.key, actor: 'snake' } satisfies SnakePoint], {
      transport,
      now: this.now,
      timeoutMs: this.o.timeoutMs,
      ...(this.o.requestModel ? { model: this.o.requestModel } : {}),
      onEvent: (e) => {
        if (e.type !== 'call') return;
        const cost = typeof e.costUsd === 'number' && Number.isFinite(e.costUsd) && e.costUsd > 0 ? e.costUsd : undefined;
        if (cost !== undefined) this.costUsd += cost;
        // A transport that couldn't cancel answered after all: its step has passed, but its cost is known now.
        if (slot.step) {
          if (cost !== undefined) slot.step.costUsd = cost;
          return;
        }
        slot.latencyMs = Math.max(0, Math.round(e.latencyMs));
        if (cost !== undefined) slot.costUsd = cost;
      },
    }).then(([d]) => {
      slot.decision = d!;
    });
  }

  /**
   * One step on the clock: the answer for this board if it is in, else the request is cancelled and the fallback
   * moves the snake. Then the next question goes out at once. Null once the game is over.
   */
  tick(): Step | null {
    if (this.stopped || this.over) return null;
    const key = stepKey(this.state);
    const slot = this.pending?.key === key ? this.pending : null;
    this.pending = null;
    let rec: Step;
    if (slot?.decision) {
      const d = slot.decision;
      rec = { choice: d.choice, source: d.source };
      if (slot.latencyMs !== undefined) rec.latencyMs = slot.latencyMs;
      if (slot.costUsd !== undefined) rec.costUsd = slot.costUsd;
      if (d.source === 'model') {
        if (d.probabilities) rec.probabilities = d.probabilities;
        if (d.sig) rec.sig = d.sig;
      }
    } else {
      const point: SnakePoint = { key, actor: 'snake' };
      rec = { choice: SNAKE_SCHEDULER.fallback(this.state, SNAKE_SCHEDULER.prepare(this.state, point), 'late').choice, source: 'fallback' };
      if (slot) {
        // Too late: the call is cancelled and no longer counts as in flight. It took the whole step.
        rec.latencyMs = Math.max(0, Math.round(this.now() - slot.sentAt));
        slot.step = rec;
        slot.abort.abort();
        this.cancelled += 1;
        this.cancelledSteps.add(rec);
      }
    }
    this.state = step(this.state, rec.choice);
    this.steps.push(rec);
    this.ask();
    return rec;
  }

  /**
   * A cancelled call's cost is unknown (no answer came back to say it), though the provider may still bill it: each
   * one is counted at the mean cost of this game's answered calls. With no answered call to go by, it stays unknown.
   */
  estimateCancelledCosts(): void {
    const known = this.steps.filter((s) => !this.cancelledSteps.has(s) && s.costUsd !== undefined);
    if (!known.length) return;
    const mean = known.reduce((a, s) => a + s.costUsd!, 0) / known.length;
    for (const s of this.cancelledSteps) if (s.costUsd === undefined) s.costUsd = mean;
  }

  /** Steps that used the fallback (late, failed or unusable answers). */
  get fallbacks(): number {
    return this.steps.filter((s) => s.source === 'fallback').length;
  }

  result(): SnakeResult {
    return resultOf(this.state, this.steps);
  }

  /** No more questions; the request still out is cancelled. */
  stop(): void {
    this.stopped = true;
    this.pending?.abort.abort();
    this.pending = null;
  }
}

/**
 * A clock: calls onTick every stepMs until it returns false or the returned stop is called. The race steps both
 * boards inside the same onTick, so neither can run ahead of the other.
 */
export function startClock(stepMs: number, onTick: () => boolean): () => void {
  const timer = setInterval(() => {
    if (!onTick()) clearInterval(timer);
  }, stepMs);
  return () => clearInterval(timer);
}

export interface PlayOptions {
  transport: Transport;
  seed: number;
  /** The id the recording names the model by. */
  model: string;
  /** The model a request names (the page's; the bench's transports are bound to their model already). */
  requestModel?: string;
  /** How long one call may take before it is given up on (the tick cancels it long before). */
  timeoutMs: number;
  /** Milliseconds between steps: STEP_MS for the benchmark; tests pass less. */
  stepMs?: number;
  signal?: AbortSignal;
  /** After every step, with the state and the step just recorded. */
  onStep?: (state: GameState, step: Step) => void;
  now?: () => number;
}

/** Plays one game to its end on the clock and returns the result and the recording the submissions check replays. */
export async function playSnake(o: PlayOptions): Promise<{ result: SnakeResult; recording: Recording }> {
  const stopped = () => new Error('the game was stopped');
  if (o.signal?.aborted) throw stopped();
  const ai = new RealtimeSnake({ transport: o.transport, seed: o.seed, timeoutMs: o.timeoutMs, ...(o.requestModel ? { requestModel: o.requestModel } : {}), ...(o.now ? { now: o.now } : {}) });
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      stop();
      ai.stop();
      reject(stopped());
    };
    const stop = startClock(o.stepMs ?? STEP_MS, () => {
      const rec = ai.tick();
      if (rec) o.onStep?.(ai.state, rec);
      if (!ai.over) return true;
      o.signal?.removeEventListener('abort', abort);
      resolve();
      return false;
    });
    o.signal?.addEventListener('abort', abort, { once: true });
  });
  // Nothing is left in flight: the game over leaves no question to ask.
  ai.stop();
  ai.estimateCancelledCosts();
  const state = ai.state;
  const recording: Recording = { format: 1, game: 'snake', benchVersion: BENCH_VERSION, seed: o.seed, model: o.model, steps: ai.steps, result: { score: state.apples, steps: state.steps, end: state.over! } };
  return { result: ai.result(), recording };
}

/** A game's result from its final state and recorded steps (the bench and the replay count the same way). */
export function resultOf(state: GameState, steps: readonly Step[]): SnakeResult {
  let calls = 0;
  let latencyMsSum = 0;
  let cost = 0;
  let fallbacks = 0;
  for (const s of steps) {
    if (s.latencyMs !== undefined) {
      calls += 1;
      latencyMsSum += s.latencyMs;
    }
    cost += s.costUsd ?? 0;
    if (s.source === 'fallback') fallbacks += 1;
  }
  return { score: state.apples, steps: state.steps, end: state.over ?? 'steps', calls, latencyMsSum, cost, decisions: steps.length, fallbacks };
}
