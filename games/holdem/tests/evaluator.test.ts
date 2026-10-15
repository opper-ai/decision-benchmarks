import { describe, expect, it } from 'vitest';
import { formatCards, parseCards, rankOf, suitOf, type Card } from '../shared/cards';
import { CATEGORIES, categoryOf, evaluate, rankHand, type Category } from '../shared/evaluator';
import { mulberry32, shuffle } from '../shared/rng';
import { DECK } from '../shared/cards';

const value = (text: string) => evaluate(parseCards(text));
const category = (text: string) => rankHand(parseCards(text)).category;

/** An independent, slow five-card ranking: [category index, tie-break ranks...], compared as a list. */
function reference(cards: readonly Card[]): number[] {
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const flush = new Set(cards.map(suitOf)).size === 1;
  const distinct = [...new Set(ranks)];
  let straightTop = -1;
  if (distinct.length === 5 && ranks[0]! - ranks[4]! === 4) straightTop = ranks[0]!;
  if (distinct.length === 5 && ranks.join() === '12,3,2,1,0') straightTop = 3;
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map((g) => g[1]).join('');
  const byGroup = groups.map((g) => g[0]);
  if (straightTop >= 0 && flush) return [8, straightTop];
  if (shape === '41') return [7, ...byGroup];
  if (shape === '32') return [6, ...byGroup];
  if (flush) return [5, ...ranks];
  if (straightTop >= 0) return [4, straightTop];
  if (shape === '311') return [3, ...byGroup];
  if (shape === '221') return [2, ...byGroup];
  if (shape === '2111') return [1, ...byGroup];
  return [0, ...ranks];
}
const compare = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) - (b[i] ?? -1);
  return 0;
};

function* subsets<T>(items: readonly T[], k: number, start = 0, picked: T[] = []): Generator<T[]> {
  if (picked.length === k) {
    yield [...picked];
    return;
  }
  for (let i = start; i < items.length; i++) {
    picked.push(items[i]!);
    yield* subsets(items, k, i + 1, picked);
    picked.pop();
  }
}

describe('categories', () => {
  const examples: [string, Category][] = [
    ['As Kd 9h 7c 3s 2d 4h', 'high card'],
    ['As Ad 9h 7c 3s 2d Jh', 'pair'],
    ['As Ad 9h 9c 3s 2d Jh', 'two pair'],
    ['As Ad Ah 9c 3s 2d Jh', 'three of a kind'],
    ['5s 6d 7h 8c 9s Ad Ah', 'straight'],
    ['As 2d 3h 4c 5s Kd Kh', 'straight'],
    ['As 9s 3s 4s 7s Kd Kh', 'flush'],
    ['As Ad Ah 9c 9s 2d Jh', 'full house'],
    ['As Ad Ah Ac 9s 2d Jh', 'four of a kind'],
    ['5h 6h 7h 8h 9h Ad Ah', 'straight flush'],
    ['Ah 2h 3h 4h 5h Kd Kc', 'straight flush'],
    ['Ts Js Qs Ks As', 'straight flush'],
  ];
  it.each(examples)('%s is a %s', (cards, cat) => expect(category(cards)).toBe(cat));

  it('ranks the categories in order, whatever the cards', () => {
    const vs = examples.filter((_, i) => i !== 5 && i !== 10 && i !== 11).map(([c]) => value(c));
    expect([...vs].sort((a, b) => a - b)).toEqual(vs);
    expect(CATEGORIES.map((_, i) => i)).toEqual(vs.map(categoryOf).map((c) => CATEGORIES.indexOf(c)));
  });
});

