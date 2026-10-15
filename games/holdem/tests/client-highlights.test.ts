import { describe, expect, it } from 'vitest';
import { formatCard, parseCards } from '../shared/cards';
import type { HandState } from '../shared/engine';
import type { ReviewHand } from '../src/driver';
import { bestHighlight, biggestPotHighlight, describeHighlight, drawOf, factsOf, headsUpEquity, highlightsOf, potText, scoreOf, titleOf } from '../src/highlights';
import { act, deal } from './support';

/** A finished hand as a review hands it over. */
const review = (s: HandState, hand = 1): ReviewHand => {
  const live = s.seats.filter((p) => p.status !== 'empty').length;
  return { hand, events: s.events, actions: [], runout: s.deck.slice(2 * live, 2 * live + 5).map(formatCard) };
};

const kinds = (s: HandState) =>
  highlightsOf(review(s))
    .map((x) => `${x.kind}:${x.seat}`)
    .sort();

// Heads-up, blinds 10/20: seat 0 has the button, posts the small blind and acts first before the flop; seat 1 first after it.
const hu = (holes: Record<number, string>, board: string) => deal({ stacks: [1000, 1000], button: 0, holes, board });
const names = (...n: string[]) => (i: number) => n[i]!;

describe('bluffs', () => {
  it('a pot-sized bet with nothing that everyone folds to is a bluff that worked', () => {
    let s = hu({ 0: '7c 2d', 1: 'Ah Kh' }, 'Qs 9s 4c 3d 8h');
    s = act(s, 'call', 'check', 'check', 'pot', 'fold');
    const [x] = highlightsOf(review(s));
    expect(kinds(s)).toEqual(['bluff:0']);
    expect(x).toMatchObject({ worked: true, against: 1, featured: 0, street: 'flop', potBb: 2 });
    expect(titleOf(x!)).toBe('Bluff that worked');
    expect(describeHighlight(x!, names('Opus 5.5', 'Haiku 5.5'))).toBe('Opus 5.5 bluffed with nothing on the flop, and Haiku 5.5 folded just a high card. Pot: 2 big blinds.');
  });

  it('called and shown down, it is a bluff, caught', () => {
    let s = hu({ 0: '7c 2d', 1: 'Ah Kh' }, 'Qs 9s 4c 3d 8h');
    s = act(s, 'call', 'check', 'check', 'pot', 'call', 'check', 'check', 'check', 'check');
    const [x] = highlightsOf(review(s));
    expect(kinds(s)).toEqual(['bluff:0']);
    expect(x).toMatchObject({ worked: false, against: 1 });
    expect(titleOf(x!)).toBe('Bluff, caught');
  });

  it('a bet with nothing but a gutshot (4 outs) is still a bluff with nothing', () => {
    // J-T on Q-8-4: only a nine makes the straight.
    let s = hu({ 0: 'Jc Td', 1: 'Ah Kh' }, 'Qs 8s 4c 3d 2h');
    s = act(s, 'call', 'check', 'check', 'pot', 'fold');
    const [x] = highlightsOf(review(s));
    expect(x).toMatchObject({ kind: 'bluff', worked: true });
    expect(describeHighlight(x!, names('Opus 5.5', 'Haiku 5.5'))).toBe('Opus 5.5 bluffed with nothing on the flop, and Haiku 5.5 folded just a high card. Pot: 2 big blinds.');
  });

  it('a small stab is no bluff', () => {
    let s = hu({ 0: '7c 2d', 1: 'Ah Kh' }, 'Qs 9s 4c 3d 8h');
    // A raise to half the pot (heads-up that is less than 2.5 big blinds) and a call: 80 in the pot; then a third of it.
    s = act(s, 'small', 'call', 'check', 'small', 'fold');
    expect(factsOf(review(s)).actions.at(-2)).toMatchObject({ kind: 'bet', potBefore: 80, add: 27 });
    expect(kinds(s)).toEqual([]);
  });

  it('a pair betting into a bigger pair is no bluff', () => {
    let s = hu({ 0: '9s 9d', 1: 'Ts 2d' }, '6d Tc 4c Qh 3s');
    s = act(s, 'call', 'check', 'check', 'allin', 'call');
    expect(kinds(s).filter((k) => k.startsWith('bluff'))).toEqual([]);
  });
});

