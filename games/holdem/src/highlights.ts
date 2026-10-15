// The hand review's highlights, found automatically in a finished hand, named as a poker player would name them:
//
// - Bluff: a bet or raise of at least half the pot (or all-in) after the flop, made holding nothing (no pair of one's
//   own) and no strong draw, with a hand that would have lost; it either worked (everyone folded) or was caught (called
//   and shown down).
// - Semi-bluff: the same bet with no made hand but a strong draw on the flop or turn: at least 8 outs to a straight or
//   better with a hole card playing (a flush draw, an open-ended straight draw, or both), counted from the bettor's
//   view one card ahead. Worked or caught as a bluff; it is worth a little less, as it had a way to win.
// - Hero call: calling a big river bet, or an all-in after the flop, with one pair or less, and winning.
// - Bad beat: a clear favourite who lost on the river or the run-out: at least 80% to win when the money went in
//   (all-in before the river), or at least 75% on the turn holding two pair or better. Coin flips don't count.
// - Folded the winner: folding to a bet after the flop, in a pot of at least 8 big blinds, a hand that would have won.
// - Cooler: two strong hands (three of a kind or better each) colliding in a pot of at least 20 big blinds.
// - Biggest pot: a game's largest pot, the best moment when no story beats its size.
//
// Each has a drama score (the pot's share of all the chips in play, in percent, times the kind's weight, so a late
// all-in counts for what it is rather than for its few big blinds; a model's bluff that worked or hero call counts
// most, a human in it adds a bonus), and the best moment of a game is the highest. Pure: a hand's events (every
// hole card) and its run-out in, highlights out. "Would have" compares hands on the five-card board the deck held.
import { DECK, parseCard, rankOf, type Card } from '../shared/cards.ts';
import type { ActionKind, HandEvent, Street } from '../shared/engine.ts';
import { categoryOf, evaluate, type Category } from '../shared/evaluator.ts';
import type { Player } from '../shared/recording.ts';
import { deriveSeed, mulberry32 } from '../shared/rng.ts';
import type { ReviewHand } from './driver.ts';
import { aHand } from './view-model.ts';

export type HighlightKind = 'bluff' | 'semi_bluff' | 'hero_call' | 'bad_beat' | 'folded_winner' | 'cooler' | 'biggest_pot';

export interface Highlight {
  kind: HighlightKind;
  /** The hand, from 1. */
  hand: number;
  /** Who it is about: the bluffer, the caller, the player beaten, the player who folded, the cooler's loser, the pot's winner. */
  seat: number;
  /** The other player: who folded or called, who bet, who got lucky, who would have lost, who won the cooler. */
  against: number;
  /** Who the share image shows: the bluffer, the hero caller, the player who hit, the winner. */
  featured: number;
  street: Street;
  /** Chips in the pot at the end of the hand, and in big blinds. */
  pot: number;
  potBb: number;
  /** Every chip at the table when the hand began, and the pot's share of them (0 to 1). */
  chipsInPlay: number;
  share: number;
  /** The average stack of the players dealt in, in big blinds, when the hand began. */
  stackBb: number;
  /** Bluff and semi-bluff: everyone folded to it. */
  worked?: boolean;
  /** Semi-bluff: the draw ("a flush draw"), its outs, how the chips went in, and whether the draw came in. */
  draw?: string;
  outs?: number;
  move?: 'bet' | 'raise' | 'allin';
  hit?: boolean;
  /** Bad beat: the loser's chance to win when the money went in or on the turn (0 to 1). */
  equity?: number;
  /** The seat's and the other's best hands on the board as it ended (or would have). */
  hand1: Category;
  hand2: Category;
  /** Drama: the pot's share of the chips in play (percent) times the kind's weight and bonuses. */
  score: number;
}