describe('comparisons', () => {
  it('compares kickers, all five of them and no more', () => {
    expect(value('As Ad Kh 9c 3s 2d 4h')).toBeGreaterThan(value('As Ad Qh 9c 3s 2d 4h'));
    expect(value('Ks Kd Ah 9c 7s 2d 4h')).toBeGreaterThan(value('Ks Kd Ah 9c 6s 2d 4h'));
    // The sixth and seventh cards play no part.
    expect(value('Ks Kd Ah 9c 7s 3d 2h')).toBe(value('Ks Kd Ah 9c 7s 4d 2h'));
    // Two pair: the higher pair, then the lower, then the kicker (a third pair can be the kicker).
    expect(value('As Ad 3h 3c Ks 2d 4h')).toBeGreaterThan(value('Ks Kd Qh Qc As 2d 4h'));
    expect(value('9s 9d 5h 5c 4s 4d Ah')).toBeGreaterThan(value('9s 9d 5h 5c 4s 4d Kh'));
    expect(category('9s 9d 5h 5c Qs Qd 2h')).toBe('two pair');
    expect(value('9s 9d 5h 5c Qs Qd 2h')).toBe(value('Qs Qd 9h 9c 5s 2c 3h'));
    // Full house: trips first; two sets make a full house of the higher.
    expect(value('2s 2d 2h Ac Ad 7s 8h')).toBeLessThan(value('3s 3d 3h 4c 4d 7s 8h'));
    expect(value('Ks Kd Kh 7c 7d 7s 2h')).toBe(value('Ks Kd Kh 7c 7d 2s 3h'));
    expect(value('Ks Kd Kh 7c 7d 7s 2h')).toBeLessThan(value('Ks Kd Kh Ac Ad 2s 3h'));
    // Quads take the best kicker, even from a pair.
    expect(value('9s 9d 9h 9c As 2d 2h')).toBeGreaterThan(value('9s 9d 9h 9c Ks Qd Qh'));
    // Flushes compare all five cards of the suit.
    expect(value('As Ks 9s 5s 3s Qd Qh')).toBeGreaterThan(value('As Ks 9s 5s 2s Qd Jh'));
  });

  it('counts the wheel as the lowest straight, and the steel wheel as the lowest straight flush', () => {
    expect(value('As 2d 3h 4c 5s Kd 9h')).toBeLessThan(value('2s 3d 4h 5c 6s Kd 9h'));
    expect(value('As 2d 3h 4c 5s 6d 9h')).toBe(value('2s 3d 4h 5c 6s Kd 9h'));
    expect(value('Ah 2h 3h 4h 5h Kd Kc')).toBeLessThan(value('2h 3h 4h 5h 6h Kd Kc'));
    expect(value('Ah 2h 3h 4h 5h Kd Kc')).toBeGreaterThan(value('As Ad Ah Ac Ks 2d 2c'));
    // Ace-high wraps no further: Q K A 2 3 is no straight.
    expect(category('Qs Kd Ah 2c 3s 8d 9h')).toBe('high card');
  });

  it('plays the straight flush over a bigger plain straight, and the flush over the straight', () => {
    expect(category('5h 6h 7h 8h 9h Td Jc')).toBe('straight flush');
    expect(value('2s 6s 9s Js Ks Qd Th')).toBeGreaterThan(value('9s Td Jh Qc Kd As 2c'));
    expect(category('Ts Jd Qh Kc As 3s 5s')).toBe('straight');
    expect(category('Ts Jd Qs Kc As 3s 5s')).toBe('flush');
  });

  it('splits when the board plays', () => {
    const board = 'Ts Jd Qh Kc As';
    expect(value(`${board} 2c 3d`)).toBe(value(`${board} 4c 9d`));
    expect(value('Ks Kd Kh 7c 7d 2s 3h')).toBe(value('Ks Kd Kh 7c 7d 4s 5h'));
  });
});

describe('the best five', () => {
  it('names the five cards that play, in the order they read', () => {
    expect(formatCards(rankHand(parseCards('2s 2d Kh 7c Kd 9s 3h')).best)).toBe('Kh Kd 2s 2d 9s');
    expect(formatCards(rankHand(parseCards('As 2d 3h 4c 5s Kd 9h')).best)).toBe('5s 4c 3h 2d As');
    expect(formatCards(rankHand(parseCards('As 9s 3s 4s 7s 2s Kh')).best)).toBe('As 9s 7s 4s 3s');
    expect(rankHand(parseCards('Ks Kd Kh 7c 7d 7s 2h')).best.map(rankOf)).toEqual([11, 11, 11, 5, 5]);
  });

  it('evaluates five and six cards too', () => {
    expect(category('As Ad Ah Ac 9s')).toBe('four of a kind');
    expect(category('As Ad Ah 9c 9s 2d')).toBe('full house');
    expect(() => evaluate(parseCards('As Ad Ah 9c'))).toThrow();
  });
});

describe('properties', () => {
  it('agrees with a slow reference on random five-card hands', () => {
    let s = 1;
    for (let i = 0; i < 4000; i++) {
      const a = shuffle(DECK, (s = mulberry32(s)[1])).slice(0, 5);
      const b = shuffle(DECK, (s = mulberry32(s)[1])).slice(0, 5);
      expect(Math.sign(evaluate(a) - evaluate(b)), `${formatCards(a)} vs ${formatCards(b)}`).toBe(Math.sign(compare(reference(a), reference(b))));
      expect(CATEGORIES.indexOf(categoryOf(evaluate(a)))).toBe(reference(a)[0]);
    }
  });

  it('gives seven cards the best of their 21 fives, and six cards the best of their 6', () => {
    for (let i = 0; i < 3000; i++) {
      const cards = shuffle(DECK, 1000 + i).slice(0, 7);
      const best = Math.max(...[...subsets(cards, 5)].map(evaluate));
      expect(evaluate(cards), formatCards(cards)).toBe(best);
      expect(evaluate(rankHand(cards).best)).toBe(best);
      const six = cards.slice(0, 6);
      expect(evaluate(six)).toBe(Math.max(...[...subsets(six, 5)].map(evaluate)));
    }
  });

  it('is quick enough for bots that sample', () => {
    const hands = Array.from({ length: 1000 }, (_, i) => shuffle(DECK, i).slice(0, 7));
    const t = performance.now();
    let n = 0;
    for (let k = 0; k < 200; k++) for (const h of hands) n += evaluate(h) & 1;
    const perSecond = 200_000 / ((performance.now() - t) / 1000);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(perSecond).toBeGreaterThan(300_000);
  });
});