describe('semi-bluffs', () => {
  // Fable 5.1's flush draw in the Titans' replay: J♦7♦ on 8♥K♦6♦, against two pair.
  const flushDraw = () => hu({ 0: 'Jd 7d', 1: 'Kh 8c' }, '8h Kd 6d 2c 3s');

  it('counts the outs one card ahead: nine for a flush draw, eight for an open-ended straight draw, more for both', () => {
    expect(drawOf(parseCards('Jd7d'), parseCards('8hKd6d'))).toMatchObject({ outs: 9, flush: 9, straight: 0, name: 'a flush draw' });
    expect(drawOf(parseCards('9c8d'), parseCards('7h6sKd'))).toMatchObject({ outs: 8, straight: 8, name: 'a straight draw' });
    expect(drawOf(parseCards('9d8d'), parseCards('7d6sKd'))).toMatchObject({ outs: 15, flush: 9, straight: 6, name: 'a flush and straight draw' });
    expect(drawOf(parseCards('JcTd'), parseCards('Qs8s4c'))).toMatchObject({ outs: 4 });
    // A flush on the board with no flush card in hand is no draw of one's own.
    expect(drawOf(parseCards('Ac2c'), parseCards('Kd8d4d3d')).flush).toBe(0);
    expect(drawOf(parseCards('Jd7d'), parseCards('8hKd6d2c3s')).outs).toBe(0);
  });

  it('shoving a flush draw that is called and misses is a semi-bluff, caught, worded as one', () => {
    let s = flushDraw();
    s = act(s, 'call', 'check', 'check', 'allin', 'call');
    const hs = highlightsOf(review(s));
    expect(hs.map((x) => `${x.kind}:${x.seat}`)).toEqual(['semi_bluff:0']);
    expect(hs[0]).toMatchObject({ worked: false, against: 1, street: 'flop', draw: 'a flush draw', outs: 9, move: 'allin', hit: false, hand2: 'two pair' });
    expect(titleOf(hs[0]!)).toBe('Semi-bluff, caught');
    expect(describeHighlight(hs[0]!, names('Fable 5.1', 'GPT-6 Astra'))).toBe('Fable 5.1 shoved a flush draw on the flop and missed, and GPT-6 Astra called with two pair. Pot: 100 big blinds.');
  });

  it('betting a flush draw that everyone folds to is a semi-bluff that worked', () => {
    let s = flushDraw();
    s = act(s, 'call', 'check', 'check', 'pot', 'fold');
    const [x] = highlightsOf(review(s));
    expect(x).toMatchObject({ kind: 'semi_bluff', worked: true, move: 'bet' });
    expect(titleOf(x!)).toBe('Semi-bluff that worked');
    expect(describeHighlight(x!, names('Fable 5.1', 'GPT-6 Astra'))).toBe('Fable 5.1 bet a flush draw on the flop, and GPT-6 Astra folded two pair. Pot: 2 big blinds.');
  });

  it('a draw that comes in and still loses says so', () => {
    // The flush on the river, against a full house.
    let s = hu({ 0: 'Jd 7d', 1: 'Kh 8c' }, '8h Kd 6d 8d Ks');
    s = act(s, 'call', 'check', 'check', 'allin', 'call');
    const x = highlightsOf(review(s)).find((h) => h.kind === 'semi_bluff');
    expect(x).toMatchObject({ kind: 'semi_bluff', worked: false, hit: true, hand1: 'flush', hand2: 'full house' });
    expect(describeHighlight(x!, names('Fable 5.1', 'GPT-6 Astra'))).toBe('Fable 5.1 shoved a flush draw on the flop and made a flush, but GPT-6 Astra had a full house. Pot: 100 big blinds.');
  });
});

