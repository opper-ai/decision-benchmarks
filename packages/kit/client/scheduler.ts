import type { DecideResponse, SystemOneRequest, Transport } from '../shared/systemone.ts';

/**
 * The decision schedulers every game uses to ask a model, in two modes:
 *
 * - Real time (RealtimeScheduler): the game runs on while the model thinks. Each update looks ahead to every open
 *   question (a junction coming up), asks about the new ones in batches (one request per model), and hands the
 *   answers over when the game reaches them. A question unanswered in time gets the game's fallback.
 * - Paused (askPaused): the game waits for the answers to one request, up to a timeout, then uses the fallback.
 *
 * What a game knows (its questions, how to word them, its fallback, and what makes an answer stale) comes in through
 * the hooks below; the kit keeps the timing, batching, models and signatures. Isomorphic: the page and the bench use it.
 */

/** A question the game will need answered, with a key that stays the same while it is open. */
export interface OpenQuestion {
  key: string;
  /** Who asks (a character, a side): batches and models are per actor. */
  actor: string;
}

/** What every decision carries; a game's own decision type adds its fields. */
export interface BaseDecision {
  choice: string;
  source: string;
  /** The model that answered, for decisions a model made. */
  model?: string;
  /** The server's signature on this answer, and the model id it signed it as (a high-score entry replays only these). */
  sig?: string;
  signedAs?: string;
}

export interface SchedulerGame<S, P extends OpenQuestion, Q extends { point: P }, D extends BaseDecision, C = undefined> {
  /** The open questions of one actor now. */
  points(state: S, actor: string): readonly P[];
  /** The question as it is asked, built once when it is queued (e.g. with route features). */
  prepare(state: S, point: P): Q;
  /** The question's name in a request (an actor can have more than one open). */
  name(point: P): string;
  /** The request body for a batch: the state and the worded questions. */
  build(state: S, batch: Q[]): Pick<SystemOneRequest, 'state' | 'questions'>;
  /** A model's answer as a decision, or null when it is unusable. */
  parse(answer: unknown, q: Q): D | null;
  /** The game's own rule, when the model did not answer (in time, or usably). */
  fallback(state: S, q: Q, reason: string): D;
  /** What an answer depends on besides the question's key (Pac-Man: the fruit), captured when the question is queued. */
  context?(state: S, q: Q): C;
  /** On update: true drops a queued question or an unused answer, so the question is asked again. */
  isStale?(context: C, state: S, point: P): boolean;
  /** When the answer is about to be used: a reason replaces it with the fallback (the situation moved on). */
  staleAtUse?(context: C, state: S, point: P): string | null;
  /** The move an answer makes at `point` (default: its choice). */
  move?(decision: D, point: P): string;
  /** Questions that stay open after they are answered: answered once, and not asked again while open. */
  answeredOnce?(point: P): boolean;
}

export type SchedulerEvent<D, C = undefined> =
  | { type: 'decision'; decision: D; latencyMs: number | null; context: C }
  | {
      type: 'call';
      /** The model that answered; missing in games recorded before models could be chosen. */
      model?: string;
      actors: string[];
      latencyMs: number;
      usage: DecideResponse['usage'];
      costUsd: number | null;
      costEstimated?: boolean;
      traceId: string | null;
    }
  | { type: 'stale'; actor: string; key: string }
  /** An earlier `decision` that was never used; consumers should take it back out of their totals. */
  | { type: 'superseded'; decision: D }
  | { type: 'error'; message: string };

export interface RealtimeOptions<S, D, C> {
  transport: Transport;
  now: () => number;
  onEvent: (e: SchedulerEvent<D, C>) => void;
  timeoutMs?: number;
  /**
   * When the timeout starts: at send (the benchmark's rule, the default), or when the question was queued, so a
   * question stuck behind slow requests also falls back in time (a player's game: nobody waits much over the timeout).
   */
  timeoutFrom?: 'send' | 'queue';
  maxInFlight?: number;
  /**
   * The decision model for each actor. Read on every request, so it can change mid-game. Without one (or when it
   * returns undefined) the request names no model and the server uses its default.
   */
  modelFor?: (actor: string) => string | undefined;
  /** The actors a model plays, fixed or per game state. */
  actors: readonly string[] | ((state: S) => readonly string[]);
  /**
   * In-flight request counter. Pass the same object to successive schedulers (one per game) so requests still
   * running from an earlier game keep counting against `maxInFlight`.
   */
  slots?: { inFlight: number };
}

interface Pending<Q, C> {
  q: Q;
  sentAt: number | null; // null = queued, waiting for a free slot
  queuedAt: number;
  context: C;
  /** The model the question went to (once sent); its answer is stale once the actor's model changes. */
  model?: string;
}

/**
 * Real time: looks ahead to each model-played actor's open questions, asks in batches, and hands the answers to the
 * game through `decide`. Times out to the game's fallback.
 */
