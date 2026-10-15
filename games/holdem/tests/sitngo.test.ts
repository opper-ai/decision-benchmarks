import { describe, expect, it } from 'vitest';
import { legalOptions, observe, toAct } from '../shared/engine';
import { act, deal } from './support';
import { DECK } from '../shared/cards';
import { keyBytes, keyedShuffle, keyFromSeed, nextInt } from '../shared/rng';
import { actSitAndGo, blindsAt, bustPlaces, HANDS_PER_LEVEL, knockedOutBy, levelInfo, newSitAndGo, nextHand, stacksOf, type SitAndGo } from '../shared/sitngo';

/** Plays a Sit & Go to its end with random options (folds only now and then, so hands get played out). */
function playRandom(g: SitAndGo, seed: number, onHand?: (g: SitAndGo) => void): SitAndGo {
  let r = seed;
  for (let guard = 0; !g.over; guard++) {
    if (guard > 20000) throw new Error('a Sit & Go that does not end');
    if (toAct(g.hand) === null) {
      onHand?.(g);
      g = nextHand(g);
      continue;
    }
    const options = legalOptions(g.hand);
    let k: number;
    [k, r] = nextInt(r, options.length);
    g = actSitAndGo(g, { key: options[k]!.key });
  }
  onHand?.(g);
  return g;
}

describe('blind levels', () => {
  it('follows the plan: 10/20 up to 150/300, then doubling, antes of an eighth of the big blind from 100/200', () => {
    expect(Array.from({ length: 10 }, (_, i) => blindsAt(i))).toEqual([
      { sb: 10, bb: 20, ante: 0 },
      { sb: 15, bb: 30, ante: 0 },
      { sb: 25, bb: 50, ante: 0 },
      { sb: 50, bb: 100, ante: 0 },
      { sb: 75, bb: 150, ante: 0 },
      { sb: 100, bb: 200, ante: 25 },
      { sb: 150, bb: 300, ante: 38 },
      { sb: 300, bb: 600, ante: 75 },
      { sb: 600, bb: 1200, ante: 150 },
      { sb: 1200, bb: 2400, ante: 300 },
    ]);
  });

  it(`goes up every ${HANDS_PER_LEVEL} hands, counting the hand in play`, () => {
    expect(levelInfo(0)).toEqual({ hand: 1, level: 1, sb: 10, bb: 20, ante: 0, handsUntilNextLevel: 8, next: { sb: 15, bb: 30, ante: 0 } });
    expect(levelInfo(7)).toMatchObject({ hand: 8, level: 1, handsUntilNextLevel: 1 });
    expect(levelInfo(8)).toMatchObject({ hand: 9, level: 2, sb: 15, bb: 30, handsUntilNextLevel: 8 });
    expect(levelInfo(40)).toMatchObject({ level: 6, sb: 100, bb: 200, ante: 25 });
  });
});

