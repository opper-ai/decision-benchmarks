// The benchmark: one game is one live match (real time, raw track) of the model under test against one baseline of the
// gauntlet (greedy, payoff, maximin), from one side. The fight runs on the wall clock at its normal speed, as on the
// page: the model is asked ahead, its answer plays when it arrives, and the fallback (block) plays for an answer that
// misses the deadline. The baselines answer at once, on the tick their fighter can act. The score is the model's share
// of the rounds (a drawn round counts half), in percent. The bench plays it (game.ts) with shared/match.ts, the live
// match driver; the submissions check replays it with `verifyGauntlet`, which recomputes every baseline move.
import type { GameResult, Verdict } from '../../../packages/kit/shared/game.ts';
import { mean } from '../../../packages/kit/shared/stats.ts';
import type { Adapter } from './adapter.ts';
import { baselineAnswer, baselineName, isBaseline, type BaselineId } from './baselines.ts';
import { DEFAULT_RULES, ENGINE_VERSION, hashState, isActionable, legalMoves, newGame, step, type GameState, type Inputs, type RoundResult, type Rules, type Side } from './engine/engine.ts';
import { isMoveId, type MoveId } from './engine/moves.ts';
import { fallbackMove } from './fallback.ts';
import { CHECKPOINT_EVERY, instantClock, instantDecision, Match, realClock, type Clock } from './match.ts';
import { modelInfo } from './models.ts';
import type { Track } from './question.ts';
import type { BenchInfo, Decision, FallbackReason, FighterMeta, Replay } from './replay.ts';
import { Perception } from './view.ts';

/**
 * Bump when anything a score depends on changes: the engine (ENGINE_VERSION), the track, the mode, the deadline, the
 * gauntlet, the seeds or the question format. tests/bench-version.test.ts pins them.
 */
export const BENCH_VERSION = 2;
export const GAUNTLET = ['baseline/greedy', 'baseline/payoff', 'baseline/maximin'] as const;
export type GauntletId = (typeof GAUNTLET)[number];
export const BENCH_MODE = 'realtime';
export const BENCH_TRACK: Track = 'raw';
/**
 * How long an answer may take before the fallback (block) plays: the page's live default, and what the game's server
 * gives one model call. The fight does not wait meanwhile: a fighter that can act stands still until its answer comes.
 */
export const DEADLINE_MS = 2000;
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

/** A baseline as the benchmark plays it: instant, deciding on the tick its fighter can act, about what it sees. */
export function benchBaseline(id: BaselineId): Adapter {
  const instant = (q: Parameters<typeof baselineAnswer>[1], view: GameState) => ({ ...baselineAnswer(id, q, view), latencyMs: 0, costUsd: 0 });
  return {
    id,
    kind: 'baseline',
    async warmUp() {},
    async decide(q, _signal, view) {
      return instant(q, view!);
    },
    instant,
  };
}

/** The fighters of a benchmark match: the model on its side, the baseline on the other. */
export function fightersFor(spec: MatchSpec, model: string): [FighterMeta, FighterMeta] {
  const info = modelInfo(model);
  const metas: FighterMeta[] = [];
  metas[spec.side] = { model, label: info.label, kind: info.kind, color: SIDE_COLORS[spec.side] };
  metas[1 - spec.side] = { model: spec.opponent, label: baselineName(spec.opponent), kind: 'baseline', color: SIDE_COLORS[1 - spec.side] };
  return metas as [FighterMeta, FighterMeta];
}

/** A live match on the benchmark's settings (mode, track, deadline, rules) between two players. */
export function benchMatch(o: { seed: number; adapters: [Adapter, Adapter]; fighters: [FighterMeta, FighterMeta]; clock?: Clock; paced?: boolean }): Match {
  return new Match({
    seed: o.seed,
    mode: BENCH_MODE,
    track: BENCH_TRACK,
    deadlineMs: DEADLINE_MS,
    rules: BENCH_RULES,
    adapters: o.adapters,
    fighters: o.fighters,
    maxTokens: [modelInfo(o.fighters[0].model).contextTokens, modelInfo(o.fighters[1].model).contextTokens],
    clock: o.clock ?? realClock,
    paced: o.paced ?? true,
  });
}

