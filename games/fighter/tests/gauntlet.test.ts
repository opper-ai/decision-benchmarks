import { describe, expect, it } from 'vitest';
import game from '../game.ts';
import { benchBaseline, benchMatch, DEADLINE_MS, engineSeedFor, fightersFor, GAUNTLET, matchSpec, roundShare, verifyGauntlet, type GauntletRecording } from '../shared/gauntlet.ts';
import { baselineAnswer } from '../shared/baselines.ts';
import { isActionable } from '../shared/engine/engine.ts';
import { instantClock } from '../shared/match.ts';
import { buildQuestion } from '../shared/question.ts';
import { FakeClock } from './support/fake.ts';
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

  it('plays the baselines the same on either track: on the raw track they work the payoffs out from the state', () => {
    // A baseline is an opponent, not the test, so the raw question (no payoff rows) changes nothing for it.
    const spec = matchSpec(2);
    const match = benchMatch({ seed: spec.engineSeed, adapters: [benchBaseline('baseline/greedy'), benchBaseline('baseline/payoff')], fighters: fightersFor({ ...spec, opponent: 'baseline/payoff' }, 'baseline/greedy'), clock: instantClock, paced: false });
    let compared = 0;
    for (let t = 0; t < 1500 && !match.over; t++) {
      for (const i of [0, 1] as const) {
        if (t % 3 || !isActionable(match.state, i)) continue;
        const view = match.view(i);
        for (const id of GAUNTLET) expect(baselineAnswer(id, buildQuestion(view, i, { track: 'raw' }), view).move).toBe(baselineAnswer(id, buildQuestion(view, i, { track: 'assisted' }), view).move);
        compared++;
      }
      match.tickOnce();
    }
    expect(compared).toBeGreaterThan(10);
    expect(match.decisions.every((d) => d.question.track === 'raw' && d.question.options.every((o) => o.payoff === undefined))).toBe(true);
    expect(new Set(match.decisions.map((d) => d.move)).size).toBeGreaterThan(2);
  });
});

describe('a recorded benchmark match', async () => {
  // One live match of a fake model (with invalid answers, failed calls and late ones) against the payoff baseline, from
  // the left, on a virtual clock.
  const clock = new FakeClock();
  const model = fakeModel(clock, (n) => (n % 11 === 0 ? 2600 : 150 + ((n * 37) % 400)));
  const { recording, score } = await playGame(1, 'opper/kev-4b', model.transport, clock);
  const seed = game.rules.seedFor(1);
  const copy = (): GauntletRecording => structuredClone(recording);
  const mine = (r: GauntletRecording) => r.decisions.filter((d) => d.fighter === r.bench.side);

  it('sends only requests the service accepts, and records fallbacks for bad answers and failed calls', () => {
    expect(model.calls()).toBeGreaterThan(20);
    expect(model.refused).toEqual([]);
    const reasons = new Set(mine(recording).map((d) => d.fallback));
    for (const reason of [null, 'invalid', 'error', 'timeout']) expect(reasons).toContain(reason);
    expect(recording).toMatchObject({ mode: 'realtime', track: 'raw', deadlineMs: DEADLINE_MS });
    expect(mine(recording).every((d) => d.question.track === 'raw' && d.question.options.every((o) => o.payoff === undefined))).toBe(true);
    // Asked ahead: some questions describe a moment after the tick they were asked on.
    expect(mine(recording).some((d) => d.questionTick > d.askedTick)).toBe(true);
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
    mode.mode = 'paused';
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

  it('refuses a model move it was not asked about, not applied when the fighter could act or as soon as it could, or a fallback that is not the rule\'s', () => {
    const answered = (r: GauntletRecording) => mine(r).find((d) => d.fallback === null && d.question.options.length < 17)!;
    const unoffered = copy();
    const d = answered(unoffered);
    const missing = (['jab', 'sweep', 'throw', 'special', 'uppercut', 'jump_kick', 'high_kick'] as const).find((m) => !d.question.options.some((o) => o.id === m))!;
    d.move = missing;
    d.answer!.move = missing;
    expect(verifyGauntlet(unoffered, seed)).toMatchObject({ ok: false, error: expect.stringMatching(/not one of the options/) });
    const busy = copy();
    // Two frames into an attack the fighter is busy: no move can start there.
    const k = mine(busy).findIndex((x, n) => n > 0 && ['jab', 'straight', 'sweep', 'low_kick', 'high_kick'].includes(mine(busy)[n - 1]!.move));
    const prev = mine(busy)[k - 1]!.appliedTick;
    Object.assign(mine(busy)[k]!, { askedTick: prev + 1, arrivedTick: prev + 2, appliedTick: prev + 2 });
    expect(verifyGauntlet(busy, seed)).toMatchObject({ ok: false, error: expect.stringMatching(/could not act/) });
    // An answer that was in while its fighter stood waiting must play at once.
    const held = copy();
    // Asked ahead about tick questionTick, the answer came later: the fighter stood waiting until it did.
    const waited = mine(held).find((x) => x.arrivedTick! > x.questionTick + 2 && x.arrivedTick === x.appliedTick)!;
    waited.arrivedTick = waited.appliedTick - 1;
    expect(verifyGauntlet(held, seed)).toMatchObject({ ok: false, error: expect.stringMatching(/was in at tick/) });
    const fallback = copy();
    const f = mine(fallback).find((x) => x.fallback === 'error')!;
    f.move = f.move === 'jab' ? 'sweep' : 'jab';
    expect(verifyGauntlet(fallback, seed)).toMatchObject({ ok: false, error: expect.stringMatching(/fallback rule/) });
    const slow = copy();
    answered(slow).latencyMs = answered(slow).answer!.latencyMs = DEADLINE_MS + 1;
    expect(verifyGauntlet(slow, seed)).toMatchObject({ ok: false, error: expect.stringMatching(/deadline/) });
    const early = copy();
    mine(early).find((x) => x.fallback === 'timeout')!.latencyMs = DEADLINE_MS - 1;
    expect(verifyGauntlet(early, seed)).toMatchObject({ ok: false, error: expect.stringMatching(/timeout before/) });
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
