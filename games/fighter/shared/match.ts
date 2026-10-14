import type { Adapter, Answer } from './adapter.ts';
import {
  DEFAULT_RULES,
  ENGINE_VERSION,
  TICK_HZ,
  clone,
  hashState,
  isActionable,
  legalMoves,
  newGame,
  predictActionable,
  step,
  type GameEvent,
  type GameState,
  type Inputs,
  type Rules,
  type Side,
} from './engine/engine.ts';
import type { MoveId } from './engine/moves.ts';
import { fallbackMove } from './fallback.ts';
import { buildQuestion, type Question, type Track } from './question.ts';
import { Perception } from './view.ts';
import { annotateOutcomes, type Decision, type FallbackReason, type FighterMeta, type Replay } from './replay.ts';

export const TICK_MS = 1000 / TICK_HZ;
/** Ask early when the fighter will be actionable within this many ticks (adapted to each model's latency). */
export const ASK_AHEAD_TICKS = 40;
export const ASK_AHEAD_MAX = 120;

/** Ticks ahead to ask a model whose answers take `latencyMs`, so they land about when it can act. */
export const askAhead = (latencyMs: number) => Math.max(ASK_AHEAD_TICKS, Math.min(ASK_AHEAD_MAX, Math.ceil(latencyMs / TICK_MS) + 8));
export const CHECKPOINT_EVERY = 600;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))),
};

/** Never waits on the wall clock: for unpaced matches whose players answer immediately (baselines). */
export const instantClock: Clock = {
  now: () => performance.now(),
  sleep: () => new Promise((r) => setTimeout(r, 0)),
};

export interface MatchOptions {
  seed: number;
  mode: 'realtime' | 'paused';
  deadlineMs: number;
  adapters: [Adapter, Adapter];
  fighters: [FighterMeta, FighterMeta];
  clock?: Clock;
  /** Paced to the wall clock (live play, realtime bench). Paused mode without pacing runs as fast as answers come. */
  paced?: boolean;
  /** What each option tells the model. Default: assisted. */
  track?: Track;
  /** Per side: keep questions under this many tokens (short-context models). */
  maxTokens?: [number | undefined, number | undefined];
  rules?: Rules;
}

interface Pending {
  question: Question;
  askedTick: number;
  askedAt: number;
  /** Asked about a predicted future state rather than the current one. */
  early: boolean;
  controller: AbortController;
  settled?: { answer: Answer } | { reason: FallbackReason; error: string; latencyMs: number };
  arrivedTick?: number;
}

/**
 * A scripted player (Adapter.scripted) in a real-time match, frame by frame and with no clock: asked when its fighter
 * can act, or ahead by its thinking time (as a model is), its answer arrives `delayTicks` frames after the question
 * and plays on the first frame its fighter can act from then (the fallback's move if it is no longer legal), kept
 * whatever happens meanwhile, on the same rules as a model's. The live match and the benchmark's verifier (shared/gauntlet.ts) both play it with this class,
 * so its moves can be recomputed from a recording.
 */
export class ScriptedPlayer {
  private pending: { question: Question; askedTick: number; readyTick: number; early: boolean; answer: Answer } | null = null;
  private readonly latencyMs: number;
  private readonly i: Side;
  private readonly script: NonNullable<Adapter['scripted']>;
  private readonly o: { track: Track; maxTokens?: number };
  readonly cancellations: Replay['cancellations'];

  /** `cancellations` collects its cancelled questions (the match's own list). */
  constructor(i: Side, script: NonNullable<Adapter['scripted']>, o: { track: Track; maxTokens?: number }, cancellations: Replay['cancellations'] = []) {
    this.i = i;
    this.script = script;
    this.o = o;
    this.cancellations = cancellations;
    this.latencyMs = Math.round(script.delayTicks * TICK_MS);
  }