/**
 * Plays bench seed `seed`: `adapter` is the model under test (`model` is the id the recording names), on the wall
 * clock (`clock`, for tests). A baseline under test answers at once like the opponent, so its match needs no clock.
 */
export async function playGauntlet(o: { seed: number; model: string; adapter: Adapter; signal?: AbortSignal; clock?: Clock }): Promise<GauntletRecording> {
  const spec = matchSpec(o.seed);
  const adapters: Adapter[] = [];
  adapters[spec.side] = o.adapter;
  adapters[1 - spec.side] = benchBaseline(spec.opponent);
  const instant = Boolean(o.adapter.instant);
  const match = benchMatch({ seed: spec.engineSeed, adapters: adapters as [Adapter, Adapter], fighters: fightersFor(spec, o.model), clock: instant ? instantClock : o.clock, paced: !instant });
  const stop = () => match.stop();
  if (o.signal?.aborted) throw new Error('the match was stopped');
  o.signal?.addEventListener('abort', stop, { once: true });
  try {
    const replay = await match.run();
    if (o.signal?.aborted) throw new Error('the match was stopped');
    return { ...replay, bench: { version: BENCH_VERSION, seed: o.seed, side: spec.side, opponent: spec.opponent, model: o.model } };
  } finally {
    o.signal?.removeEventListener('abort', stop);
  }
}