export interface HandAction {
  index: number;
  street: Street;
  seat: number;
  kind: ActionKind;
  to: number;
  add: number;
  allIn: boolean;
  /** It raised the bet to call (a bet, a raise, or an all-in above the bet). */
  aggressive: boolean;
  /** Every chip in the middle just before it (this street's bets included). */
  potBefore: number;
  /** What it had to call. */
  facing: number;
}

/** A finished hand, read from its events. */
export interface HandFacts {
  hand: number;
  seats: number;
  button: number;
  bb: number;
  startStacks: number[];
  holes: (Card[] | null)[];
  /** The board as dealt. */
  board: Card[];
  /** The full five-card board the deck held. */
  runout: Card[];
  actions: HandAction[];
  /** Seat -> the street it folded on. */
  folded: Map<number, Street>;
  showdown: boolean;
  pot: number;
  /** Winners of each pot, in pot order. */
  awards: { amount: number; winners: number[]; eligible: number[] }[];
  net: number[];
}

/** Reads a finished hand's events. */
export function factsOf(h: ReviewHand): HandFacts {
  const start = h.events.find((e): e is Extract<HandEvent, { type: 'start' }> => e.type === 'start');
  if (!start) throw new Error('a hand starts with its start event');
  const n = start.stacks.length;
  const holes: (Card[] | null)[] = Array.from({ length: n }, () => null);
  const actions: HandAction[] = [];
  const folded = new Map<number, Street>();
  const awards: HandFacts['awards'] = [];
  const bets = Array<number>(n).fill(0);
  let street: Street = 'preflop';
  let board: Card[] = [];
  let currentBet = start.bb;
  let middle = 0;
  let showdown = false;
  let net: number[] = n ? Array<number>(n).fill(0) : [];
  for (const e of h.events) {
    if (e.type === 'hole') holes[e.seat] = e.cards.length ? [...e.cards] : null;
    else if (e.type === 'post') {
      middle += e.amount;
      if (e.blind !== 'ante') bets[e.seat]! += e.amount;
    } else if (e.type === 'street') {
      street = e.street;
      board = [...e.board];
      currentBet = 0;
      bets.fill(0);
    } else if (e.type === 'action') {
      const aggressive = e.to > currentBet && e.kind !== 'call' && e.kind !== 'fold' && e.kind !== 'check';
      const facing = Math.max(0, currentBet - bets[e.seat]!);
      actions.push({ index: actions.length, street, seat: e.seat, kind: e.kind, to: e.to, add: e.add, allIn: e.allIn, aggressive, potBefore: middle, facing });
      if (aggressive) currentBet = e.to;
      if (e.kind !== 'fold') bets[e.seat] = e.to;
      middle += e.add;
      if (e.kind === 'fold') folded.set(e.seat, street);
    } else if (e.type === 'return') middle -= e.amount;
    else if (e.type === 'showdown') showdown = true;
    else if (e.type === 'award') awards.push({ amount: e.amount, winners: [...e.winners], eligible: [...e.eligible] });
    else if (e.type === 'end') net = [...e.net];
  }
  return {
    hand: h.hand,
    seats: n,
    button: start.button,
    bb: start.bb,
    startStacks: [...start.stacks],
    holes,
    board,
    runout: h.runout.map(parseCard),
    actions,
    folded,
    showdown,
    pot: awards.reduce((a, x) => a + x.amount, 0),
    awards,
    net,
  };
}

const valueOn = (f: HandFacts, seat: number, board: readonly Card[]): number => {
  const hole = f.holes[seat];
  return hole && board.length >= 3 ? evaluate([...hole, ...board]) : -1;
};

const categoryIndex = (v: number) => v >> 20;

/** Seats dealt into the hand. */
const dealt = (f: HandFacts): number[] => f.holes.flatMap((h, seat) => (h ? [seat] : []));

/** Seats still in the hand just before action `index` (not folded earlier). */
function liveBefore(f: HandFacts, index: number): number[] {
  const gone = new Set(f.actions.filter((a) => a.index < index && a.kind === 'fold').map((a) => a.seat));
  return dealt(f).filter((s) => !gone.has(s));
}