describe('a Sit & Go', () => {
  it('seats 2 to 4 players with 1500 chips each and deals the first hand from the table key', () => {
    const g = newSitAndGo({ seats: 4, key: keyFromSeed(5) });
    expect(g.hand.seats.map((p) => p.start)).toEqual([1500, 1500, 1500, 1500]);
    // The whole deck comes from the key's keystream for hand 0; the engine's deck seed plays no part.
    expect(g.hand.deck).toEqual(keyedShuffle(DECK, keyBytes(keyFromSeed(5)), 0));
    expect(g.hand.deckSeed).toBe(0);
    expect(() => newSitAndGo({ seats: 4, key: '5' })).toThrow(/table key/);
    expect(g.hand.level).toMatchObject({ hand: 1, level: 1 });
    expect(observe(g.hand, 0).level).toMatchObject({ handsUntilNextLevel: 8 });
    expect(newSitAndGo({ seats: 4, key: keyFromSeed(5) })).toEqual(g);
    expect(newSitAndGo({ seats: 2, key: keyFromSeed(5), startingStack: 300 }).hand.seats.map((p) => p.start)).toEqual([300, 300]);
    expect(() => newSitAndGo({ seats: 5, key: keyFromSeed(1) })).toThrow();
    expect(() => newSitAndGo({ seats: 1, key: keyFromSeed(1) })).toThrow();
    // The first button comes from the key.
    expect(new Set(Array.from({ length: 40 }, (_, i) => newSitAndGo({ seats: 4, key: keyFromSeed(i) }).button)).size).toBe(4);
  });

  it('deals every hand only from the keystream of its 256-bit table key: one bit of the key changes every deck', () => {
    // A fixed key: with a random one the random players sometimes finish the game in five hands or fewer.
    const key = keyFromSeed(2026);
    const flipped = (parseInt(key[63]!, 16) ^ 1).toString(16);
    const other = key.slice(0, 63) + flipped;
    let hands = 0;
    playRandom(newSitAndGo({ seats: 4, key }), 7, (g) => {
      hands++;
      // The deck is the keyed shuffle for this hand and nothing else: no 32-bit seed sits between the key and the cards.
      expect(g.hand.deck).toEqual(keyedShuffle(DECK, keyBytes(key), g.handIndex));
      expect(g.hand.deckSeed).toBe(0);
      expect(keyedShuffle(DECK, keyBytes(other), g.handIndex)).not.toEqual(g.hand.deck);
    });
    expect(hands).toBeGreaterThan(5);
  });

  it('moves the button to the next seat with chips, and deals each hand from (key, hand number)', () => {
    let g = newSitAndGo({ seats: 3, key: keyFromSeed(11) });
    const first = g.button;
    expect(() => nextHand(g)).toThrow(/not over/);
    while (toAct(g.hand) !== null) g = actSitAndGo(g, { key: legalOptions(g.hand).some((o) => o.key === 'check') ? 'check' : 'fold' });
    g = nextHand(g);
    expect(g.button).toBe((first + 1) % 3);
    expect(g.handIndex).toBe(1);
    expect(g.hand.deck).toEqual(keyedShuffle(DECK, keyBytes(keyFromSeed(11)), 1));
  });

  it('raises the blinds every 8 hands', () => {
    let g = newSitAndGo({ seats: 4, key: keyFromSeed(3) });
    const seen: [number, number][] = [];
    g = playRandom(g, 1, (h) => seen.push([h.handIndex, h.hand.bb]));
    for (const [i, bb] of seen) expect(bb).toBe(blindsAt(Math.floor(i / HANDS_PER_LEVEL)).bb);
  });

  it('places busted players: a bigger stack at the start of the hand places higher, then seat order', () => {
    // Four left; seats 1 and 3 bust in the same hand, seat 3 having started it with more.
    expect(bustPlaces([500, 200, 3000, 300], [1000, 0, 3000, 0])).toEqual([null, 4, null, 3]);
    // Equal stacks: the lower seat places higher.
    expect(bustPlaces([400, 400, 400, 0], [1200, 0, 0, 0])).toEqual([null, 2, 3, null]);
    expect(bustPlaces([400, 400, 400], [400, 800, 0])).toEqual([null, null, 3]);
  });

  it('credits a knockout to the winner of the last pot the busted player could win', () => {
    // Seat 1 (queens) loses the side pot to seat 2 (kings); seat 0 (aces) only wins the main pot.
    const s = act(deal({ stacks: [100, 500, 3000], button: 2, holes: { 0: 'As Ad', 1: 'Qs Qd', 2: 'Ks Kd' }, board: '2c 7h 9d 3s 4c' }), 'allin', 'call', 'call');
    expect(s.street).toBe('done');
    expect(knockedOutBy(s, 1)).toEqual([2]);
    expect(knockedOutBy(s, 0)).toEqual([]);
  });

  it('ends when one player has every chip, with every place given once', () => {
    let doubleBusts = 0;
    for (let i = 0; i < 60; i++) {
      const seats = 2 + (i % 3);
      const g = playRandom(newSitAndGo({ seats, key: keyFromSeed(1000 + i) }), i, (h) => {
        if (h.hand.seats.filter((p) => p.start > 0 && p.stack === 0).length > 1) doubleBusts++;
      });
      expect(g.over).toBe(true);
      expect([...g.places].sort()).toEqual(Array.from({ length: seats }, (_, k) => k + 1));
      expect(stacksOf(g)[g.places.indexOf(1)]).toBe(seats * 1500);
      expect(g.eliminations.map((e) => e.place)).toEqual(Array.from({ length: seats - 1 }, (_, k) => seats - k).sort((a, b) => b - a));
      for (const e of g.eliminations) expect(e.by.length).toBeGreaterThan(0);
      expect(() => actSitAndGo(g, { key: 'fold' })).toThrow(/over/);
      expect(() => nextHand(g)).toThrow(/over/);
    }
    expect(doubleBusts).toBeGreaterThan(0);
  });
});
