// One game of Snake played by a model, paused: each step asks the model one question through the kit's askPaused and
// waits for the answer, at most the timeout (2 s from sending), then the game's fallback decides. The bench plays it
// as fast as answers come; the page plays it at most one step every 120 ms, so it can be watched. Isomorphic.
import { askPaused, type BaseDecision, type SchedulerEvent, type SchedulerGame } from '../../../packages/kit/client/scheduler.ts';
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

export interface PlayOptions {
  transport: Transport;
  seed: number;
  /** The id the recording names the model by. */
  model: string;
  /** The model a request names (the page's; the bench's transports are bound to their model already). */
  requestModel?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** At least this long between steps (the page: 120 ms, so the game can be watched). */
  minStepMs?: number;
  /** After every step, with the state and the step just recorded. */
  onStep?: (state: GameState, step: Step) => void;
  onEvent?: (e: SchedulerEvent<SnakeDecision>) => void;
  now?: () => number;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Plays one game to its end and returns the result and the recording the submissions check replays. */
export async function playSnake(o: PlayOptions): Promise<{ result: SnakeResult; recording: Recording }> {
  const now = o.now ?? (() => performance.now());
  // Every call, so the game ends only once the late ones are in (their cost and latency still count).
  const inFlight = new Set<Promise<unknown>>();
  const transport: Transport = (body) => {
    const p = o.transport(body);
    inFlight.add(p);
    void p.then(
      () => inFlight.delete(p),
      () => inFlight.delete(p),
    );
    return p;
  };
  let state = createGame(o.seed);
  const steps: Step[] = [];
  while (!state.over) {
    if (o.signal?.aborted) throw new Error('the game was stopped');
    const started = now();
    const rec: Step = { choice: 'straight', source: 'fallback' };
    const [d] = await askPaused(SNAKE_SCHEDULER, state, [{ key: stepKey(state), actor: 'snake' }], {
      transport,
      now,
      timeoutMs: o.timeoutMs,
      ...(o.requestModel ? { model: o.requestModel } : {}),
      onEvent: (e) => {
        if (e.type === 'call') {
          rec.latencyMs = Math.max(0, Math.round(e.latencyMs));
          if (typeof e.costUsd === 'number' && Number.isFinite(e.costUsd) && e.costUsd > 0) rec.costUsd = e.costUsd;
        }
        o.onEvent?.(e);
      },
    });
    rec.choice = d!.choice;
    rec.source = d!.source;
    if (d!.probabilities) rec.probabilities = d!.probabilities;
    if (d!.sig) rec.sig = d!.sig;
    const wait = (o.minStepMs ?? 0) - (now() - started);
    if (wait > 0) await sleep(wait);
    if (o.signal?.aborted) throw new Error('the game was stopped');
    state = step(state, rec.choice);
    steps.push(rec);
    o.onStep?.(state, rec);
  }
  await Promise.allSettled([...inFlight]);
  const recording: Recording = { format: 1, game: 'snake', benchVersion: BENCH_VERSION, seed: o.seed, model: o.model, steps, result: { score: state.apples, steps: state.steps, end: state.over } };
  return { result: resultOf(state, steps), recording };
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