const wonSomething = (f: HandFacts, seat: number): boolean => f.awards.some((a) => a.winners.includes(seat));

const POSTFLOP = (s: Street) => s !== 'preflop';

/** The board when a street's betting happened. */
const boardAt = (f: HandFacts, street: Street): Card[] => f.runout.slice(0, street === 'preflop' ? 0 : street === 'flop' ? 3 : street === 'turn' ? 4 : 5);

/** Nothing yet: no pair that uses a hole card (a high card, or a pair on the board alone). */
function nothing(f: HandFacts, seat: number, board: readonly Card[]): boolean {
  const hole = f.holes[seat];
  if (!hole || board.length < 3) return false;
  const category = categoryIndex(valueOn(f, seat, board));
  if (category === 0) return true;
  if (category > 1) return false;
  const pocket = rankOf(hole[0]!) === rankOf(hole[1]!);
  return !pocket && !hole.some((c) => board.some((b) => rankOf(b) === rankOf(c)));
}

/** A bet worth a story: at least half the pot it went into, or all-in. */
const meaningful = (a: HandAction): boolean => a.allIn || a.add - a.facing >= 0.5 * (a.potBefore + a.facing);

/**
 * `a`'s chance to beat `b` (ties count half) over every way the board could be completed from `board`: exact for one
 * or two cards to come, sampled (3000 seeded run-outs) for more. Pure and deterministic.
 */
export function headsUpEquity(a: readonly Card[], b: readonly Card[], board: readonly Card[]): number {
  const known = new Set([...a, ...board, ...b]);
  const rest = DECK.filter((c) => !known.has(c));
  const missing = 5 - board.length;
  let won = 0;
  let n = 0;
  const score = (extra: readonly Card[]) => {
    const full = [...board, ...extra];
    const va = evaluate([...a, ...full]);
    const vb = evaluate([...b, ...full]);
    won += va > vb ? 1 : va === vb ? 0.5 : 0;
    n++;
  };
  if (missing === 0) score([]);
  else if (missing === 1) for (const c of rest) score([c]);
  else if (missing === 2) for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) score([rest[i]!, rest[j]!]);
  else {
    let state = deriveSeed(0x5eed, ...a, ...b, ...board);
    const pool = [...rest];
    for (let s = 0; s < 3000; s++) {
      for (let i = 0; i < missing; i++) {
        let r: number;
        [r, state] = mulberry32(state);
        const j = i + Math.floor(r * (pool.length - i));
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
      }
      score(pool.slice(0, missing));
    }
  }
  return n ? won / n : 0;
}

type Draft = Omit<Highlight, 'score' | 'potBb' | 'hand' | 'pot' | 'chipsInPlay' | 'share' | 'stackBb'>;

/** A draw worth a semi-bluff: at least this many outs. */
export const STRONG_DRAW_OUTS = 8;

/**
 * The cards still unseen by a player holding `hole` on `board` (flop or turn) that would give it a straight or better
 * with a hole card playing, split into flush outs (flushes and straight flushes) and straight outs, and what to call
 * the draw. One card ahead; nothing on the river.
 */
export function drawOf(hole: readonly Card[], board: readonly Card[]): { outs: number; flush: number; straight: number; name: string } {
  let flush = 0;
  let straight = 0;
  if (board.length === 3 || board.length === 4) {
    const seen = new Set([...hole, ...board]);
    for (const c of DECK) {
      if (seen.has(c)) continue;
      const v = evaluate([...hole, ...board, c]);
      const category = categoryIndex(v);
      if (category < 4) continue;
      // The board alone would play as well: the hole cards add nothing.
      if (board.length === 4 && evaluate([...board, c]) >= v) continue;
      if (category === 4) straight++;
      else if (category === 5 || category === 8) flush++;
    }
  }
  const name = flush >= 8 && straight >= 3 ? 'a flush and straight draw' : flush >= 8 ? 'a flush draw' : straight >= 8 ? 'a straight draw' : 'a draw';
  return { outs: flush + straight, flush, straight, name };
}