  /** Its move this frame (before the step), or null. */
  take(s: GameState): Decision | null {
    const p = this.pending;
    const i = this.i;
    if (!p || s.tick < p.readyTick || !isActionable(s, i)) return null;
    this.pending = null;
    let move: MoveId | null = p.answer.move;
    let fallback: FallbackReason | null = null;
    if (!legalMoves(s, i).includes(move)) {
      fallback = 'illegal';
      move = fallbackMove(s, i);
    }
    if (!move) return null;
    return { fighter: i, askedTick: p.askedTick, questionTick: p.question.tick, appliedTick: s.tick, move, question: p.question, answer: p.answer, fallback, latencyMs: p.answer.latencyMs, arrivedTick: p.readyTick };
  }

  /** After each step (and once before the first): a new round drops the question in flight; then a new one if none. `view` is what its fighter sees now. */
  manage(s: GameState, events: GameEvent[], view: () => GameState): void {
    const i = this.i;
    const p = this.pending;
    // An answer on its way is kept whatever happens meanwhile (as a model's is); only a new round drops it.
    if (p && events.some((e) => e.kind === 'round_end')) {
      this.cancellations.push({ fighter: i, askedTick: p.askedTick, cancelledTick: s.tick });
      this.pending = null;
    }
    if (this.pending || (s.round.phase !== 'fight' && s.round.phase !== 'intro') || s.fighters[i].phase === 'ko') return;
    if (isActionable(s, i)) this.ask(s, view(), false);
    else {
      const pred = predictActionable(view(), i, askAhead(this.latencyMs));
      if (pred) this.ask(s, pred.state, true);
    }
  }

  private ask(s: GameState, from: GameState, early: boolean): void {
    const question = buildQuestion(from, this.i, { track: this.o.track, maxTokens: this.o.maxTokens });
    if (!question.options.length) return;
    const answer = { ...this.script.decide(question, from), latencyMs: this.latencyMs };
    this.pending = { question, askedTick: s.tick, readyTick: s.tick + this.script.delayTicks, early, answer };
  }
}

const legalHumanMove = (s: GameState, i: Side, w: { move: MoveId } | null): boolean => w !== null && legalMoves(s, i).includes(w.move);

export type MatchListener = (s: GameState, events: GameEvent[]) => void;

export class Match {
  readonly state: GameState;
  readonly decisions: Decision[] = [];
  readonly cancellations: Replay['cancellations'] = [];
  readonly checkpoints: Replay['checkpoints'] = [];
  readonly events: GameEvent[] = [];
  readonly pending: [Pending | null, Pending | null] = [null, null];
  private readonly clock: Clock;
  private stopped = false;
  private listeners: MatchListener[] = [];
  private decisionListeners: ((d: Decision) => void)[] = [];
  /** Wall time the sim spent waiting for answers in paused mode (excluded from pacing). */
  private pausedMs = 0;
  /** Smoothed answer latency per fighter. */
  private latency: [number, number] = [0, 0];
  /** What each fighter can see (the opponent with a reaction delay). */
  private perception = new Perception();
  /** Each side's last decision, until the fighter is free again (closes its outcome window). */
  private open: [Decision | null, Decision | null] = [null, null];
  /** For human players: wall time the fighter became free to act (their reaction time starts then). */
  private freeSince: [number | null, number | null] = [null, null];

  readonly opts: MatchOptions;
  /** Scripted players (Adapter.scripted), per side. */
  private readonly scripted: [ScriptedPlayer | null, ScriptedPlayer | null];

  constructor(opts: MatchOptions) {
    this.opts = opts;
    this.state = newGame(opts.seed, opts.rules ?? DEFAULT_RULES);
    this.clock = opts.clock ?? realClock;
    this.scripted = ([0, 1] as const).map((i) => {
      const script = opts.adapters[i].scripted;
      return script ? new ScriptedPlayer(i, script, { track: this.track, maxTokens: opts.maxTokens?.[i] }, this.cancellations) : null;
    }) as [ScriptedPlayer | null, ScriptedPlayer | null];
  }