describe('hero calls', () => {
  it('calling a big river bet with one pair, and winning', () => {
    let s = hu({ 0: '7c 2d', 1: 'Ah 3s' }, 'As 9s 4c Kd 8h');
    s = act(s, 'call', 'check', 'check', 'check', 'check', 'check', 'check', 'pot', 'call');
    expect(kinds(s)).toEqual(['bluff:0', 'hero_call:1']);
    const hero = highlightsOf(review(s)).find((x) => x.kind === 'hero_call')!;
    expect(hero).toMatchObject({ against: 0, featured: 1, street: 'river', hand1: 'pair' });
    expect(describeHighlight(hero, names('Sol', 'Luna'))).toBe("Luna called Sol's river bet with a pair, and won 6 big blinds.");
    expect(describeHighlight(hero, names('You', 'Luna'))).toBe('Luna called your river bet with a pair, and won 6 big blinds.');
  });
});

describe('bad beats', () => {
  it('aces all-in before the flop, a king on the river: 81% to win, and lost', () => {
    let s = hu({ 0: 'Ah Ad', 1: 'Kh Kd' }, '2c 7d 9s 3h Kc');
    s = act(s, 'allin', 'call');
    const hs = highlightsOf(review(s));
    expect(hs.map((x) => `${x.kind}:${x.seat}`)).toEqual(['bad_beat:0']);
    expect(hs[0]).toMatchObject({ against: 1, featured: 1, street: 'river', hand1: 'pair', hand2: 'three of a kind', pot: 2000, potBb: 100 });
    expect(hs[0]!.equity).toBeGreaterThan(0.79);
    expect(hs[0]!.equity).toBeLessThan(0.85);
    expect(describeHighlight(hs[0]!, names('Opus', 'Sol'))).toBe("Sol rivered three of a kind against Opus's pair (81% to win). Pot: 100 big blinds.");
    expect(describeHighlight(hs[0]!, names('You', 'Sol'))).toBe('Sol rivered three of a kind against your pair (81% to win). Pot: 100 big blinds.');
    expect(describeHighlight(hs[0]!, names('Opus', 'You'))).toBe("You rivered three of a kind against Opus's pair (81% to win). Pot: 100 big blinds.");
  });

  it('a coin flip lost is no bad beat: queens against ace-king, an ace on the river', () => {
    let s = hu({ 0: 'Qh Qd', 1: 'As Kc' }, '2c 7d 9s 3h Ac');
    s = act(s, 'allin', 'call');
    expect(s.seats[1]!.stack).toBe(2000);
    expect(kinds(s)).toEqual([]);
  });

  it('a pair ahead on the turn is no bad beat either: it needs two pair or better at 75%', () => {
    // Kings against a flush and straight draw on the turn: about two to one, and the queen of hearts makes both.
    let s = hu({ 0: 'Kh Qd', 1: 'Jh Th' }, 'Kc 9h 2h 4s Qh');
    s = act(s, 'call', 'check', 'check', 'check', 'check', 'check', 'check', 'check');
    expect(s.seats[1]!.stack).toBeGreaterThan(1000);
    expect(kinds(s).filter((k) => k.startsWith('bad_beat'))).toEqual([]);
  });
});