function bluffs(f: HandFacts): Draft[] {
  const out: Draft[] = [];
  const last = new Map<number, HandAction>();
  for (const a of f.actions) if (a.aggressive && POSTFLOP(a.street)) last.set(a.seat, a);
  for (const [seat, a] of last) {
    const board = boardAt(f, a.street);
    if (!meaningful(a) || !nothing(f, seat, board)) continue;
    const mine = valueOn(f, seat, f.runout);
    const rivals = liveBefore(f, a.index).filter((s) => s !== seat);
    if (!rivals.length || mine < 0) continue;
    const best = rivals.reduce((b, s) => (valueOn(f, s, f.runout) > valueOn(f, b, f.runout) ? s : b));
    if (valueOn(f, best, f.runout) <= mine) continue;
    const worked = !f.showdown && wonSomething(f, seat);
    // Caught: called, shown down and lost. A bluff that was raised off its hand is neither.
    const caught = f.showdown && !wonSomething(f, seat) && f.holes[seat] !== null && !f.folded.has(seat);
    if (!worked && !caught) continue;
    const against = worked ? best : (f.awards[0]?.winners.find((w) => w !== seat) ?? best);
    const base = { seat, against, featured: seat, street: a.street, worked, hand1: categoryOf(mine), hand2: categoryOf(valueOn(f, against, f.runout)) };
    const draw = drawOf(f.holes[seat]!, board);
    if (draw.outs >= STRONG_DRAW_OUTS) {
      const move = a.allIn ? 'allin' : a.kind === 'raise' ? 'raise' : 'bet';
      out.push({ kind: 'semi_bluff', ...base, draw: draw.name, outs: draw.outs, move, hit: categoryIndex(mine) >= 4 });
    } else out.push({ kind: 'bluff', ...base });
  }
  return out;
}

function heroCalls(f: HandFacts): Draft[] {
  if (!f.showdown) return [];
  const out = new Map<number, Draft>();
  for (const a of f.actions) {
    if (a.kind !== 'call' || !POSTFLOP(a.street)) continue;
    const bet = [...f.actions].reverse().find((b) => b.index < a.index && b.aggressive);
    if (!bet || bet.seat === a.seat || !meaningful(bet)) continue;
    if (a.street !== 'river' && !bet.allIn) continue;
    const mine = valueOn(f, a.seat, f.runout);
    const theirs = valueOn(f, bet.seat, f.runout);
    if (mine <= theirs || categoryIndex(mine) > 1 || !wonSomething(f, a.seat)) continue;
    out.set(a.seat, { kind: 'hero_call', seat: a.seat, against: bet.seat, featured: a.seat, street: a.street, hand1: categoryOf(mine), hand2: categoryOf(theirs) });
  }
  return [...out.values()];
}

function badBeats(f: HandFacts): Draft[] {
  if (!f.showdown || f.runout.length < 5 || f.board.length < 5) return [];
  const main = f.awards[0];
  if (!main || main.winners.length !== 1) return [];
  const winner = main.winners[0]!;
  const lastAction = f.actions.at(-1);
  // Where the money went in: the board when the last chips went in, if that was before the river (a run-out).
  const allInBoard = lastAction && lastAction.street !== 'river' ? boardAt(f, lastAction.street) : null;
  const out: Draft[] = [];
  for (const seat of main.eligible) {
    const hole = f.holes[seat];
    const theirs = f.holes[winner];
    if (seat === winner || !hole || !theirs || f.folded.has(seat)) continue;
    const turn = f.runout.slice(0, 4);
    const onTurn = headsUpEquity(hole, theirs, turn);
    const turnStrong = categoryIndex(valueOn(f, seat, turn)) >= 2;
    const atAllIn = allInBoard ? headsUpEquity(hole, theirs, allInBoard) : 0;
    const equity = allInBoard && atAllIn >= 0.8 ? atAllIn : turnStrong && onTurn >= 0.75 ? onTurn : 0;
    if (!equity) continue;
    const ledOnTurn = valueOn(f, seat, turn) > valueOn(f, winner, turn);
    out.push({ kind: 'bad_beat', seat, against: winner, featured: winner, street: ledOnTurn ? 'river' : (lastAction?.street ?? 'preflop'), equity, hand1: categoryOf(valueOn(f, seat, f.runout)), hand2: categoryOf(valueOn(f, winner, f.runout)) });
  }
  return out;
}