  get track(): Track {
    return this.opts.track ?? 'assisted';
  }

  /** What fighter `i` sees right now. */
  view(i: Side): GameState {
    return this.perception.view(this.state, i);
  }

  onTick(l: MatchListener): void {
    this.listeners.push(l);
  }

  onDecision(l: (d: Decision) => void): void {
    this.decisionListeners.push(l);
  }

  stop(): void {
    this.stopped = true;
    for (const p of this.pending) p?.controller.abort();
  }

  get over(): boolean {
    return this.state.round.phase === 'over';
  }

  /** Warm both models up (cold models can take many seconds), in parallel. Failures are reported, not thrown. */
  async warmUp(): Promise<string[]> {
    const res = await Promise.allSettled(this.opts.adapters.map((a) => a.warmUp()));
    return res.flatMap((r, k) => (r.status === 'rejected' ? [`${this.opts.adapters[k].id}: ${(r.reason as Error)?.message ?? r.reason}`] : []));
  }

  /** Ask fighter `i` about `from`: what it sees now, or that carried forward to when it can act. */
  private ask(i: Side, from: GameState, early: boolean): void {
    const question = buildQuestion(from, i, { track: this.track, maxTokens: this.opts.maxTokens?.[i] });
    if (!question.options.length) return;
    const controller = new AbortController();
    const p: Pending = { question, askedTick: this.state.tick, askedAt: this.clock.now(), early, controller };
    this.pending[i] = p;
    const adapter = this.opts.adapters[i];
    const late = (answerMs = 0) => Math.max(answerMs, this.clock.now() - p.askedAt) > this.opts.deadlineMs;
    const timedOut = () => ({ reason: 'timeout' as const, error: `no answer within ${this.opts.deadlineMs} ms`, latencyMs: Math.round(this.clock.now() - p.askedAt) });
    adapter.decide(question, controller.signal, from).then(
      (answer) => {
        if (this.pending[i] === p && !p.settled) {
          // An answer that comes after the deadline is as late as none (the deadline check runs once a tick).
          p.settled = late(answer.latencyMs) ? timedOut() : { answer };
          p.arrivedTick = this.state.tick;
        }
        this.latency[i] = this.latency[i] ? this.latency[i] * 0.8 + answer.latencyMs * 0.2 : answer.latencyMs;
      },
      (err: Error) => {
        if (this.pending[i] !== p || p.settled) return;
        const aborted = controller.signal.aborted;
        const reason: FallbackReason = aborted ? 'timeout' : err?.name === 'InvalidAnswer' ? 'invalid' : 'error';
        p.settled = !aborted && late() ? timedOut() : { reason, error: err?.message ?? String(err), latencyMs: Math.round(this.clock.now() - p.askedAt) };
        p.arrivedTick = this.state.tick;
      },
    );
  }

  private cancel(i: Side): void {
    const p = this.pending[i];
    if (!p) return;
    p.controller.abort();
    this.cancellations.push({ fighter: i, askedTick: p.askedTick, cancelledTick: this.state.tick });
    this.pending[i] = null;
  }

