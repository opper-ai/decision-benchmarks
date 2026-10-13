// The benchmark (docs/specs/2026-10-12-port-to-kit.md): one game is one paused match, assisted track, of the model
// under test against one baseline of the gauntlet (greedy, payoff, maximin), from one side. The score is the model's
// share of the rounds (a drawn round counts half), in percent. The bench plays it (game.ts) and the submissions check
// replays it with `verifyGauntlet`, on the same stepper, so a match replays exactly as it was played.
import type { GameResult, Verdict } from '../../../packages/kit/shared/game.ts';
import { mean } from '../../../packages/kit/shared/stats.ts';
import type { Adapter, Answer } from './adapter.ts';
import { baselineAnswer, baselineName, type BaselineId } from './baselines.ts';
import { clone, DEFAULT_RULES, ENGINE_VERSION, hashState, isActionable, legalMoves, newGame, step, type GameEvent, type GameState, type Inputs, type RoundResult, type Rules, type Side } from './engine/engine.ts';
import { isMoveId, type MoveId } from './engine/moves.ts';
import { fallbackMove } from './fallback.ts';
import { CHECKPOINT_EVERY } from './match.ts';
import { modelInfo } from './models.ts';
import { buildQuestion, offeredMoves, type Question, type Track } from './question.ts';
import { annotateOutcomes, type BenchInfo, type Decision, type FallbackReason, type FighterMeta, type Replay } from './replay.ts';
import { Perception } from './view.ts';

/**
 * Bump when anything a score depends on changes: the engine (ENGINE_VERSION), the track, the mode, the deadline, the
 * gauntlet, the seeds or the question format. tests/bench-version.test.ts pins them.
 */
export const BENCH_VERSION = 1;
export const GAUNTLET = ['baseline/greedy', 'baseline/payoff', 'baseline/maximin'] as const;
export type GauntletId = (typeof GAUNTLET)[number];
export const BENCH_MODE = 'paused';
export const BENCH_TRACK: Track = 'assisted';
/** How long the match waits for an answer before the fallback (block) plays. Paused: decisions, not speed. */
export const DEADLINE_MS = 5000;
/** The engine version and rules the benchmark plays. */
export const BENCH_ENGINE = ENGINE_VERSION;
export const BENCH_RULES: Rules = DEFAULT_RULES;
export const SIDE_COLORS = ['#E07B45', '#1FA3B3'] as const;

export interface MatchSpec {
  opponent: GauntletId;
  /** The model under test's side: 0 left, 1 right. */
  side: Side;
  /** The engine's seed: the start distance and position. */
  engineSeed: number;
}

/** Fight k's engine seed, spread out so neighbouring fights start differently. */
export const engineSeedFor = (k: number): number => (Math.imul(k + 1, 0x9e3779b1) ^ 0x5bd1e995) >>> 0;

/**
 * What bench seed `seed` plays: seed % 3 picks the baseline, floor(seed / 3) % 2 the side, floor(seed / 6) the fight.
 * Game i plays seed i, so 102 games are 17 fights x 3 baselines x 2 sides.
 */
export function matchSpec(seed: number): MatchSpec {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('a bench seed is a whole number of at least 0');
  return { opponent: GAUNTLET[seed % 3]!, side: (Math.floor(seed / 3) % 2) as Side, engineSeed: engineSeedFor(Math.floor(seed / 6)) };
}

/** A benchmark recording: the replay, with what match it was. */
export type GauntletRecording = Replay & { bench: BenchInfo };

/** A question for a fighter that can act now. The question is built on first use (the verifier never builds the model's). */
export interface Ask {
  side: Side;
  tick: number;
  /** What the fighter sees (the opponent with a reaction delay). */
  view: GameState;
  question(): Question;
}

/** How a question was settled: an answer, or why there was none (the fallback then plays). */
export type Settled = { answer: Answer } | { reason: FallbackReason; error?: string; latencyMs: number };

export interface PausedRunOptions {
  seed: number;
  track: Track;
  deadlineMs: number;
  fighters: [FighterMeta, FighterMeta];
  maxTokens?: [number | undefined, number | undefined];
  rules?: Rules;
  /** Sides whose questions are recorded in the decisions; the others get an empty one. Default: both. */
  questionsFor?: readonly Side[];
}

/**
 * A paused match, one decision at a time, with no clock: as shared/match.ts plays paused mode (a fighter is asked when
 * it can act, about what it sees, and the fight waits for the answer), but synchronous, so the same code plays a match
 * (with answers from models) and replays one (with answers from a recording).
 */
