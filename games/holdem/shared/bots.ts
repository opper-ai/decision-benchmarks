// AI Hold'em's scripted players (the plan's "Benchmark"): deterministic baselines that pick from the legal options.
// The benchmark seats a model against rock, station and maniac; random is a reference. A bot reads only what
// observe() gives its seat, so it never sees another player's cards or the deck, and its "coins" come from a seed made
// of that view: the same view always gets the same answer, which is how verify recomputes every bot move.
// Isomorphic.
import { DECK, parseCard, rankOf, suitOf, type Card } from './cards.ts';
import { evaluate } from './evaluator.ts';
import type { Observation, Option, OptionKey } from './engine.ts';
import { deriveSeed, mulberry32, nextInt } from './rng.ts';

export type BotName = 'rock' | 'station' | 'maniac' | 'random';
export const BOT_NAMES: readonly BotName[] = ['rock', 'station', 'maniac', 'random'];
export const isBotName = (v: unknown): v is BotName => BOT_NAMES.includes(v as BotName);

/** Run-outs sampled per decision after the flop. */
export const BOT_SAMPLES = 200;

/** The fallback for a player that did not answer in time: check if it is free, else fold. Deliberately weak. */
export function fallbackKey(options: readonly Option[]): OptionKey {
  return options.some((o) => o.key === 'check') ? 'check' : 'fold';
}

/**
 * Bill Chen's preflop score, from -1 (7-2 offsuit) to 20 (aces): the high card (A 10, K 8, Q 7, J 6, else half its
 * rank), doubled for a pair (at least 5), +2 suited, -1 to -5 for the gap, +1 for connected or one-gap cards below a
 * queen; rounded up.
 */
export function chenScore(a: Card, b: Card): number {
  const hi = Math.max(rankOf(a), rankOf(b));
  const lo = Math.min(rankOf(a), rankOf(b));
  const value = (r: number) => (r === 12 ? 10 : r === 11 ? 8 : r === 10 ? 7 : r === 9 ? 6 : (r + 2) / 2);
  if (hi === lo) return Math.ceil(Math.max(5, 2 * value(hi)));
  let score = value(hi);
  if (suitOf(a) === suitOf(b)) score += 2;
  const gap = hi - lo - 1;
  score -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && hi < 10) score += 1;
  return Math.ceil(score);
}

/**
 * The share of the pot `hole` wins against `opponents` random hands, over `samples` random run-outs of the board
 * (a tie counts as its share). Seeded, so it is the same every time for the same seed.
 */
export function equity(hole: readonly Card[], board: readonly Card[], opponents: number, samples: number, seed: number): number {
  const known = new Set([...hole, ...board]);
  const rest = DECK.filter((c) => !known.has(c));
  const missing = 5 - board.length;
  const need = missing + 2 * opponents;
  const mine: Card[] = [...hole, ...board];
  const theirs: Card[] = [0, 0, ...board];
  let state = seed | 0;
  let won = 0;
  for (let s = 0; s < samples; s++) {
    // A partial Fisher-Yates: the first `need` cards of `rest` become a random draw.
    for (let i = 0; i < need; i++) {
      let j: number;
      [j, state] = nextInt(state, rest.length - i);
      const t = rest[i]!;
      rest[i] = rest[i + j]!;
      rest[i + j] = t;
    }
    for (let k = 0; k < missing; k++) mine[2 + board.length + k] = theirs[2 + board.length + k] = rest[k]!;
    const me = evaluate(mine);
    let ties = 0;
    let lost = false;
    for (let o = 0; o < opponents && !lost; o++) {
      theirs[0] = rest[missing + 2 * o]!;
      theirs[1] = rest[missing + 2 * o + 1]!;
      const v = evaluate(theirs);
      if (v > me) lost = true;
      else if (v === me) ties++;
    }
    if (!lost) won += 1 / (ties + 1);
  }
  return won / samples;
}

/** What a bot works from: the view, and a few things worked out from it. */
interface Spot {
  o: Observation;
  hole: Card[];
  board: Card[];
  has: (key: OptionKey) => boolean;
  /** Before the flop: someone has raised the big blind. */
  raised: boolean;
  opponents: number;
  /** A number in [0, 1), from the view's seed: a fresh one on each call. */
  coin: () => number;
  /** Equity against the opponents still in the hand (sampled after the flop only, when asked). */
  equity: () => number;
}

/** A seed from everything the player has seen this hand: its cards, the board, the actions, the hand number. */
function viewSeed(o: Observation, hole: readonly Card[], board: readonly Card[]): number {
  const history = o.history.flatMap((h) => [h.seat, h.to]);
  return deriveSeed(0x407de1, o.seat, o.level?.hand ?? 0, ...hole, ...board, o.history.length, ...history);
}

function spotOf(o: Observation): Spot {
  const hole = o.holeCards.map(parseCard);
  const board = o.board.map(parseCard);
  const keys = new Set(o.options.map((x) => x.key));
  let state = viewSeed(o, hole, board);
  const coin = () => {
    let r: number;
    [r, state] = mulberry32(state);
    return r;
  };
  const opponents = Math.max(1, o.players.filter((p) => p.seat !== o.seat && (p.status === 'active' || p.status === 'allin')).length);
  let eq: number | null = null;
  return {
    o,
    hole,
    board,
    has: (k) => keys.has(k),
    raised: o.street === 'preflop' && o.currentBet > o.blinds.bb,
    opponents,
    coin,
    equity: () => (eq ??= equity(hole, board, opponents, BOT_SAMPLES, deriveSeed(viewSeed(o, hole, board), 1))),
  };
}