  /** Start, invalidate and time out questions for both fighters. */
  private manageQuestions(lastEvents: GameEvent[]): void {
    const s = this.state;
    for (const i of [0, 1] as const) {
      // Humans are never asked: they press keys. Scripted players manage their own questions, frame by frame.
      if (this.opts.adapters[i].human) continue;
      const scripted = this.scripted[i];
      if (scripted) {
        scripted.manage(s, lastEvents, () => this.view(i));
        continue;
      }
      const p = this.pending[i];
      // Paused mode asks only about the exact current state, so nothing goes stale.
      if (p && this.opts.mode === 'paused') {
        if (lastEvents.some((e) => e.kind === 'round_end')) this.cancel(i);
      } else if (p) {
        // Real time: one question in flight, and an answer on its way is never dropped because the fight moved on
        // (a hit, an attack starting): it plays on the first frame the fighter can act once it is in, if still legal
        // (else the fallback). Only a new round, or the deadline, ends it.
        if (lastEvents.some((e) => e.kind === 'round_end')) {
          this.cancel(i);
        } else if (!p.settled && this.clock.now() - p.askedAt > this.opts.deadlineMs) {
          p.controller.abort();
          p.settled = { reason: 'timeout', error: `no answer within ${this.opts.deadlineMs} ms`, latencyMs: Math.round(this.clock.now() - p.askedAt) };
          p.arrivedTick = s.tick;
        }
      }
      if (p && this.opts.mode === 'paused' && !p.settled && this.clock.now() - p.askedAt > this.opts.deadlineMs) {
        p.controller.abort();
        p.settled = { reason: 'timeout', error: `no answer within ${this.opts.deadlineMs} ms`, latencyMs: Math.round(this.clock.now() - p.askedAt) };
        p.arrivedTick = s.tick;
      }
      if (this.pending[i] || (s.round.phase !== 'fight' && s.round.phase !== 'intro')) continue;
      if (s.fighters[i].phase === 'ko') continue;
      if (isActionable(s, i)) {
        this.ask(i, this.view(i), false);
      } else if (this.opts.mode === 'realtime') {
        // Real time: ask ahead, by about this model's latency, so a fast answer is ready in time.
        const pred = predictActionable(this.view(i), i, askAhead(this.latency[i]));
        if (pred) this.ask(i, pred.state, true);
      }
    }
  }

  /** Inputs for this tick from settled answers (or fallbacks) of actionable fighters. */
  private takeInputs(): Inputs {
    const s = this.state;
    const inputs: Inputs = [null, null];
    for (const i of [0, 1] as const) {
      const human = this.opts.adapters[i].human;
      if (human) {
        inputs[i] = this.takeHuman(i, human);
        continue;
      }
      const scripted = this.scripted[i];
      if (scripted) {
        const d = scripted.take(s);
        if (!d) continue;
        inputs[i] = d.move;
        this.decisions.push(d);
        this.open[i] = d;
        for (const l of this.decisionListeners) l(d);
        continue;
      }
      const p = this.pending[i];
      if (!p?.settled || !isActionable(s, i)) continue;
      let move: MoveId | null;
      let fallback: FallbackReason | null = null;
      let answer: Answer | null = null;
      let error: string | undefined;
      let latencyMs: number;
      if ('answer' in p.settled) {
        answer = p.settled.answer;
        latencyMs = answer.latencyMs;
        move = answer.move;
        if (!legalMoves(s, i).includes(move)) {
          fallback = 'illegal';
          move = fallbackMove(s, i);
        }
      } else {
        fallback = p.settled.reason;
        error = p.settled.error;
        latencyMs = p.settled.latencyMs;
        move = fallbackMove(s, i);
      }
      this.pending[i] = null;
      if (!move) continue;
      inputs[i] = move;
      const d: Decision = {
        fighter: i,
        askedTick: p.askedTick,
        questionTick: p.question.tick,
        appliedTick: s.tick,
        move,
        question: p.question,
        answer,
        fallback,
        latencyMs,
        ...(p.arrivedTick !== undefined ? { arrivedTick: p.arrivedTick } : {}),
        ...(error ? { error } : {}),
      };
      this.decisions.push(d);
      this.open[i] = d;
      for (const l of this.decisionListeners) l(d);
    }
    return inputs;
  }

