// Thousands of seeded random hands with random players: whatever they do, the engine keeps its invariants.
import { describe, expect, it } from 'vitest';
import { applyAction, chipsOf, legalOptions, newHand, observe, toAct, type Action, type HandState } from '../shared/engine';
import { mulberry32, nextInt } from '../shared/rng';

/** A random table: 2 to 6 seats, some empty, short and deep stacks, sometimes antes. */
function randomHand(seed: number): HandState {
  let r = seed;
  const pick = (n: number) => {
    let v: number;
    [v, r] = nextInt(r, n);
    return v;
  };
  for (;;) {
    const n = 2 + pick(5);
    const stacks = Array.from({ length: n }, () => [0, 1 + pick(30), 50 + pick(500), 1000 + pick(3000)][pick(4)]!);
    if (stacks.filter((x) => x > 0).length < 2) continue;
    const live = stacks.flatMap((x, i) => (x > 0 ? [i] : []));
    const bb = [2, 20, 50, 200][pick(4)]!;
    return newHand({ stacks, button: live[pick(live.length)]!, sb: bb / 2, bb, ante: pick(3) === 0 ? Math.round(bb / 8) : 0, deckSeed: r });
  }
}

/** Plays a hand to its end with random options (and now and then a raise to a random legal amount). */
function playRandom(s: HandState, seed: number, check: (before: HandState, a: Action, after: HandState) => void): HandState {
  let r = seed;
  for (let guard = 0; toAct(s) !== null; guard++) {
    if (guard > 200) throw new Error('a hand that does not end');
    const options = legalOptions(s);
    let k: number;
    [k, r] = nextInt(r, options.length + 1);
    let a: Action;
    const o = observe(s, toAct(s)!);
    if (k === options.length && o.minRaiseTo !== null) {
      const max = options.at(-1)!.to;
      let x: number;
      [x, r] = nextInt(r, max - o.minRaiseTo + 1);
      a = { kind: 'raise', to: o.minRaiseTo + x };
    } else a = { key: options[Math.min(k, options.length - 1)]!.key };
    const next = applyAction(s, a);
    check(s, a, next);
    s = next;
  }
  return s;
}

describe('random hands', () => {
  it('conserve chips, play only legal options, never go negative, and always end with every pot awarded', () => {
    let showdowns = 0;
    let sidePots = 0;
    let splits = 0;
    for (let i = 0; i < 3000; i++) {
      const start = randomHand(mulberry32(i)[1]);
      const total = chipsOf(start);
      const end = playRandom(start, i * 7919, (before, a, after) => {
        const seat = toAct(before)!;
        expect(chipsOf(after)).toBe(total);
        if ('key' in a) expect(legalOptions(before).map((o) => o.key)).toContain(a.key);
        // The sizes rise in menu order: small is always the smallest raise, all-in the biggest.
        const raises = legalOptions(before).filter((o) => o.kind === 'bet' || o.kind === 'raise' || o.kind === 'allin').map((o) => o.to);
        expect(raises).toEqual([...new Set(raises)].sort((x, y) => x - y));
        const rec = after.actions.at(-1)!;
        expect(rec.seat).toBe(seat);
        expect(after.seats.every((p) => p.stack >= 0 && p.bet >= 0)).toBe(true);
        if (toAct(after) !== null) {
          expect(after.seats[toAct(after)!]!.status).toBe('active');
          expect(legalOptions(after).length).toBeGreaterThan(1);
        }
      });
      expect(end.street).toBe('done');
      expect(end.seats.reduce((a, p) => a + p.stack, 0)).toBe(total);
      const awards = end.events.filter((e) => e.type === 'award');
      const returned = end.events.reduce((a, e) => a + (e.type === 'return' ? e.amount : 0), 0);
      const put = end.seats.reduce((a, p) => a + p.committed, 0);
      expect(awards.reduce((a, e) => a + (e.type === 'award' ? e.amount : 0), 0)).toBe(put);
      expect(end.events.at(-1)!.type).toBe('end');
      for (const e of awards) if (e.type === 'award') expect(e.shares.reduce((a, b) => a + b, 0)).toBe(e.amount);
      // Every seat's chips: what it started with, less what it put in (returns already taken off), plus its winnings.
      const won = end.seats.map((_, seat) => awards.reduce((a, e) => a + (e.type === 'award' ? e.shares[e.winners.indexOf(seat)] ?? 0 : 0), 0));
      end.seats.forEach((p, seat) => expect(p.stack).toBe(p.start - p.committed + won[seat]!));
      expect(returned).toBeGreaterThanOrEqual(0);
      if (end.events.some((e) => e.type === 'showdown')) showdowns++;
      if (awards.length > 1) sidePots++;
      if (awards.some((e) => e.type === 'award' && e.winners.length > 1)) splits++;
    }
    // The random tables reach every kind of ending.
    expect(showdowns).toBeGreaterThan(300);
    expect(sidePots).toBeGreaterThan(50);
    expect(splits).toBeGreaterThan(10);
  });

  it('replay the same from the same seed and actions', () => {
    for (let i = 0; i < 200; i++) {
      const actions: Action[] = [];
      const a = playRandom(randomHand(i), i, (_b, act) => actions.push(act));
      let b = randomHand(i);
      for (const act of actions) b = applyAction(b, act);
      expect(b).toEqual(a);
    }
  });
});