function foldedWinners(f: HandFacts): Draft[] {
  const out: Draft[] = [];
  const stayed = dealt(f).filter((s) => !f.folded.has(s));
  if (!stayed.length) return out;
  const best = stayed.reduce((b, s) => (valueOn(f, s, f.runout) > valueOn(f, b, f.runout) ? s : b));
  for (const a of f.actions) {
    if (a.kind !== 'fold' || !POSTFLOP(a.street) || a.facing <= 0 || a.potBefore < 8 * f.bb) continue;
    const mine = valueOn(f, a.seat, f.runout);
    if (stayed.every((s) => mine > valueOn(f, s, f.runout))) {
      const bettor = [...f.actions].reverse().find((b) => b.index < a.index && b.aggressive)?.seat ?? best;
      out.push({ kind: 'folded_winner', seat: a.seat, against: bettor, featured: a.seat, street: a.street, hand1: categoryOf(mine), hand2: categoryOf(valueOn(f, bettor, f.runout)) });
    }
  }
  return out;
}

function coolers(f: HandFacts, beaten: Set<number>): Draft[] {
  if (!f.showdown || f.pot < 20 * f.bb || f.board.length < 5) return [];
  const main = f.awards[0];
  if (!main || main.winners.length !== 1) return [];
  const winner = main.winners[0]!;
  const out: Draft[] = [];
  for (const seat of main.eligible) {
    if (seat === winner || f.folded.has(seat) || beaten.has(seat)) continue;
    const mine = valueOn(f, seat, f.board);
    const theirs = valueOn(f, winner, f.board);
    if (categoryIndex(mine) >= 3 && categoryIndex(theirs) >= 3) out.push({ kind: 'cooler', seat, against: winner, featured: winner, street: 'river', hand1: categoryOf(mine), hand2: categoryOf(theirs) });
  }
  return out.slice(0, 1);
}

/** How much each kind of story is worth, before the pot's size. */
const WEIGHT: Record<HighlightKind, number> = { bluff: 2.2, semi_bluff: 2, hero_call: 3, bad_beat: 2.4, folded_winner: 1.8, cooler: 2, biggest_pot: 1 };

/**
 * The drama of a highlight: the pot's share of the chips in play (0 to 1, scored in percent) × the kind's weight, a
 * model's bold play and a human in it counting more. A pure bluff counts a little more than a semi-bluff, which had a
 * draw to fall back on.
 */
export function scoreOf(d: Pick<Highlight, 'kind' | 'worked' | 'seat' | 'against'>, share: number, players?: readonly Pick<Player, 'kind'>[]): number {
  let w = WEIGHT[d.kind];
  if (d.kind === 'bluff') w = d.worked ? 3 : 1.6;
  if (d.kind === 'semi_bluff') w = d.worked ? 2.6 : 1.4;
  const kind = (s: number) => players?.[s]?.kind;
  if ((d.kind === 'hero_call' || ((d.kind === 'bluff' || d.kind === 'semi_bluff') && d.worked)) && kind(d.seat) === 'model') w *= 1.5;
  if (kind(d.seat) === 'human' || kind(d.against) === 'human') w *= 1.3;
  return Math.round(share * 100 * w * 100) / 100;
}