export class RealtimeScheduler<S, P extends OpenQuestion, Q extends { point: P }, D extends BaseDecision, C = undefined> {
  private readonly pending = new Map<string, Pending<Q, C>>();
  private readonly ready = new Map<string, { decision: D; context: C; model?: string }>();
  /** Answers already handed to the game whose question is still open (answeredOnce); never asked again. */
  private readonly consumed = new Set<string>();
  /** The decision the last `decide` handed out: a recorded game keeps its signature (or that it was a fallback). */
  lastDecision: D | null = null;
  private readonly game: SchedulerGame<S, P, Q, D, C>;
  private readonly opts: RealtimeOptions<S, D, C>;
  private readonly slots: { inFlight: number };
  private readonly timeoutMs: number;
  private readonly maxInFlight: number;

  constructor(game: SchedulerGame<S, P, Q, D, C>, opts: RealtimeOptions<S, D, C>) {
    this.game = game;
    this.opts = opts;
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.maxInFlight = opts.maxInFlight ?? 3;
    this.slots = opts.slots ?? { inFlight: 0 };
  }

  private contextOf(state: S, q: Q): C {
    return this.game.context ? this.game.context(state, q) : (undefined as C);
  }

  update(state: S): void {
    const { game } = this;
    const now = this.opts.now();
    const live = new Set<string>();
    const actors = typeof this.opts.actors === 'function' ? this.opts.actors(state) : this.opts.actors;
    for (const actor of actors) {
      for (const point of game.points(state, actor)) {
        live.add(point.key);
        // An actor switched to another model: whatever the old one answered (or is answering) no longer counts.
        const model = this.opts.modelFor?.(actor);
        const sent = this.pending.get(point.key);
        if (sent && sent.sentAt !== null && sent.model !== model) this.pending.delete(point.key);
        if (this.ready.has(point.key) && this.ready.get(point.key)!.model !== model) this.dropReady(point.key);
        // The game's own staleness: something the answer depends on changed without changing the key.
        if (game.isStale) {
          const p = this.pending.get(point.key);
          if (p && game.isStale(p.context, state, point)) this.pending.delete(point.key);
          const r = this.ready.get(point.key);
          if (r && game.isStale(r.context, state, point)) this.dropReady(point.key);
        }
        if (this.pending.has(point.key) || this.ready.has(point.key) || this.consumed.has(point.key)) continue;
        const q = game.prepare(state, point);
        this.pending.set(point.key, { q, sentAt: null, queuedAt: now, context: this.contextOf(state, q) });
      }
    }
    for (const key of [...this.pending.keys()]) if (!live.has(key)) this.pending.delete(key);
    for (const key of [...this.ready.keys()]) if (!live.has(key)) this.dropReady(key);
    for (const key of [...this.consumed]) if (!live.has(key)) this.consumed.delete(key);

    for (const [key, p] of [...this.pending]) {
      const from = this.opts.timeoutFrom === 'queue' ? p.queuedAt : p.sentAt;
      if (from !== null && now - from > this.timeoutMs) this.resolve(key, game.fallback(state, p.q, 'timeout'), null);
    }

    // One request per model: a System One request names a single model.
    const byModel = new Map<string | undefined, Pending<Q, C>[]>();
    for (const p of this.pending.values()) {
      if (p.sentAt !== null) continue;
      const model = this.opts.modelFor?.(p.q.point.actor);
      byModel.set(model, [...(byModel.get(model) ?? []), p]);
    }
    for (const [model, batch] of byModel) {
      if (this.slots.inFlight >= this.maxInFlight) break;
      this.send(state, batch, now, model);
    }
  }

  /** The answer for a question the game has reached, or null while there is none yet (the game waits or falls back). */
  decide(point: P, state: S): string | null {
    const { game } = this;
    const r = this.ready.get(point.key);
    if (!r) return null;
    this.ready.delete(point.key);
    let d = r.decision;
    this.lastDecision = d;
    const reason = game.staleAtUse?.(r.context, state, point) ?? null;
    if (reason !== null) {
      this.opts.onEvent({ type: 'superseded', decision: d });
      const q = game.prepare(state, point);
      d = game.fallback(state, q, reason);
      this.lastDecision = d;
      this.opts.onEvent({ type: 'decision', decision: d, latencyMs: null, context: this.contextOf(state, q) });
    }
    if (game.answeredOnce?.(point)) this.consumed.add(point.key);
    return game.move ? game.move(d, point) : d.choice;
  }

  reset(): void {
    this.pending.clear();
    this.ready.clear();
    this.consumed.clear();
  }