  /** A human's move this tick, recorded as a decision like any model's. */
  private takeHuman(i: Side, human: NonNullable<Adapter['human']>): MoveId | null {
    const s = this.state;
    if (!isActionable(s, i) || s.round.phase !== 'fight') {
      this.freeSince[i] = null;
      return null;
    }
    const now = this.clock.now();
    this.freeSince[i] ??= now;
    const wanted = human.next(s, i, true);
    if (!legalHumanMove(s, i, wanted)) return null;
    const question = buildQuestion(s, i, { track: this.track });
    const latencyMs = Math.max(0, Math.round(wanted!.at - this.freeSince[i]!));
    this.freeSince[i] = null;
    const d: Decision = {
      fighter: i,
      askedTick: s.tick,
      questionTick: s.tick,
      appliedTick: s.tick,
      move: wanted!.move,
      question,
      answer: { move: wanted!.move, probabilities: null, latencyMs, costUsd: 0 },
      fallback: null,
      latencyMs,
    };
    this.decisions.push(d);
    this.open[i] = d;
    for (const l of this.decisionListeners) l(d);
    return wanted!.move;
  }

  /** In paused mode: true while an actionable fighter is still waiting for its answer (or its player's key). */
  private waiting(): boolean {
    if (this.opts.mode !== 'paused') return false;
    return ([0, 1] as const).some((i) => {
      if (!isActionable(this.state, i)) return false;
      const human = this.opts.adapters[i].human;
      if (human) return this.state.round.phase === 'fight' && !legalHumanMove(this.state, i, human.next(this.state, i, false));
      return this.pending[i] && !this.pending[i]!.settled;
    });
  }

  /** One tick: questions, inputs, simulation. */
  tickOnce(): GameEvent[] {
    const inputs = this.takeInputs();
    this.perception.record(this.state, inputs);
    const events = step(this.state, inputs);
    for (const e of events) this.events.push(e);
    // A decision's outcome window closes when its fighter is free again.
    for (const i of [0, 1] as const) {
      const d = this.open[i];
      if (d && this.state.tick > d.appliedTick + 1 && (isActionable(this.state, i) || this.state.round.phase !== 'fight')) {
        d.doneTick = this.state.tick;
        this.open[i] = null;
      }
    }
    if (this.state.tick % CHECKPOINT_EVERY === 0) this.checkpoints.push({ tick: this.state.tick, hash: hashState(this.state) });
    this.manageQuestions(events);
    for (const l of this.listeners) l(this.state, events);
    return events;
  }

  /** Run the match to the end. */
  async run(): Promise<Replay> {
    const paced = this.opts.paced ?? this.opts.mode === 'realtime';
    this.manageQuestions([]);
    const start = this.clock.now();
    let ticks = 0;
    while (!this.over && !this.stopped) {
      if (this.waiting()) {
        const t0 = this.clock.now();
        await this.clock.sleep(2);
        this.pausedMs += this.clock.now() - t0;
        // Deadlines still apply while paused.
        this.manageQuestions([]);
        continue;
      }
      if (paced) {
        const due = start + this.pausedMs + ticks * TICK_MS;
        const wait = due - this.clock.now();
        if (wait > 0) await this.clock.sleep(wait);
      } else if (ticks % 30 === 0) {
        // Let answers land even when running unpaced.
        await this.clock.sleep(0);
      }
      this.tickOnce();
      ticks++;
    }
    this.stop();
    return this.replay();
  }

  replay(): Replay {
    const s = this.state;
    const checkpoints = [...this.checkpoints];
    if (!checkpoints.length || checkpoints[checkpoints.length - 1].tick !== s.tick) checkpoints.push({ tick: s.tick, hash: hashState(s) });
    const decisions = annotateOutcomes(this.decisions, this.events, s.tick);
    const costUsd = decisions.reduce((sum, d) => sum + (d.answer?.costUsd ?? 0), 0);
    return {
      format: 1,
      engineVersion: ENGINE_VERSION,
      seed: this.opts.seed,
      mode: this.opts.mode,
      track: this.track,
      rules: this.state.rules,
      deadlineMs: this.opts.deadlineMs,
      fighters: this.opts.fighters,
      createdAt: new Date().toISOString(),
      ticks: s.tick,
      costUsd,
      decisions,
      cancellations: this.cancellations,
      checkpoints,
      result: { winner: s.winner, rounds: clone(s).results },
    };
  }
}