/** The pot's size against the table: its chips and big blinds, its share of every chip in play, and how deep the stacks were. */
function sizeOf(f: HandFacts): Pick<Highlight, 'pot' | 'potBb' | 'chipsInPlay' | 'share' | 'stackBb'> {
  const chipsInPlay = f.startStacks.reduce((a, b) => a + b, 0);
  const players = dealt(f).length || 1;
  return { pot: f.pot, potBb: f.pot / f.bb, chipsInPlay, share: chipsInPlay ? f.pot / chipsInPlay : 0, stackBb: chipsInPlay / players / f.bb };
}

/** Every highlight in a finished hand, the best story first. `players` (seat order) weighs who was in it. */
export function highlightsOf(h: ReviewHand, players?: readonly Pick<Player, 'kind'>[]): Highlight[] {
  const f = factsOf(h);
  const size = sizeOf(f);
  const beats = badBeats(f);
  const drafts = [...bluffs(f), ...heroCalls(f), ...beats, ...foldedWinners(f), ...coolers(f, new Set(beats.map((b) => b.seat)))];
  return drafts.map((d) => ({ ...d, hand: f.hand, ...size, score: scoreOf(d, size.share, players) })).sort((a, b) => b.score - a.score);
}

/** The biggest pot of a game as a highlight (the fallback best moment), or null for a game of no hands. */
export function biggestPotHighlight(hands: readonly ReviewHand[], players?: readonly Pick<Player, 'kind'>[]): Highlight | null {
  let best: Highlight | null = null;
  for (const h of hands) {
    const f = factsOf(h);
    const winner = f.awards[0]?.winners[0];
    const size = sizeOf(f);
    // The biggest against the table: a late pot of few big blinds can hold most of the chips.
    if (winner === undefined || (best && size.share <= best.share)) continue;
    const loser = dealt(f).filter((s) => s !== winner).sort((a, b) => f.net[a]! - f.net[b]!)[0] ?? winner;
    const shown = f.showdown ? valueOn(f, winner, f.board) : -1;
    const d = { kind: 'biggest_pot' as const, seat: winner, against: loser };
    best = { ...d, featured: winner, hand: f.hand, street: 'river', ...size, hand1: shown >= 0 ? categoryOf(shown) : 'high card', hand2: 'high card', worked: !f.showdown, score: scoreOf(d, size.share, players) };
  }
  return best;
}

/**
 * The best moment of a game: the highest score among its highlights and its biggest pot (which scores its size alone,
 * so a bluff in a small pot does not beat a huge one, and a game with no story still has a moment).
 */
export function bestHighlight(hands: readonly ReviewHand[], players?: readonly Pick<Player, 'kind'>[]): Highlight | null {
  let best: Highlight | null = biggestPotHighlight(hands, players);
  for (const h of hands) for (const x of highlightsOf(h, players)) if (!best || x.score > best.score) best = x;
  return best;
}

/** A highlight's name: "Bluff that worked", "Bluff, caught", "Semi-bluff that worked", "Hero call", ... */
export function titleOf(x: Pick<Highlight, 'kind' | 'worked'>): string {
  if (x.kind === 'bluff') return x.worked ? 'Bluff that worked' : 'Bluff, caught';
  if (x.kind === 'semi_bluff') return x.worked ? 'Semi-bluff that worked' : 'Semi-bluff, caught';
  return { hero_call: 'Hero call', bad_beat: 'Bad beat', folded_winner: 'Folded the winner', cooler: 'Cooler', biggest_pot: 'Biggest pot' }[x.kind];
}

/** A hand's name without its article, for "Opus 5.5's three of a kind". */
const bare = (c: Category) => aHand(c).replace(/^(a|just a) /, '');

/** Stacks this deep (on average, in big blinds) read well in big blinds; shallower, a pot is told against the table. */
const DEEP_BB = 25;

/**
 * A pot's size as a caption says it: "29 big blinds" while the stacks are deep, else "5,672 chips, 95% of the chips in
 * play" (late in a Sit & Go a pot of 19 big blinds can be nearly every chip at the table).
 */