/** The first of `keys` on the menu; else check, call or fold, whichever is there. */
function prefer(s: Spot, ...keys: OptionKey[]): OptionKey {
  for (const k of [...keys, 'check', 'call', 'fold'] as OptionKey[]) if (s.has(k)) return k;
  return s.o.options[0]!.key;
}

const passive = (s: Spot): OptionKey => prefer(s, 'check', 'fold');

/** A pair or better that uses a hole card. */
function pairedWithHole(s: Spot): boolean {
  if (rankOf(s.hole[0]!) === rankOf(s.hole[1]!)) return true;
  return s.hole.some((h) => s.board.some((b) => rankOf(b) === rankOf(h)));
}

/** Four to a flush or to an open-ended straight, with a hole card in it, while cards are still to come. */
function drawing(s: Spot): boolean {
  if (s.board.length >= 5) return false;
  const cards = [...s.hole, ...s.board];
  for (let suit = 0; suit < 4; suit++) if (cards.filter((c) => suitOf(c) === suit).length >= 4 && s.hole.some((h) => suitOf(h) === suit)) return true;
  const ranks = new Set(cards.map(rankOf));
  const holeRanks = s.hole.map(rankOf);
  for (let lo = 0; lo + 3 <= 11; lo++) {
    const run = [lo, lo + 1, lo + 2, lo + 3];
    if (run.every((r) => ranks.has(r)) && run.some((r) => holeRanks.includes(r))) return true;
  }
  return false;
}

/** The made hand's category index (0 high card ... 8 straight flush), after the flop. */
const madeCategory = (s: Spot): number => evaluate([...s.hole, ...s.board]) >> 20;

const PICK: Record<BotName, (s: Spot) => OptionKey> = {
  /** Tight: plays strong starting hands and raises them; folds to aggression without a strong made hand. */
  rock(s) {
    const { o } = s;
    if (o.street === 'preflop') {
      const c = chenScore(s.hole[0]!, s.hole[1]!);
      if (!s.raised) return c >= 9 ? prefer(s, 'small', 'half', 'pot', 'allin') : passive(s);
      if (c >= 12) return prefer(s, 'pot', 'three_quarters', 'allin', 'call');
      return c >= 10 ? prefer(s, 'call') : passive(s);
    }
    const e = s.equity();
    if (o.toCall === 0) return e >= 0.75 ? prefer(s, 'three_quarters', 'half', 'pot', 'allin') : e >= 0.6 ? prefer(s, 'half', 'small') : 'check';
    if (e >= 0.85) return prefer(s, 'pot', 'three_quarters', 'allin', 'call');
    return e >= 0.75 || (madeCategory(s) >= 2 && e >= 0.6) ? prefer(s, 'call') : passive(s);
  },
  /** A calling station: calls a lot, rarely raises, rarely folds a pair or a draw after the flop. */
  station(s) {
    const { o } = s;
    if (o.street === 'preflop') {
      const c = chenScore(s.hole[0]!, s.hole[1]!);
      if (c >= 14) return prefer(s, 'small', 'half');
      if (o.toCall === 0) return 'check';
      return c >= 3 || o.toCall <= 3 * o.blinds.bb ? prefer(s, 'call') : passive(s);
    }
    const e = s.equity();
    if (o.toCall === 0) return e >= 0.85 ? prefer(s, 'half', 'small') : 'check';
    if (e >= 0.95) return prefer(s, 'small', 'half', 'call');
    return pairedWithHole(s) || drawing(s) || e >= 0.4 ? prefer(s, 'call') : passive(s);
  },
  /** A maniac: raises often, bluffs, and goes all-in now and then. */
  maniac(s) {
    const { o } = s;
    const r = s.coin();
    if (o.street === 'preflop') {
      const c = chenScore(s.hole[0]!, s.hole[1]!);
      if (c >= 12 || r < 0.06) return prefer(s, 'allin', 'pot');
      if (c >= 5 || r < 0.5) return s.raised ? prefer(s, 'pot', 'three_quarters', 'allin') : prefer(s, r < 0.25 ? 'pot' : 'half', 'small', 'allin');
      return o.toCall === 0 ? 'check' : r < 0.8 ? prefer(s, 'call') : passive(s);
    }
    const e = s.equity();
    if (e >= 0.8 && r < 0.3) return prefer(s, 'allin', 'pot');
    if (o.toCall === 0) return e >= 0.5 ? prefer(s, r < 0.5 ? 'pot' : 'three_quarters', 'half', 'allin') : r < 0.5 ? prefer(s, 'half', 'small') : 'check';
    if (e >= 0.65 || r < 0.1) return prefer(s, 'pot', 'three_quarters', 'allin', 'call');
    return e >= 0.3 || r < 0.35 ? prefer(s, 'call') : passive(s);
  },
  /** Uniform over the legal options. */
  random(s) {
    return s.o.options[Math.floor(s.coin() * s.o.options.length)]!.key;
  },
};

/** A bot's choice for the seat to act, from that seat's observation. */
export function botDecide(name: BotName, o: Observation): OptionKey {
  if (!o.options.length) throw new Error(`seat ${o.seat} is not to act`);
  return PICK[name](spotOf(o));
}
