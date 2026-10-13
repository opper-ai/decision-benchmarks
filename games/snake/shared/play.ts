// One game of Snake played by a model in real time, on a fixed clock: a step every STEP_MS (250 ms), the benchmark's
// one speed for every model. The model is asked about the board as soon as its last step is applied, one request at
// a time; an answer that is in by the tick moves the snake, and one that isn't is too late, so the game's fallback
// moves it instead (stale answers are ignored). The score is decision quality and speed together. The bench plays it
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
  /** The step played for this question, once its tick came: a late call's latency and cost are kept on it. */
  step?: Step;
}

/** A model's side of a real-time game. The caller's clock calls tick(); the answers come in between ticks. */
export class RealtimeSnake {
  state: GameState;
  readonly steps: Step[] = [];
  /** Every call's cost, the stale ones' too. */
  costUsd = 0;
  /** Requests sent so far. */
  requests = 0;
  private pending: Pending | null = null;
  /** The request in flight (at most one). */
  private busy: Promise<unknown> | null = null;
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

  /** Resolves once no request is in flight (a late call's cost and latency are then on its step). */
  async settled(): Promise<void> {
    while (this.busy) await this.busy.then(
      () => {},
      () => {},
    );
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
    this.requests += 1;
    const settle = () => {
      this.busy = null;
      if (this.waiting) {
        this.waiting = false;
        this.ask();
      }
    };
    const transport: Transport = (body) => {
      const p = this.o.transport(body);
      this.busy = p;
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
        // Too late for its step, which the fallback played: the call still took this long and cost this much.
        if (slot.step) callOn(slot.step, slot);
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
      callOn(rec, slot);
      if (d.source === 'model') {
        if (d.probabilities) rec.probabilities = d.probabilities;
        if (d.sig) rec.sig = d.sig;
      }
    } else {
      const point: SnakePoint = { key, actor: 'snake' };
      rec = { choice: SNAKE_SCHEDULER.fallback(this.state, SNAKE_SCHEDULER.prepare(this.state, point), 'late').choice, source: 'fallback' };
      if (slot) slot.step = rec;
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

/** Puts a call's latency and cost on the step it was for. */
function callOn(rec: Step, slot: Pending): void {
  if (slot.latencyMs !== undefined) rec.latencyMs = slot.latencyMs;
  if (slot.costUsd !== undefined) rec.costUsd = slot.costUsd;
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
  /** How long one call may take before it is given up on (its step has long fallen back by then). */
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
  // The game ends only once the late calls are in: their cost and latency still count.
  await ai.settled();
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
