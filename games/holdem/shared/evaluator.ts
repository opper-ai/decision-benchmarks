// Poker hand values: the best five of five, six or seven cards as one number, higher wins and equal splits. Fast
// enough for bots that sample thousands of run-outs a decision (a few million hands a second in V8), because it works
// on rank bit masks with no allocation. Isomorphic.
import { rankOf, type Card } from './cards.ts';

export type Category = 'high card' | 'pair' | 'two pair' | 'three of a kind' | 'straight' | 'flush' | 'full house' | 'four of a kind' | 'straight flush';
/** Weakest first: a value's category is its index here. */
export const CATEGORIES: readonly Category[] = ['high card', 'pair', 'two pair', 'three of a kind', 'straight', 'flush', 'full house', 'four of a kind', 'straight flush'];

// A value is the category in bits 20 and up, then up to five ranks of four bits each, the most significant first:
// the ranks that decide ties in the order they count (a full house: the trips, then the pair; two pair: the higher
// pair, the lower, the kicker; a straight: its top card, 3 for the wheel A-2-3-4-5).
const CAT = 20;

/** Scratch counts per rank (the module is single-threaded and evaluate never re-enters, so sharing it is safe). */
const counts = new Uint8Array(13);

const bitCount = (m: number): number => {
  let n = 0;
  for (; m; m &= m - 1) n++;
  return n;
};

/** The top card of the best straight in a rank mask, 3 for the wheel, or -1. */
function straightTop(mask: number): number {
  for (let top = 12; top >= 4; top--) if (((mask >> (top - 4)) & 31) === 31) return top;
  return (mask & 0x100f) === 0x100f ? 3 : -1;
}

/** The `k` highest ranks in `mask`, packed four bits each from bit `shift` down. */
function highest(mask: number, k: number, shift: number): number {
  let v = 0;
  for (let r = 12; r >= 0 && k > 0; r--) {
    if (mask & (1 << r)) {
      v |= r << shift;
      shift -= 4;
      k--;
    }
  }
  return v;
}

/** The value of the best five of `cards` (five to seven of them). */
export function evaluate(cards: readonly Card[]): number {
  const n = cards.length;
  if (n < 5 || n > 7) throw new Error(`evaluate takes 5 to 7 cards, not ${n}`);
  counts.fill(0);
  let all = 0;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  for (let i = 0; i < n; i++) {
    const c = cards[i]!;
    const r = c >> 2;
    const bit = 1 << r;
    counts[r]!++;
    all |= bit;
    const s = c & 3;
    if (s === 0) s0 |= bit;
    else if (s === 1) s1 |= bit;
    else if (s === 2) s2 |= bit;
    else s3 |= bit;
  }
  const flush = bitCount(s0) >= 5 ? s0 : bitCount(s1) >= 5 ? s1 : bitCount(s2) >= 5 ? s2 : bitCount(s3) >= 5 ? s3 : 0;
  if (flush) {
    const top = straightTop(flush);
    if (top >= 0) return (8 << CAT) | (top << 16);
  }
  let quad = -1;
  let trip = -1;
  let trip2 = -1;
  let pair = -1;
  let pair2 = -1;
  for (let r = 12; r >= 0; r--) {
    const c = counts[r]!;
    if (c === 4) quad = r;
    else if (c === 3) {
      if (trip < 0) trip = r;
      else if (trip2 < 0) trip2 = r;
    } else if (c === 2) {
      if (pair < 0) pair = r;
      else if (pair2 < 0) pair2 = r;
    }
  }
  if (quad >= 0) return (7 << CAT) | (quad << 16) | highest(all & ~(1 << quad), 1, 12);
  if (trip >= 0 && (trip2 >= 0 || pair >= 0)) return (6 << CAT) | (trip << 16) | (Math.max(trip2, pair) << 12);
  if (flush) return (5 << CAT) | highest(flush, 5, 16);
  const top = straightTop(all);
  if (top >= 0) return (4 << CAT) | (top << 16);
  if (trip >= 0) return (3 << CAT) | (trip << 16) | highest(all & ~(1 << trip), 2, 12);
  if (pair2 >= 0) return (2 << CAT) | (pair << 16) | (pair2 << 12) | highest(all & ~(1 << pair) & ~(1 << pair2), 1, 8);
  if (pair >= 0) return (1 << CAT) | (pair << 16) | highest(all & ~(1 << pair), 3, 12);
  return highest(all, 5, 16);
}

export const categoryOf = (value: number): Category => CATEGORIES[value >> CAT]!;

export interface HandRank {
  value: number;
  category: Category;
  /** The five cards that play, in the order they read: groups first (bigger, then higher), a wheel's ace last. */
  best: Card[];
}

/** The fives within `cards` (all 21 of seven), each as the cards left out. */
function fives(cards: readonly Card[]): Card[][] {
  const n = cards.length;
  if (n === 5) return [[...cards]];
  const out: Card[][] = [];
  for (let i = 0; i < n; i++) {
    if (n === 6) out.push(cards.filter((_, k) => k !== i));
    else for (let j = i + 1; j < n; j++) out.push(cards.filter((_, k) => k !== i && k !== j));
  }
  return out;
}

/** The value, its category and the five cards that make it, for showdowns and reviews (slower than evaluate). */
export function rankHand(cards: readonly Card[]): HandRank {
  const value = evaluate(cards);
  const five = fives(cards).find((f) => evaluate(f) === value)!;
  const category = categoryOf(value);
  const n = (c: Card) => five.filter((d) => rankOf(d) === rankOf(c)).length;
  const wheel = (category === 'straight' || category === 'straight flush') && ((value >> 16) & 15) === 3;
  const high = (c: Card) => (wheel && rankOf(c) === 12 ? -1 : rankOf(c));
  // A stable sort keeps cards of one rank in the order they came.
  const best = [...five].sort((a, b) => n(b) - n(a) || high(b) - high(a));
  return { value, category, best };
}