/** The adapter a baseline under test plays with. */
export const baselineUnderTest = (model: string): Adapter | null => (isBaseline(model) ? benchBaseline(model) : null);

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
 * the baseline and the side) and played tick by tick: every baseline move is recomputed (never read from the
 * recording), every model move must be applied on a tick its fighter could act and be legal there (else it is the
 * fallback rule's move, which is recomputed), answers must have come within the deadline and been played on the first
 * tick the fighter could act after they arrived, and the checkpoint hashes, the length and the rounds must match the
 * recording's. When an answer arrived (its latency) is the one thing a replay cannot check: that is self-reported.
 */
export function verifyGauntlet(rec: unknown, seed: number): Verdict<FighterResult> {
  try {
    return verify(rec, seed);
  } catch (err) {
    return fail(`could not be replayed: ${(err as Error)?.message ?? String(err)}`);
  }
}

const isTick = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isCost = (v: unknown) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

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

  // The model's decisions, each checked on its own before the replay applies them in order.
  let prevApplied = -1;
  for (const [n, d] of mine.entries()) {
    const at = `decision ${n + 1}`;
    if (!isTick(d.askedTick) || !isTick(d.appliedTick) || !isTick(d.arrivedTick)) return fail(`${at}: needs the ticks it was asked, its answer arrived and it was applied`);
    if (!(d.askedTick > prevApplied && d.askedTick <= d.arrivedTick && d.arrivedTick <= d.appliedTick)) return fail(`${at}: asked at tick ${d.askedTick}, arrived at ${d.arrivedTick}, applied at ${d.appliedTick}: out of order`);
    prevApplied = d.appliedTick;
    if (!isMoveId(d.move)) return fail(`${at}: ${String(d.move).slice(0, 40)} is not a move`);
    if (!FALLBACKS.includes(d.fallback)) return fail(`${at}: unknown fallback ${String(d.fallback).slice(0, 40)}`);
    if (!(typeof d.latencyMs === 'number' && Number.isFinite(d.latencyMs) && d.latencyMs >= 0)) return fail(`${at}: latency must be a number of at least 0`);
    if (d.fallback === null || d.fallback === 'illegal') {
      const ans = d.answer;
      if (!isObj(ans) || !isMoveId(ans.move)) return fail(`${at}: an answered decision needs its answer`);
      if (!isCost(ans.costUsd)) return fail(`${at}: cost must be a number of at least 0`);
      if (ans.latencyMs !== d.latencyMs) return fail(`${at}: two latencies`);
      if (d.latencyMs > DEADLINE_MS) return fail(`${at}: answered after the ${DEADLINE_MS} ms deadline`);
      if (!isObj(d.question) || !Array.isArray(d.question.options) || !d.question.options.some((o) => isObj(o) && o.id === ans.move)) return fail(`${at}: ${ans.move} was not one of the options it was asked about`);
      if (d.fallback === null && ans.move !== d.move) return fail(`${at}: the answer was ${ans.move}, the move ${d.move}`);
    } else {
      if (d.answer !== null) return fail(`${at}: a ${d.fallback} fallback has no answer`);
      if (d.fallback === 'timeout' && d.latencyMs < DEADLINE_MS) return fail(`${at}: a timeout before the ${DEADLINE_MS} ms deadline`);
      if (d.fallback !== 'timeout' && d.latencyMs > DEADLINE_MS) return fail(`${at}: settled after the ${DEADLINE_MS} ms deadline, so it was a timeout`);
    }
  }

  // The match, tick by tick: the model's moves from the recording, the baseline's recomputed.
  const s = newGame(spec.engineSeed, BENCH_RULES);
  const perception = new Perception();
  const bot = benchBaseline(spec.opponent).instant!;
  const ourTheirs: Decision[] = [];
  const checkpoints: Replay['checkpoints'] = [];
  let k = 0;
  while (s.round.phase !== 'over') {
    if (s.tick > r.ticks! + 1) return fail(`the match lasts longer than the recording's ${r.ticks} ticks`);
    const inputs: Inputs = [null, null];
    const d = mine[k];
    if (d && d.appliedTick === s.tick) {
      const at = `decision ${k + 1} (tick ${s.tick})`;
      k++;
      if (!isActionable(s, side)) return fail(`${at}: applied when the fighter could not act`);
      const legal = legalMoves(s, side);
      if (d.fallback === null) {
        if (!legal.includes(d.move)) return fail(`${at}: ${d.move} is not legal there`);
      } else {
        if (d.fallback === 'illegal' && legal.includes(d.answer!.move)) return fail(`${at}: ${d.answer!.move} was legal, so it is no fallback`);
        if (d.move !== fallbackMove(s, side)) return fail(`${at}: the fallback rule plays ${fallbackMove(s, side) ?? 'nothing'} there, not ${d.move}`);
      }
      inputs[side] = d.move;
    } else if (d && d.arrivedTick! <= s.tick && d.appliedTick > s.tick && isActionable(s, side)) {
      return fail(`decision ${k + 1}: its answer was in at tick ${d.arrivedTick} and the fighter could act at tick ${s.tick}, but it was applied at tick ${d.appliedTick}`);
    }
    const ours = instantDecision(s, opp, () => perception.view(s, opp), bot, { track: BENCH_TRACK });
    if (ours) {
      inputs[opp] = ours.move;
      ourTheirs.push(ours);
    }
    perception.record(s, inputs);
    step(s, inputs);
    if (s.tick % CHECKPOINT_EVERY === 0) checkpoints.push({ tick: s.tick, hash: hashState(s) });
  }
  if (k !== mine.length) return fail(`the recording has ${mine.length - k} model decisions the match never applied (after it ended, or not in tick order)`);
  if (ourTheirs.length !== theirs.length || ourTheirs.some((d, n) => d.move !== theirs[n]!.move || d.appliedTick !== theirs[n]!.appliedTick)) return fail(`${spec.opponent} does not play what the recording says`);
  if (!checkpoints.length || checkpoints[checkpoints.length - 1]!.tick !== s.tick) checkpoints.push({ tick: s.tick, hash: hashState(s) });
  if (s.tick !== r.ticks) return fail(`the match lasts ${s.tick} ticks, the recording says ${r.ticks}`);
  if (JSON.stringify(checkpoints) !== JSON.stringify((r.checkpoints as unknown[]).map((c) => (isObj(c) ? { tick: c.tick, hash: c.hash } : c)))) return fail('a checkpoint hash does not match');
  const result = { winner: s.winner, rounds: structuredClone(s.results) };
  if (JSON.stringify(result) !== JSON.stringify(r.result)) return fail('the result does not match');
  return { ok: true, result: resultOf(spec, mine, result), fingerprint: fnv(`${seed}|${mine.map((d) => `${d.appliedTick}:${d.move}`).join(',')}`) };
}