export function potText(x: Pick<Highlight, 'pot' | 'potBb' | 'share' | 'stackBb'>): string {
  if (x.stackBb >= DEEP_BB) return `${Math.round(x.potBb)} big blinds`;
  return `${x.pot.toLocaleString('en-US')} chips, ${Math.round(x.share * 100)}% of the chips in play`;
}

/**
 * One sentence naming both players, the same on the end screen, in the review and on the share image. `name` gives a
 * seat's name; the human's is "You", which reads "you" and "your" inside a sentence.
 */
export function describeHighlight(x: Highlight, name: (seat: number) => string): string {
  const me = name(x.seat);
  const other = name(x.against);
  const them = other === 'You' ? 'you' : other;
  const theirs = other === 'You' ? 'your' : `${other}'s`;
  const mine = me === 'You' ? 'your' : `${me}'s`;
  const bb = potText(x);
  // Inside a sentence, "5,672 chips, 95% of the chips in play" needs its closing comma.
  const bbIn = x.stackBb >= DEEP_BB ? bb : `${bb},`;
  switch (x.kind) {
    case 'bluff':
      return x.worked ? `${me} bluffed with nothing on the ${x.street}, and ${them} folded ${aHand(x.hand2)}. Pot: ${bb}.` : `${me} bluffed with nothing on the ${x.street}, and ${them} called with ${aHand(x.hand2)}. Pot: ${bb}.`;
    case 'semi_bluff': {
      const draw = x.draw ?? 'a draw';
      const did = x.move === 'allin' ? `shoved ${draw}` : x.move === 'raise' ? `raised with ${draw}` : `bet ${draw}`;
      if (x.worked) return `${me} ${did} on the ${x.street}, and ${them} folded ${aHand(x.hand2)}. Pot: ${bb}.`;
      return x.hit
        ? `${me} ${did} on the ${x.street} and made ${aHand(x.hand1)}, but ${them} had ${aHand(x.hand2)}. Pot: ${bb}.`
        : `${me} ${did} on the ${x.street} and missed, and ${them} called with ${aHand(x.hand2)}. Pot: ${bb}.`;
    }
    case 'hero_call':
      return `${me} called ${theirs} ${x.street === 'river' ? 'river bet' : 'all-in'} with ${aHand(x.hand1)}, and won ${bb}.`;
    case 'bad_beat':
      return `${other} ${x.street === 'river' ? 'rivered' : 'caught'} ${aHand(x.hand2)} against ${mine} ${bare(x.hand1)} (${Math.round((x.equity ?? 0) * 100)}% to win). Pot: ${bb}.`;
    case 'folded_winner':
      return `${me} folded on the ${x.street} to ${theirs} bet, and would have won ${bbIn} with ${aHand(x.hand1)}.`;
    case 'cooler':
      return `${other === 'You' ? 'Your' : `${other}'s`} ${bare(x.hand2)} beat ${mine} ${bare(x.hand1)} for ${bb}.`;
    case 'biggest_pot':
      return x.worked ? `${me} took the biggest pot, ${bb}, when everyone else folded.` : `${me} won the biggest pot, ${bb}, with ${aHand(x.hand1)}.`;
  }
}

/** A game's best moment as the end screen, the review and the share image all say it. */
export interface Moment {
  highlight: Highlight;
  title: string;
  /** "Hand 23. Sol rivered a straight against Opus 5.5's three of a kind (81% to win). Pot: 100 big blinds." */
  text: string;
}

export function momentOf(hands: readonly ReviewHand[], players: readonly Pick<Player, 'kind'>[] | undefined, name: (seat: number) => string): Moment | null {
  const best = bestHighlight(hands, players);
  return best ? { highlight: best, title: titleOf(best), text: `Hand ${best.hand}. ${describeHighlight(best, name)}` } : null;
}
