import { describe, expect, it } from 'vitest';
import game from '../game.ts';
import { baselineAdapter } from '../shared/baselines.ts';
import { DEFAULT_RULES } from '../shared/engine/engine.ts';
import { baselineSettled, DEADLINE_MS, engineSeedFor, fightersFor, GAUNTLET, matchSpec, PausedRun, roundShare, verifyGauntlet, type GauntletRecording } from '../shared/gauntlet.ts';
import { instantClock, Match } from '../shared/match.ts';
import type { Decision } from '../shared/replay.ts';
import { fakeModel, playGame } from './support/gauntlet.ts';

describe('the gauntlet', () => {
  it('cycles the baseline, then the side, then the fight, so 102 games are 17 fights against every baseline from both sides', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => matchSpec(game.rules.seedFor(i)))).toMatchObject([
      { opponent: 'baseline/greedy', side: 0 },
      { opponent: 'baseline/payoff', side: 0 },
      { opponent: 'baseline/maximin', side: 0 },
      { opponent: 'baseline/greedy', side: 1 },
      { opponent: 'baseline/payoff', side: 1 },
      { opponent: 'baseline/maximin', side: 1 },
      { opponent: 'baseline/greedy', side: 0, engineSeed: engineSeedFor(1) },
    ]);
    const specs = Array.from({ length: game.rules.officialGames }, (_, i) => matchSpec(game.rules.seedFor(i)));
    const fights = new Set(specs.map((s) => s.engineSeed));
    expect(fights.size).toBe(17);
    for (const f of fights) {
      expect(specs.filter((s) => s.engineSeed === f).map((s) => `${s.opponent}@${s.side}`).sort()).toEqual(GAUNTLET.flatMap((o) => [`${o}@0`, `${o}@1`]).sort());
    }
    expect(game.rules.minGames % 6).toBe(0);
    expect(() => matchSpec(-1)).toThrow();
    expect(() => matchSpec(1.5)).toThrow();
  });

  it('scores the share of rounds won, a drawn round counting half, in percent', () => {
    const r = (winner: 0 | 1 | null) => ({ n: 1, winner, reason: 'time' as const, hp: [50, 50] as [number, number], tick: 0 });
    expect(roundShare([r(0), r(1), r(0)], 0)).toBe(66.67);
    expect(roundShare([r(null), r(1), r(1)], 1)).toBe(83.33);
    expect(roundShare([r(1), r(1)], 0)).toBe(0);
  });

  it('plays paused matches exactly as the live match driver does', async () => {
    // The stepper the bench and the verifier share against shared/match.ts in paused mode, baseline against baseline.
    const spec = { opponent: 'baseline/payoff' as const, side: 0 as const, engineSeed: engineSeedFor(3) };
    const fighters = fightersFor(spec, 'baseline/greedy');
    const match = new Match({ seed: spec.engineSeed, mode: 'paused', deadlineMs: DEADLINE_MS, clock: instantClock, paced: false, rules: DEFAULT_RULES, adapters: [baselineAdapter('baseline/greedy'), baselineAdapter('baseline/payoff')], fighters });
    const live = await match.run();
    const run = new PausedRun({ seed: spec.engineSeed, track: 'assisted', deadlineMs: DEADLINE_MS, fighters, rules: DEFAULT_RULES });
    for (let asks = run.asks(); asks.length; asks = run.asks()) run.apply(asks.map((a) => baselineSettled(a.side === 0 ? 'baseline/greedy' : 'baseline/payoff', a)));
    const stepped = run.replay();
    const strip = (ds: Decision[]) => ds.map(({ question, ...d }) => ({ ...d, options: question.options.map((o) => o.id) }));
    expect(strip(stepped.decisions)).toEqual(strip(live.decisions));
    expect(stepped.checkpoints).toEqual(live.checkpoints);
    expect(stepped.result).toEqual(live.result);
    expect(stepped.ticks).toBe(live.ticks);
  });
});