export class PausedRun {
  readonly state: GameState;
  readonly decisions: Decision[] = [];
  readonly events: GameEvent[] = [];
  readonly checkpoints: Replay['checkpoints'] = [];
  private readonly opts: PausedRunOptions;
  private readonly perception = new Perception();
  /** Each side's last decision, until the fighter is free again (closes its outcome window). */
  private readonly open: [Decision | null, Decision | null] = [null, null];
  private current: Ask[] | null = null;

  constructor(opts: PausedRunOptions) {
    this.opts = opts;
    this.state = newGame(opts.seed, opts.rules ?? DEFAULT_RULES);
  }

  get over(): boolean {
    return this.state.round.phase === 'over';
  }

  /** The questions to answer now: runs the fight on until a fighter can act. Empty once the match is over. */
  asks(): Ask[] {
    while (!this.current) {
      if (this.over) return [];
      const asks = this.asksNow();
      if (asks.length) this.current = asks;
      else this.tick([null, null]);
    }
    return this.current;
  }

  private asksNow(): Ask[] {
    const s = this.state;
    const out: Ask[] = [];
    for (const i of [0, 1] as const) {
      if (!isActionable(s, i) || s.fighters[i].phase === 'ko') continue;
      const view = this.perception.view(s, i);
      if (!offeredMoves(view, i).length) continue;
      let q: Question | null = null;
      out.push({ side: i, tick: s.tick, view, question: () => (q ??= buildQuestion(view, i, { track: this.opts.track, maxTokens: this.opts.maxTokens?.[i] })) });
    }
    return out;
  }

  /** Applies the answers to `asks()` (in its order): each fighter's move, or the fallback's, then one tick. */
  apply(settled: readonly Settled[]): void {
    const asks = this.current;
    if (!asks) throw new Error('nothing was asked');
    if (settled.length !== asks.length) throw new Error(`${asks.length} questions, ${settled.length} answers`);
    this.current = null;
    const s = this.state;
    const inputs: Inputs = [null, null];
    asks.forEach((a, k) => {
      const r = settled[k]!;
      const i = a.side;
      let move: MoveId | null;
      let fallback: FallbackReason | null = null;
      let answer: Answer | null = null;
      let error: string | undefined;
      let latencyMs: number;
      if ('answer' in r) {
        answer = r.answer;
        latencyMs = answer.latencyMs;
        move = answer.move;
        if (!legalMoves(s, i).includes(move)) {
          fallback = 'illegal';
          move = fallbackMove(s, i);
        }
      } else {
        fallback = r.reason;
        error = r.error;
        latencyMs = r.latencyMs;
        move = fallbackMove(s, i);
      }
      if (!move) return;
      inputs[i] = move;
      const question = (this.opts.questionsFor ?? [0, 1]).includes(i) ? a.question() : { fighter: i, track: this.opts.track, tick: a.tick, instructions: '', context: {}, options: [] };
      const d: Decision = { fighter: i, askedTick: a.tick, questionTick: a.view.tick, appliedTick: s.tick, move, question, answer, fallback, latencyMs, arrivedTick: s.tick, ...(error ? { error } : {}) };
      this.decisions.push(d);
      this.open[i] = d;
    });
    this.tick(inputs);
  }

  private tick(inputs: Inputs): void {
    this.perception.record(this.state, inputs);
    const events = step(this.state, inputs);
    for (const e of events) this.events.push(e);
    for (const i of [0, 1] as const) {
      const d = this.open[i];
      if (d && this.state.tick > d.appliedTick + 1 && (isActionable(this.state, i) || this.state.round.phase !== 'fight')) {
        d.doneTick = this.state.tick;
        this.open[i] = null;
      }
    }
    if (this.state.tick % CHECKPOINT_EVERY === 0) this.checkpoints.push({ tick: this.state.tick, hash: hashState(this.state) });
  }

  replay(): Replay {
    const s = this.state;
    const checkpoints = [...this.checkpoints];
    if (!checkpoints.length || checkpoints[checkpoints.length - 1]!.tick !== s.tick) checkpoints.push({ tick: s.tick, hash: hashState(s) });
    const decisions = annotateOutcomes(this.decisions, this.events, s.tick);
    return {
      format: 1,
      engineVersion: ENGINE_VERSION,
      seed: this.opts.seed,
      mode: 'paused',
      track: this.opts.track,
      rules: s.rules,
      deadlineMs: this.opts.deadlineMs,
      fighters: this.opts.fighters,
      createdAt: new Date().toISOString(),
      ticks: s.tick,
      costUsd: decisions.reduce((sum, d) => sum + (d.answer?.costUsd ?? 0), 0),
      decisions,
      cancellations: [],
      checkpoints,
      result: { winner: s.winner, rounds: clone(s).results },
    };
  }
}