describe('folding the winner, coolers and the biggest pot', () => {
  it('folding a hand that would have won, in a pot worth it', () => {
    let s = hu({ 0: '7c 2d', 1: 'Ah Kh' }, 'Qs 9s 4c 7d 2h');
    // A raise, a 3-bet and a call: 360 in the pot (18 big blinds). Then a bet with nothing, and a fold of what would be two pair.
    s = act(s, 'pot', 'pot', 'call', 'half', 'fold');
    expect(kinds(s)).toEqual(['bluff:1', 'folded_winner:0']);
    const fw = highlightsOf(review(s)).find((x) => x.kind === 'folded_winner')!;
    expect(describeHighlight(fw, names('You', 'Clef'))).toBe("You folded on the flop to Clef's bet, and would have won 18 big blinds with two pair.");
  });

  it('two sets colliding are a cooler, not a bad beat', () => {
    let s = hu({ 0: '9s 9d', 1: '7c 7h' }, '9c 7d 2s 4h Jd');
    s = act(s, 'call', 'check', 'allin', 'call');
    const hs = highlightsOf(review(s));
    expect(hs.map((x) => `${x.kind}:${x.seat}`)).toEqual(['cooler:1']);
    expect(hs[0]).toMatchObject({ against: 0, featured: 0 });
    expect(describeHighlight(hs[0]!, names('Fable', 'Astra'))).toBe("Fable's three of a kind beat Astra's three of a kind for 100 big blinds.");
  });

  it('falls back to the biggest pot when a game has no other story', () => {
    let small = hu({ 0: 'Ah Ad', 1: 'Kh Kd' }, '2c 7d 9s 3h Jc');
    small = act(small, 'call', 'check', 'check', 'check', 'check', 'check', 'check', 'check');
    let big = hu({ 0: 'Ah Ad', 1: 'Kh Kd' }, '2c 7d 9s 3h Jc');
    big = act(big, 'pot', 'call', 'check', 'check', 'check', 'check', 'check', 'check');
    const hands = [review(small, 1), review(big, 2)];
    expect(hands.flatMap((h) => highlightsOf(h))).toEqual([]);
    const best = bestHighlight(hands)!;
    expect(best).toMatchObject({ kind: 'biggest_pot', hand: 2, seat: 0, featured: 0, hand1: 'pair' });
    expect(titleOf(best)).toBe('Biggest pot');
    expect(describeHighlight(best, names('Sonnet', 'Haiku'))).toBe('Sonnet won the biggest pot, 6 big blinds, with a pair.');
    expect(biggestPotHighlight([])).toBeNull();
    expect(bestHighlight([])).toBeNull();
  });
});

describe('scoring and the best moment', () => {
  it('weighs a model’s bold play and a human in the hand above the rest', () => {
    // A pot of a tenth of the chips in play.
    const base = scoreOf({ kind: 'bluff', worked: true, seat: 0, against: 1 }, 0.1);
    const model = scoreOf({ kind: 'bluff', worked: true, seat: 0, against: 1 }, 0.1, [{ kind: 'model' }, { kind: 'bot' }]);
    const human = scoreOf({ kind: 'bluff', worked: true, seat: 0, against: 1 }, 0.1, [{ kind: 'bot' }, { kind: 'human' }]);
    const caught = scoreOf({ kind: 'bluff', worked: false, seat: 0, against: 1 }, 0.1);
    expect([base, model, human, caught]).toEqual([30, 45, 39, 16]);
    // A semi-bluff counts a little less than a pure bluff: it had a draw to fall back on.
    expect(scoreOf({ kind: 'semi_bluff', worked: true, seat: 0, against: 1 }, 0.1)).toBe(26);
    expect(scoreOf({ kind: 'semi_bluff', worked: true, seat: 0, against: 1 }, 0.1, [{ kind: 'model' }, { kind: 'bot' }])).toBe(39);
    expect(scoreOf({ kind: 'semi_bluff', worked: false, seat: 0, against: 1 }, 0.1)).toBe(14);
    expect(scoreOf({ kind: 'hero_call', seat: 0, against: 1 }, 0.1, [{ kind: 'model' }, { kind: 'human' }])).toBe(58.5);
    expect(scoreOf({ kind: 'biggest_pot', seat: 0, against: 1 }, 0.1)).toBe(10);
  });

  it('picks the highest score across hands, the biggest pot included', () => {
    let bluff = hu({ 0: '7c 2d', 1: 'Ah Kh' }, 'Qs 9s 4c 3d 8h');
    bluff = act(bluff, 'call', 'check', 'check', 'pot', 'fold');
    let beat = hu({ 0: 'Ah Ad', 1: 'Kh Kd' }, '2c 7d 9s 3h Kc');
    beat = act(beat, 'allin', 'call');
    expect(bestHighlight([review(bluff, 1), review(beat, 2)])).toMatchObject({ kind: 'bad_beat', hand: 2 });
    // A small bluff against a big pot with no story: the pot is the moment.
    let big = hu({ 0: 'Ah Ad', 1: 'Kh Kd' }, '2c 7d 9s 3h Jc');
    big = act(big, 'allin', 'call');
    expect(bestHighlight([review(bluff, 1), review(big, 2)])).toMatchObject({ kind: 'biggest_pot', hand: 2, potBb: 100 });
  });
});

