import { describe, expect, it } from 'vitest';
import { legalOptions, observe } from '../shared/engine';
import { audio } from '../src/audio';
import type { HumanTurn } from '../src/driver';
import { isRouteHash } from '../src/route-hash';
import { amountAt, positionOf, raisePlan, snap } from '../src/views/actions';
import { act, deal } from './support';

/** The human's turn at seat `seat` of a hand, as a driver hands it to the bar. */
function turnOf(s: ReturnType<typeof deal>, seat: number): HumanTurn {
  const o = observe(s, seat);
  const p = s.seats[seat]!;
  return { seat, options: legalOptions(s), toCall: o.toCall, raise: o.minRaiseTo === null ? null : { min: o.minRaiseTo, max: p.bet + p.stack } };
}

describe('the raise panel', () => {
  it('runs from the minimum raise to all-in, steps by the minimum raise, and marks the menu’s sizes', () => {
    // Four-handed, the first to act faces the big blind of 20 with 30 in the pot.
    const s = deal({ stacks: [1000, 1000, 1000, 1000], button: 0 });
    const plan = raisePlan(turnOf(s, 3), { pot: 30, bb: 20 });
    expect(plan).toMatchObject({ min: 40, max: 1000, step: 20, currentBet: 20, bet: false });
    // Unopened four-handed, half the pot (45) is less than 2.5 big blinds, so it is the smallest size.
    expect(plan.ticks.map((t) => [t.label, t.to])).toEqual([['½', 45], ['¾', 58], ['Pot', 70]]);
    // On a phone the sizes are quick picks in the panel, named in full.
    expect(plan.quick.map((t) => [t.label, t.to])).toEqual([['½ pot', 45], ['¾ pot', 58], ['Pot', 70]]);
    // A size as a share of the pot: what it adds over the call, against the pot after calling.
    expect(plan.share(70)).toBe(Math.round((100 * 50) / 50));
  });

  it('after the flop it is a bet, and the step is the big blind', () => {
    let s = deal({ stacks: [1000, 1000], button: 0 });
    s = act(s, 'call', 'check');
    const plan = raisePlan(turnOf(s, 1), { pot: 40, bb: 20 });
    expect(plan).toMatchObject({ min: 20, bet: true, step: 20, currentBet: 0 });
    expect(plan.share(20)).toBe(50);
  });

  it('gives the small raises most of the track, and snaps to a size within 2% of it', () => {
    const plan = { min: 40, max: 1000, ticks: [{ to: 70 }, { to: 100 }] };
    // A cube: 100 chips, 6% of the range, sits two fifths along the track.
    expect(positionOf(100, plan)).toBeCloseTo(Math.cbrt(60 / 960), 6);
    expect(positionOf(40, plan)).toBe(0);
    expect(positionOf(1000, plan)).toBe(1);
    for (const a of [40, 55, 100, 333, 1000]) expect(amountAt(positionOf(a, plan), plan)).toBe(a);
    expect(snap(97, plan)).toBe(100);
    expect(snap(85, plan)).toBe(85);
    expect(snap(71, plan)).toBe(70);
    expect(snap(5, plan)).toBe(40);
    expect(snap(5000, plan)).toBe(1000);
  });
});

describe('page plumbing', () => {
  it('tells a replay’s address from the lobby’s', () => {
    expect(['#/r/AQQ', '#/demo/x.json.gz', '#/still/x.json.gz?hand=3'].every(isRouteHash)).toBe(true);
    expect(['', '#', '#leaderboard', '#/r/', '#/replays'].some(isRouteHash)).toBe(false);
  });

  it('lets a game stop listening to the sound switch', () => {
    let calls = 0;
    const off = audio.onChange(() => calls++);
    audio.set(false);
    off();
    audio.set(false);
    expect(calls).toBe(1);
  });
});