  private send(state: S, batch: Pending<Q, C>[], now: number, requested: string | undefined): void {
    const { game } = this;
    for (const p of batch) {
      p.sentAt = now;
      p.model = requested;
    }
    this.slots.inFlight += 1;
    const isCurrent = (p: Pending<Q, C>) => this.pending.get(p.q.point.key) === p;
    const body: SystemOneRequest = {
      ...(requested ? { model: requested } : {}),
      ...game.build(state, batch.map((p) => p.q)),
      keys: Object.fromEntries(batch.map((p) => [game.name(p.q.point), p.q.point.key])),
    };
    this.opts
      .transport(body)
      .then(
        (res) => {
          const model = res.model ?? requested;
          this.opts.onEvent({
            type: 'call',
            model,
            actors: batch.map((p) => p.q.point.actor),
            latencyMs: res.latencyMs,
            usage: res.usage,
            costUsd: res.costUsd,
            costEstimated: res.costEstimated === true,
            traceId: res.traceId,
          });
          for (const p of batch) {
            if (!isCurrent(p)) {
              this.opts.onEvent({ type: 'stale', actor: p.q.point.actor, key: p.q.point.key });
              continue;
            }
            const name = game.name(p.q.point);
            const parsed = game.parse(res.answers[name], p.q);
            const sig = res.signatures?.[name];
            const decision = parsed ? { ...parsed, model, ...(sig && res.signedAs ? { sig, signedAs: res.signedAs } : {}) } : game.fallback(state, p.q, 'invalid answer');
            this.resolve(p.q.point.key, decision, res.latencyMs);
          }
        },
        (err: unknown) => {
          this.opts.onEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          for (const p of batch) if (isCurrent(p)) this.resolve(p.q.point.key, game.fallback(state, p.q, 'error'), null);
        },
      )
      .finally(() => {
        this.slots.inFlight -= 1;
      });
  }

  /** Discard an answer that was announced as a decision but will never be used. */
  private dropReady(key: string): void {
    const r = this.ready.get(key);
    if (!r) return;
    this.ready.delete(key);
    this.opts.onEvent({ type: 'superseded', decision: r.decision });
  }

  private resolve(key: string, decision: D, latencyMs: number | null): void {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    this.ready.set(key, { decision, context: p.context, model: p.model });
    this.opts.onEvent({ type: 'decision', decision, latencyMs, context: p.context });
  }
}

export interface PausedOptions<D, C> {
  transport: Transport;
  now: () => number;
  onEvent?: (e: SchedulerEvent<D, C>) => void;
  /** How long the game waits for the answers before its fallback decides. */
  timeoutMs: number;
  /** The model to ask (undefined: the server's default). */
  model?: string;
}

/**
 * Paused: asks every question in `points` in one request and waits for the answers, at most `timeoutMs`. Questions
 * without a usable answer by then get the game's fallback (an answer arriving later is reported as stale). Resolves to
 * one decision per point, in order; never rejects.
 */
export async function askPaused<S, P extends OpenQuestion, Q extends { point: P }, D extends BaseDecision, C = undefined>(
  game: Pick<SchedulerGame<S, P, Q, D, C>, 'prepare' | 'name' | 'build' | 'parse' | 'fallback' | 'context'>,
  state: S,
  points: readonly P[],
  opts: PausedOptions<D, C>,
): Promise<D[]> {
  const emit = opts.onEvent ?? (() => {});
  const qs = points.map((p) => game.prepare(state, p));
  const contexts = qs.map((q) => (game.context ? game.context(state, q) : (undefined as C)));
  if (!qs.length) return [];
  const body: SystemOneRequest = {
    ...(opts.model ? { model: opts.model } : {}),
    ...game.build(state, qs),
    keys: Object.fromEntries(qs.map((q) => [game.name(q.point), q.point.key])),
  };
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, opts.timeoutMs);
  });
  const call = opts.transport(body).then(
    (res) => {
      emit({ type: 'call', model: res.model ?? opts.model, actors: qs.map((q) => q.point.actor), latencyMs: res.latencyMs, usage: res.usage, costUsd: res.costUsd, costEstimated: res.costEstimated === true, traceId: res.traceId });
      if (timedOut) for (const q of qs) emit({ type: 'stale', actor: q.point.actor, key: q.point.key });
      return res;
    },
    (err: unknown) => {
      emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      return null;
    },
  );
  const res = await Promise.race([call, timeout]);
  clearTimeout(timer);
  return qs.map((q, i) => {
    const name = game.name(q.point);
    const parsed = res ? game.parse(res.answers[name], q) : null;
    const sig = res?.signatures?.[name];
    const decision: D = parsed
      ? { ...parsed, model: res!.model ?? opts.model, ...(sig && res!.signedAs ? { sig, signedAs: res!.signedAs } : {}) }
      : game.fallback(state, q, res ? 'invalid answer' : timedOut ? 'timeout' : 'error');
    emit({ type: 'decision', decision, latencyMs: parsed ? res!.latencyMs : null, context: contexts[i]! });
    return decision;
  });
}