describe('pots against the chips in play', () => {
  it('a late all-in for most of the chips beats an early small hero call, and is told in chips', () => {
    // Early: blinds 10/20, 3000 chips each (150 big blinds deep). A raise and a call, then a river pot bet called with a pair: 18 big blinds.
    let early = deal({ stacks: [3000, 3000], sb: 10, bb: 20, holes: { 0: '7c 2d', 1: 'Ah 3s' }, board: 'As 9s 4c Kd 8h' });
    early = act(early, 'pot', 'call', 'check', 'check', 'check', 'check', 'check', 'pot', 'call');
    const hero = highlightsOf(review(early, 3)).find((x) => x.kind === 'hero_call')!;
    expect(hero).toMatchObject({ pot: 360, potBb: 18, chipsInPlay: 6000, share: 0.06, stackBb: 150 });
    // Late: blinds 150/300, the same chips: 10 big blinds each, all in before the flop. Just the biggest pot, 20 big blinds.
    let late = deal({ stacks: [3000, 3000], sb: 150, bb: 300, holes: { 0: 'Ah Ad', 1: 'Kh Kd' }, board: '2c 7d 9s 3h Jc' });
    late = act(late, 'allin', 'call');
    expect(highlightsOf(review(late, 40))).toEqual([]);
    // In big blinds the hero call would win (18 × 3 against 20 × 1); against the table the all-in is every chip.
    const best = bestHighlight([review(early, 3), review(late, 40)])!;
    expect(best).toMatchObject({ kind: 'biggest_pot', hand: 40, pot: 6000, potBb: 20, share: 1, stackBb: 10 });
    expect(best.score).toBeGreaterThan(hero.score);
    expect(describeHighlight(best, names('Sonnet', 'Haiku'))).toBe('Sonnet won the biggest pot, 6,000 chips, 100% of the chips in play, with a pair.');
    expect(potText(best)).toBe('6,000 chips, 100% of the chips in play');
    // Deep stacks still read in big blinds.
    expect(describeHighlight(hero, names('Sol', 'Luna'))).toBe("Luna called Sol's river bet with a pair, and won 18 big blinds.");
  });
});

describe('heads-up equity', () => {
  it('is exact with one or two cards to come, and close to the known odds before the flop', () => {
    expect(headsUpEquity(parseCards('AhAd'), parseCards('KhKd'), parseCards('2c7d9s3h'))).toBeCloseTo(42 / 44, 5);
    expect(headsUpEquity(parseCards('AhAd'), parseCards('KhKd'), parseCards('2c7d9s3hKc'))).toBe(0);
    const pre = headsUpEquity(parseCards('AhAd'), parseCards('KhKd'), []);
    expect(pre).toBeGreaterThan(0.79);
    expect(pre).toBeLessThan(0.85);
    expect(headsUpEquity(parseCards('AhAd'), parseCards('KhKd'), [])).toBe(pre);
  });
});