/** A gauntlet baseline's answer to its question, as its adapter gives it in a paused match. */
export function baselineSettled(id: BaselineId, a: Ask): Settled {
  return { answer: { ...baselineAnswer(id, a.question(), a.view), latencyMs: 0, costUsd: 0 } };
}

/** The fighters of a benchmark match: the model on its side, the baseline on the other. */
export function fightersFor(spec: MatchSpec, model: string): [FighterMeta, FighterMeta] {
  const info = modelInfo(model);
  const metas: FighterMeta[] = [];
  metas[spec.side] = { model, label: info.label, kind: info.kind, color: SIDE_COLORS[spec.side] };
  metas[1 - spec.side] = { model: spec.opponent, label: baselineName(spec.opponent), kind: 'baseline', color: SIDE_COLORS[1 - spec.side] };
  return metas as [FighterMeta, FighterMeta];
}

/** Asks `adapter` within the deadline; a late, failed or unusable answer is settled as the reason the fallback plays. */
async function askWithin(adapter: Adapter, a: Ask, deadlineMs: number, now: () => number): Promise<Settled> {
  const started = now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Settled>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ reason: 'timeout', error: `no answer within ${deadlineMs} ms`, latencyMs: deadlineMs });
    }, deadlineMs);
  });
  const answered = adapter.decide(a.question(), controller.signal, a.view).then(
    (answer): Settled => ({ answer: { ...answer, latencyMs: Math.min(deadlineMs, Math.max(0, Math.round(answer.latencyMs))) } }),
    (err: Error): Settled => ({ reason: err?.name === 'InvalidAnswer' ? 'invalid' : 'error', error: String(err?.message ?? err).slice(0, 200), latencyMs: Math.min(deadlineMs, Math.round(now() - started)) }),
  );
  try {
    return await Promise.race([answered, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Plays bench seed `seed`: `adapter` is the model under test (`model` is the id the recording names). */
export async function playGauntlet(o: { seed: number; model: string; adapter: Adapter; signal?: AbortSignal; now?: () => number }): Promise<GauntletRecording> {
  const spec = matchSpec(o.seed);
  const now = o.now ?? (() => performance.now());
  const maxTokens: [number | undefined, number | undefined] = [undefined, undefined];
  maxTokens[spec.side] = modelInfo(o.model).contextTokens;
  const run = new PausedRun({ seed: spec.engineSeed, track: BENCH_TRACK, deadlineMs: DEADLINE_MS, fighters: fightersFor(spec, o.model), maxTokens, rules: BENCH_RULES });
  for (let asks = run.asks(); asks.length; asks = run.asks()) {
    if (o.signal?.aborted) throw new Error('the match was stopped');
    run.apply(await Promise.all(asks.map((a) => (a.side === spec.side ? askWithin(o.adapter, a, DEADLINE_MS, now) : baselineSettled(spec.opponent, a)))));
  }
  return { ...run.replay(), bench: { version: BENCH_VERSION, seed: o.seed, side: spec.side, opponent: spec.opponent, model: o.model } };
}

export interface FighterResult extends GameResult {
  opponent: GauntletId;
  side: Side;
  rounds: number;
  roundsWon: number;
  roundsDrawn: number;
  /** The match: 1 won, 0.5 drawn, 0 lost. */
  matchPoints: number;
}

/** The model's share of the rounds, a drawn round counting half, in percent (two decimals). */
export function roundShare(rounds: readonly RoundResult[], side: Side): number {
  if (!rounds.length) return 0;
  const points = rounds.reduce((a, r) => a + (r.winner === side ? 1 : r.winner === null ? 0.5 : 0), 0);
  return Math.round((10000 * points) / rounds.length) / 100;
}

/** A match's result for the model on `side`, from the decisions it made and the rounds as they ended. */
export function resultOf(spec: MatchSpec, decisions: readonly Decision[], result: Replay['result']): FighterResult {
  const mine = decisions.filter((d) => d.fighter === spec.side);
  const answered = mine.filter((d) => d.answer);
  return {
    score: roundShare(result.rounds, spec.side),
    calls: answered.length,
    latencyMsSum: answered.reduce((a, d) => a + d.latencyMs, 0),
    cost: answered.reduce((a, d) => a + (d.answer!.costUsd ?? 0), 0),
    decisions: mine.length,
    fallbacks: mine.filter((d) => d.fallback).length,
    opponent: spec.opponent,
    side: spec.side,
    rounds: result.rounds.length,
    roundsWon: result.rounds.filter((r) => r.winner === spec.side).length,
    roundsDrawn: result.rounds.filter((r) => r.winner === null).length,
    matchPoints: result.winner === spec.side ? 1 : result.winner === null ? 0.5 : 0,
  };
}

/** The game's own numbers on a leaderboard row: the share against each baseline, and matches won. */
export function summarize(results: readonly FighterResult[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of GAUNTLET) {
    const vs = results.filter((r) => r.opponent === id);
    if (vs.length) out[`vs${id[9]!.toUpperCase()}${id.slice(10)}`] = Math.round(mean(vs.map((r) => r.score)) * 10) / 10;
  }
  if (results.length) out.matchWinShare = Math.round(mean(results.map((r) => r.matchPoints * 100)) * 10) / 10;
  return out;
}

/** FNV-1a, as text. */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let k = 0; k < text.length; k++) {
    h ^= text.charCodeAt(k);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const FALLBACKS: readonly (FallbackReason | null)[] = [null, 'timeout', 'error', 'invalid', 'illegal'];
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/**
 * Replays a benchmark recording with our code and recomputes its score. The match is rebuilt from its seed (which fixes
 * the baseline and the side), every baseline move is recomputed (never read from the recording), every model move must
 * be legal, offered and made when its fighter could act, every fallback must be the fallback rule's move, answers must
 * have come within the deadline, and the checkpoint hashes, the length and the rounds must match the recording's.
 */
export function verifyGauntlet(rec: unknown, seed: number): Verdict<FighterResult> {
  try {
    return verify(rec, seed);
  } catch (err) {
    return fail(`could not be replayed: ${(err as Error)?.message ?? String(err)}`);
  }
}

function verify(rec: unknown, seed: number): Verdict<FighterResult> {
  if (!isObj(rec)) return fail('not a recording');
  const r = rec as Partial<GauntletRecording> & Record<string, unknown>;
  if (r.format !== 1) return fail('not a fighter recording (format 1)');
  if (!isObj(r.bench)) return fail('not a benchmark match (no bench field)');
  if (r.bench.version !== BENCH_VERSION) return fail(`recorded on bench version ${String(r.bench.version)}, not ${BENCH_VERSION}`);
  if (r.bench.seed !== seed) return fail(`played bench seed ${String(r.bench.seed)}, not ${seed}`);
  const spec = matchSpec(seed);
  if (r.bench.side !== spec.side || r.bench.opponent !== spec.opponent) return fail(`seed ${seed} plays side ${spec.side} against ${spec.opponent}`);
  if (r.seed !== spec.engineSeed) return fail(`seed ${seed} is fight ${spec.engineSeed}, not ${String(r.seed)}`);
  if (r.mode !== BENCH_MODE || r.track !== BENCH_TRACK) return fail(`the benchmark is ${BENCH_MODE} mode, ${BENCH_TRACK} track`);
  if (r.engineVersion !== BENCH_ENGINE) return fail(`recorded on engine v${String(r.engineVersion)}, the benchmark is v${BENCH_ENGINE}`);
  if (JSON.stringify(r.rules ?? null) !== JSON.stringify(BENCH_RULES)) return fail('played with other rules');
  if (r.deadlineMs !== DEADLINE_MS) return fail(`the deadline is ${DEADLINE_MS} ms`);
  if (!Array.isArray(r.decisions) || !Array.isArray(r.checkpoints) || !Number.isInteger(r.ticks) || !isObj(r.result) || !Array.isArray(r.fighters) || r.fighters.length !== 2) return fail('a recording needs fighters, decisions, checkpoints, ticks and a result');
  if (!isObj(r.fighters[1 - spec.side]) || r.fighters[1 - spec.side]!.model !== spec.opponent) return fail(`the other side must be ${spec.opponent}`);
  if (!r.decisions.every((d) => isObj(d) && (d.fighter === 0 || d.fighter === 1))) return fail('every decision names its fighter');
  const side = spec.side;
  const opp = (1 - side) as Side;
  const mine = (r.decisions as Decision[]).filter((d) => d.fighter === side);
  const theirs = (r.decisions as Decision[]).filter((d) => d.fighter === opp);

  const run = new PausedRun({ seed: spec.engineSeed, track: BENCH_TRACK, deadlineMs: DEADLINE_MS, fighters: r.fighters as [FighterMeta, FighterMeta], rules: BENCH_RULES, questionsFor: [opp] });
  let k = 0;
  for (let asks = run.asks(); asks.length; asks = run.asks()) {
    const settled: Settled[] = [];
    let checkMove: MoveId | null = null;
    for (const a of asks) {
      if (a.side === opp) {
        settled.push(baselineSettled(spec.opponent, a));
        continue;
      }
      const d = mine[k++];
      const at = `decision ${k} (tick ${a.tick})`;
      if (!d) return fail(`the recording stops at tick ${a.tick}, where the model had to decide`);
      if (d.appliedTick !== a.tick || d.askedTick !== a.tick || d.questionTick !== a.tick) return fail(`${at}: made at tick ${String(d.appliedTick)}, but the fighter could act at tick ${a.tick}`);
      if (!isMoveId(d.move)) return fail(`${at}: ${String(d.move).slice(0, 40)} is not a move`);
      if (!FALLBACKS.includes(d.fallback)) return fail(`${at}: unknown fallback ${String(d.fallback).slice(0, 40)}`);
      if (!(typeof d.latencyMs === 'number' && Number.isFinite(d.latencyMs) && d.latencyMs >= 0 && d.latencyMs <= DEADLINE_MS)) return fail(`${at}: latency must be between 0 and the ${DEADLINE_MS} ms deadline`);
      if (d.fallback === null || d.fallback === 'illegal') {
        const ans = d.answer as Answer | null;
        if (!isObj(ans) || !isMoveId(ans.move)) return fail(`${at}: an answered decision needs its answer`);
        if (!(ans.costUsd === null || ans.costUsd === undefined || (typeof ans.costUsd === 'number' && Number.isFinite(ans.costUsd) && ans.costUsd >= 0))) return fail(`${at}: cost must be a number of at least 0`);
        if (ans.latencyMs !== d.latencyMs) return fail(`${at}: two latencies`);
        const legal = legalMoves(run.state, side).includes(ans.move);
        if (d.fallback === null) {
          if (ans.move !== d.move) return fail(`${at}: the answer was ${ans.move}, the move ${d.move}`);
          if (!offeredMoves(a.view, side).includes(d.move)) return fail(`${at}: ${d.move} was not offered (not legal or out of reach)`);
        } else if (legal) return fail(`${at}: ${ans.move} was legal, so it is no fallback`);
        settled.push({ answer: { move: ans.move, probabilities: null, latencyMs: d.latencyMs, costUsd: ans.costUsd ?? null } });
      } else {
        if (d.answer !== null) return fail(`${at}: a ${d.fallback} fallback has no answer`);
        settled.push({ reason: d.fallback!, latencyMs: d.latencyMs });
      }
      checkMove = d.move;
    }
    run.apply(settled);
    // The fallback rule's move, recomputed: a recorded fallback must be exactly it.
    if (checkMove !== null) {
      const ours = run.decisions.filter((d) => d.fighter === side).at(-1);
      if (!ours || ours.move !== checkMove) return fail(`decision ${k}: the fallback rule plays ${ours?.move ?? 'nothing'} there, not ${checkMove}`);
    }
  }
  if (k !== mine.length) return fail(`the recording has ${mine.length - k} model decisions after the match ended`);
  const ourTheirs = run.decisions.filter((d) => d.fighter === opp);
  if (ourTheirs.length !== theirs.length || ourTheirs.some((d, n) => d.move !== theirs[n]!.move || d.appliedTick !== theirs[n]!.appliedTick)) return fail(`${spec.opponent} does not play what the recording says`);
  const ours = run.replay();
  if (ours.ticks !== r.ticks) return fail(`the match lasts ${ours.ticks} ticks, the recording says ${r.ticks}`);
  if (JSON.stringify(ours.checkpoints) !== JSON.stringify((r.checkpoints as unknown[]).map((c) => (isObj(c) ? { tick: c.tick, hash: c.hash } : c)))) return fail('a checkpoint hash does not match');
  if (JSON.stringify(ours.result) !== JSON.stringify(r.result)) return fail('the result does not match');
  const result = resultOf(spec, mine, ours.result);
  return { ok: true, result, fingerprint: fnv(`${seed}|${mine.map((d) => `${d.appliedTick}:${d.move}`).join(',')}`) };
}
