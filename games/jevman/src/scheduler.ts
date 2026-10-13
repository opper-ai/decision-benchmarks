import { RealtimeScheduler, type SchedulerEvent as KitEvent, type SchedulerGame } from '../../../packages/kit/client/scheduler.ts';
import type { DecideResponse, Transport } from '../../../packages/kit/shared/systemone.ts';
import { buildRequest, fallbackDecision, parseAnswer, questionName, type Decision, type PendingQuestion } from './brain.ts';
import { fruitRoute, optionFeatures } from './features.ts';
import { decisionPoints, type Controls, type DecisionPoint, type GameState } from './sim.ts';
import { ACTOR_IDS, type ActorId, type Dir } from './types.ts';
import type { ModelId } from '../shared/models.ts';

export type { Transport };

/**
 * Pac-Man on the kit's real-time scheduler (packages/kit/client/scheduler.ts): the questions are each model-played
 * character's next junctions (and Pac-Man's mid-corridor escape questions), and an answer also depends on the fruit,
 * which can appear, vanish or drift out of reach without changing a junction's key. The events keep the shape
 * recordings have always had (a decision says whether fruit was on the board), so old recordings still replay.
 */
export type SchedulerEvent =
  | { type: 'decision'; decision: Decision; latencyMs: number | null; fruitOnBoard: boolean }
  | { type: 'call'; /** The model that answered; missing in games recorded before models could be chosen. */ model?: string; actors: ActorId[]; latencyMs: number; usage: DecideResponse['usage']; costUsd: number | null; costEstimated?: boolean; traceId: string | null }
  | { type: 'stale'; actor: ActorId; key: string }
  /** An earlier `decision` that was never used; consumers should take it back out of their totals. */
  | { type: 'superseded'; decision: Decision }
  | { type: 'error'; message: string };

/** What an answer depends on besides its junction: whether fruit was on the board, and Pac-Man's FRUIT route then. */
interface FruitContext {
  fruitOnBoard: boolean;
  fruitRoute: Dir | null;
}

export interface SchedulerDeps {
  transport: Transport;
  now: () => number;
  onEvent: (e: SchedulerEvent) => void;
  timeoutMs?: number;
  /**
   * When the timeout starts: at send (the benchmark's rule, the default), or when the question was queued, so a
   * question stuck behind slow requests also falls back in time (a player's game: no ghost waits much over 2 s).
   */
  timeoutFrom?: 'send' | 'queue';
  maxInFlight?: number;
  /**
   * The decision model for each character. Read on every request, so it can change mid-game. Without one (or when it
   * returns undefined) the request names no model and the server uses its default.
   */
  modelFor?: (actor: ActorId) => ModelId | undefined;
  /** Actors this scheduler asks a model about, fixed or per game state (default: all). */
  actors?: readonly ActorId[] | ((state: GameState) => readonly ActorId[]);
  /**
   * In-flight request counter. Pass the same object to successive schedulers (one per game) so requests
   * still running from an earlier game keep counting against `maxInFlight`.
   */
  slots?: { inFlight: number };
}

const PACMAN_GAME: SchedulerGame<GameState, DecisionPoint, PendingQuestion, Decision, FruitContext> = {
  points: (state, actor) => decisionPoints(state, actor as ActorId),
  prepare: (state, point) => ({ point, features: optionFeatures(state, point) }),
  name: questionName,
  build: buildRequest,
  parse: parseAnswer,
  fallback: fallbackDecision,
  context: (state, q) => ({ fruitOnBoard: state.fruit !== null, fruitRoute: q.point.actor === 'pacman' ? fruitRoute(state, q.point, q.features) : null }),
  // Pac-Man's routes and fallback depend on the fruit, which can appear or vanish without changing the key.
  isStale: (ctx, state, point) => point.actor === 'pacman' && ctx.fruitOnBoard !== (state.fruit !== null),
  // Fruit can appear or expire inside the very step that reaches the junction, after the last update(), and while
  // Pac-Man waits for an answer the fruit can drift out of reach. Either way the answer is stale.
  staleAtUse: (ctx, state, point) => {
    if (point.actor !== 'pacman' || !(ctx.fruitOnBoard || state.fruit)) return null;
    const features = optionFeatures(state, point);
    return ctx.fruitOnBoard !== (state.fruit !== null) || fruitRoute(state, point, features) !== ctx.fruitRoute ? 'fruit changed' : null;
  },
  // Escape answers mean "keep going" or "turn back"; Pac-Man may have rounded a corner since.
  move: (d, point) => (!point.escape ? d.choice : d.choice === d.options[0] ? point.options[0]! : point.options[1]!),
  answeredOnce: (point) => point.escape === true,
};

const legacy = (e: KitEvent<Decision, FruitContext>): SchedulerEvent =>
  e.type === 'decision' ? { type: 'decision', decision: e.decision, latencyMs: e.latencyMs, fruitOnBoard: e.context.fruitOnBoard } : (e as SchedulerEvent);

/**
 * Looks ahead to each model-driven actor's next junction, asks the model in batches, and hands the answers to the
 * simulation through `decide`. Times out to a greedy fallback.
 */
export class Scheduler implements Controls {
  private readonly inner: RealtimeScheduler<GameState, DecisionPoint, PendingQuestion, Decision, FruitContext>;

  constructor(deps: SchedulerDeps) {
    this.inner = new RealtimeScheduler(PACMAN_GAME, {
      transport: deps.transport,
      now: deps.now,
      onEvent: (e) => deps.onEvent(legacy(e)),
      timeoutMs: deps.timeoutMs,
      timeoutFrom: deps.timeoutFrom,
      maxInFlight: deps.maxInFlight,
      ...(deps.modelFor ? { modelFor: (actor: string) => deps.modelFor!(actor as ActorId) } : {}),
      actors: deps.actors ?? ACTOR_IDS,
      slots: deps.slots,
    });
  }

  /** The decision the last `decide` handed out: a recorded game keeps its signature (or that it was a fallback). */
  get lastDecision(): Decision | null {
    return this.inner.lastDecision;
  }

  update(state: GameState): void {
    this.inner.update(state);
  }

  decide(point: DecisionPoint, state: GameState): Dir | null {
    return this.inner.decide(point, state) as Dir | null;
  }

  reset(): void {
    this.inner.reset();
  }
}