describe('a recorded benchmark match', async () => {
  // One match of a fake model (with invalid answers and failed calls) against the payoff baseline, from the left.
  const model = fakeModel();
  const { recording, score } = await playGame(1, 'opper/kev-4b', model.transport);
  const seed = game.rules.seedFor(1);
  const copy = (): GauntletRecording => structuredClone(recording);
  const mine = (r: GauntletRecording) => r.decisions.filter((d) => d.fighter === r.bench.side);

  it('sends only requests the service accepts, and records fallbacks for bad answers and failed calls', () => {
    expect(model.calls()).toBeGreaterThan(20);
    expect(model.refused).toEqual([]);
    const reasons = new Set(mine(recording).map((d) => d.fallback));
    expect(reasons).toEqual(new Set([null, 'invalid', 'error']));
    expect(recording.bench).toEqual({ version: game.benchVersion, seed, side: 0, opponent: 'baseline/payoff', model: 'opper/kev-4b' });
    expect(recording.fighters.map((f) => f.model)).toEqual(['opper/kev-4b', 'baseline/payoff']);
  });

  it('replays to the same result, and is the same game however its timings change', () => {
    const v = verifyGauntlet(copy(), seed);
    if (!v.ok) throw new Error(v.error);
    expect(v.result.score).toBe(score);
    expect(v.result.decisions).toBe(mine(recording).length);
    expect(v.result.fallbacks).toBe(mine(recording).filter((d) => d.fallback).length);
    expect(v.result.cost).toBeCloseTo(0.0001 * v.result.calls);
    const slower = copy();
    for (const d of mine(slower)) if (d.answer) d.latencyMs = d.answer.latencyMs = 900;
    const again = verifyGauntlet(slower, seed);
    expect(again.ok && again.fingerprint).toBe(v.fingerprint);
  });

  it('is refused when it was not the match its seed plays', () => {
    expect(verifyGauntlet(copy(), game.rules.seedFor(2))).toMatchObject({ ok: false, error: expect.stringMatching(/seed/) });
    const other = copy();
    other.seed += 1;
    expect(verifyGauntlet(other, seed)).toMatchObject({ ok: false, error: expect.stringMatching(/fight/) });
    const mode = copy();
    mode.mode = 'realtime';
    expect(verifyGauntlet(mode, seed).ok).toBe(false);
    expect(verifyGauntlet(null, seed).ok).toBe(false);
    expect(verifyGauntlet({ format: 1, bench: { version: game.benchVersion, seed, side: 0, opponent: 'baseline/payoff' } }, seed).ok).toBe(false);
  });

  it("recomputes the baseline's moves instead of reading them", () => {
    const r = copy();
    const theirs = r.decisions.find((d) => d.fighter === 1 && d.move !== 'jab')!;
    theirs.move = 'jab';
    expect(verifyGauntlet(r, seed)).toMatchObject({ ok: false, error: expect.stringMatching(/payoff does not play/) });
  });

  it("refuses a model move that was not offered, not made when the fighter could act, or a fallback that is not the rule's", () => {
    const answered = (r: GauntletRecording) => mine(r).find((d) => d.fallback === null && d.question.options.length < 17)!;
    const unoffered = copy();
    const d = answered(unoffered);
    const missing = (['jab', 'sweep', 'throw', 'special', 'uppercut', 'jump_kick', 'high_kick'] as const).find((m) => !d.question.options.some((o) => o.id === m))!;
    d.move = missing;
    d.answer!.move = missing;
    expect(verifyGauntlet(unoffered, seed)).toMatchObject({ ok: false, error: expect.stringMatching(/not offered|legal/) });
    const late = copy();
    mine(late)[3]!.appliedTick += 1;
    expect(verifyGauntlet(late, seed)).toMatchObject({ ok: false, error: expect.stringMatching(/could act at tick/) });
    const fallback = copy();
    const f = mine(fallback).find((x) => x.fallback === 'error')!;
    f.move = f.move === 'jab' ? 'sweep' : 'jab';
    expect(verifyGauntlet(fallback, seed)).toMatchObject({ ok: false, error: expect.stringMatching(/fallback rule/) });
    const slow = copy();
    answered(slow).latencyMs = answered(slow).answer!.latencyMs = DEADLINE_MS + 1;
    expect(verifyGauntlet(slow, seed)).toMatchObject({ ok: false, error: expect.stringMatching(/deadline/) });
  });

  it('refuses a changed result, checkpoint or length', () => {
    const result = copy();
    result.result.rounds[0]!.winner = result.result.rounds[0]!.winner === 0 ? 1 : 0;
    expect(verifyGauntlet(result, seed)).toMatchObject({ ok: false, error: expect.stringMatching(/result/) });
    const hash = copy();
    hash.checkpoints[0]!.hash ^= 1;
    expect(verifyGauntlet(hash, seed)).toMatchObject({ ok: false, error: expect.stringMatching(/checkpoint/) });
    const cut = copy();
    cut.decisions = cut.decisions.slice(0, -4);
    expect(verifyGauntlet(cut, seed).ok).toBe(false);
    const extra = copy();
    extra.decisions.push({ ...mine(extra).at(-1)!, appliedTick: extra.ticks + 5 });
    expect(verifyGauntlet(extra, seed).ok).toBe(false);
  });
});
