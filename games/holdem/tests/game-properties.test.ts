// Many seeded Sit & Gos and duplicate sets with bots, stand-in models and humans: every one ends, conserves chips at
// every step, plays only legal options, replays to the same events, verifies, and is refused once tampered with.
import { describe, expect, it } from 'vitest';
import { BOT_NAMES } from '../shared/bots';
import { applyAction, chipsOf, legalOptions, newHand, toAct, type HandState, type OptionKey } from '../shared/engine';
import { replay, verifyRecording, type Player, type Recording } from '../shared/recording';
import { nextInt } from '../shared/rng';
import { actSitAndGo, newSitAndGo, nextHand, type SitAndGo } from '../shared/sitngo';
import { playDuplicate, playSitAndGo } from './support';

/** A seeded table of 2 to 4: bots, a stand-in model and sometimes a human. */
function lineup(i: number): Player[] {
  let r = i * 2654435761;
  const pick = (n: number) => {
    let v: number;
    [v, r] = nextInt(r, n);
    return v;
  };
  const n = 2 + pick(3);
  return Array.from({ length: n }, (_, seat): Player => {
    const k = pick(6);
    return k < 4 ? { kind: 'bot', id: BOT_NAMES[k]! } : k === 4 || seat === 0 ? { kind: 'model', id: `model-${seat}` } : { kind: 'human', id: 'you' };
  });
}

/** Steps through a recorded Sit & Go, checking chips and legality before every action. */
function stepThrough(rec: Recording): number {
  const total = rec.players.length * rec.sitngo!.startingStack;
  let g: SitAndGo = newSitAndGo({ seats: rec.players.length, key: rec.sitngo!.key });
  let actions = 0;
  rec.hands.forEach((hand, h) => {
    if (h > 0) g = nextHand(g);
    for (const x of hand.actions) {
      expect(chipsOf(g.hand)).toBe(total);
      if (x.key) expect(legalOptions(g.hand).map((o) => o.key)).toContain(x.key);
      g = actSitAndGo(g, x.key ? { key: x.key } : { kind: 'raise', to: x.to! });
      actions++;
    }
    expect(toAct(g.hand)).toBeNull();
    expect(chipsOf(g.hand)).toBe(total);
  });
  expect(g.over).toBe(true);
  return actions;
}

/** The hand state before action `a` of hand `h`. */
function before(rec: Recording, h: number, a: number): HandState {
  if (rec.mode === 'cash') {
    const hand = rec.hands[h]!;
    let s = newHand({ stacks: hand.seating!.map(() => rec.cash!.stack), button: hand.button!, sb: rec.cash!.sb, bb: rec.cash!.bb, ante: rec.cash!.ante, deckSeed: hand.deckSeed! });
    for (const x of hand.actions.slice(0, a)) s = applyAction(s, x.key ? { key: x.key } : { kind: 'raise', to: x.to! });
    return s;
  }
  let g: SitAndGo = newSitAndGo({ seats: rec.players.length, key: rec.sitngo!.key });
  rec.hands.forEach((hand, i) => {
    if (i > h) return;
    if (i > 0) g = nextHand(g);
    for (const x of i < h ? hand.actions : hand.actions.slice(0, a)) g = actSitAndGo(g, x.key ? { key: x.key } : { kind: 'raise', to: x.to! });
  });
  return g.hand;
}

function tamper(rec: Recording, i: number): void {
  const all = rec.hands.flatMap((hand, h) => hand.actions.map((x, a) => ({ x, h, a })));
  const bots = all.filter((y) => y.x.by === 'bot');
  // A bot move changed to another legal option.
  if (bots.length) {
    const { x, h, a } = bots[i % bots.length]!;
    const copy = structuredClone(rec);
    const other = legalOptions(before(rec, h, a)).find((o) => o.key !== x.key)!.key;
    copy.hands[h]!.actions[a]!.key = other;
    expect(verifyRecording(copy).ok).toBe(false);
  }
  // Any move changed to one that is not legal there.
  const { h, a } = all[i % all.length]!;
  const legal = new Set(legalOptions(before(rec, h, a)).map((o) => o.key));
  const illegal = (['fold', 'check', 'call'] as OptionKey[]).find((k) => !legal.has(k))!;
  const copy = structuredClone(rec);
  delete copy.hands[h]!.actions[a]!.to;
  copy.hands[h]!.actions[a]!.key = illegal;
  expect(verifyRecording(copy).ok).toBe(false);
  // A claimed result moved by one chip.
  const result = structuredClone(rec);
  result.result.chips[0]! += 1;
  result.result.chips[1]! -= 1;
  expect(verifyRecording(result).ok).toBe(false);
}

describe('Sit & Gos with every kind of player', () => {
  it('end, conserve chips, replay and verify, and refuse tampering', () => {
    let hands = 0;
    let actions = 0;
    const fingerprints = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const { recording, events } = playSitAndGo(lineup(i), 5000 + i, i);
      actions += stepThrough(recording);
      hands += recording.hands.length;
      expect(replay(recording).hands.map((h) => h.events)).toEqual(events);
      const v = verifyRecording(recording);
      expect(v.ok, v.ok ? '' : v.error).toBe(true);
      if (v.ok) fingerprints.add(v.fingerprint);
      if (i % 4 === 0) tamper(recording, i);
    }
    expect(fingerprints.size).toBe(300);
    expect(hands).toBeGreaterThan(4000);
    expect(actions).toBeGreaterThan(20000);
  });
});

describe('duplicate cash sets', () => {
  it('replay and verify, and refuse tampering', () => {
    for (let i = 0; i < 30; i++) {
      const players = lineup(i + 1000);
      const { recording, events } = playDuplicate(players, 4, i + 1);
      expect(replay(recording).hands.map((h) => h.events)).toEqual(events);
      expect(recording.result.chips.reduce((a, b) => a + b, 0)).toBe(0);
      expect(verifyRecording(recording).ok).toBe(true);
      if (i % 3 === 0) tamper(recording, i);
    }
  });
});
