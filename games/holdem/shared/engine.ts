// AI Hold'em's rules: a pure, deterministic No-limit Texas Hold'em engine. A hand is its deck seed plus one action
// per decision, so the service, the bench, the replay viewer and the tests all play the same hand from the same
// actions. A Sit & Go (sitngo.ts) is a run of these hands with rising blinds. Isomorphic and Node-safe (erasable
// TypeScript only, no I/O, no clock, no Math.random): states are plain values, and no function changes the state it
// is given.
//
// The deal: the deck is shuffle(DECK, deckSeed) (rng.ts). Hole cards go out one at a time, two rounds, to the live
// seats in seat order starting left of the button (dealOrder); the board is the next five cards, flop, turn, river.
// There are no burn cards: with a shuffled deck they change nothing. So a seat's cards depend only on the deck seed,
// the button and which seats are live, never on who sits there: the duplicate benchmark deals the same cards to the
// same seat while it rotates the players.
import { DECK, formatCard, isCard, type Card } from './cards.ts';
import { evaluate, rankHand, type Category } from './evaluator.ts';
import { shuffle } from './rng.ts';

export type Street = 'preflop' | 'flop' | 'turn' | 'river';
/** Where a hand is: a betting street, or done (pots awarded). */
export type Phase = Street | 'done';
/** empty: no chips, not in the hand. active: can still act. allin: in the hand, no chips behind. */
export type SeatStatus = 'empty' | 'active' | 'allin' | 'folded';

/** The menu every player chooses from (the keys models answer with). */
export type OptionKey = 'fold' | 'check' | 'call' | 'small' | 'half' | 'three_quarters' | 'pot' | 'allin';
export const OPTION_KEYS: readonly OptionKey[] = ['fold', 'check', 'call', 'small', 'half', 'three_quarters', 'pot', 'allin'];
export const isOptionKey = (v: unknown): v is OptionKey => OPTION_KEYS.includes(v as OptionKey);

export type ActionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';

/** One legal option, with its amounts filled in. */
export interface Option {
  key: OptionKey;
  kind: ActionKind;
  /** The player's bet on this street after acting (for a fold, what it already had in). */
  to: number;
  /** Chips the player puts in now. */
  add: number;
  /** For people: "Raise to 450 (half pot)". */
  label: string;
}

/** An option from the menu, or a raise (or bet) to a street total of one's own (a human's slider). */
export type Action = { key: OptionKey } | { kind: 'raise'; to: number };

export interface SeatState {
  /** Chips behind. */
  stack: number;
  /** Chips at the start of the hand. */
  start: number;
  /** Bet on this street (blinds included, antes not). */
  bet: number;
  /** Everything put in this hand, antes and blinds included (less any uncalled bet returned). */
  committed: number;
  status: SeatStatus;
  hole: Card[];
  /** Has acted on this street (posting a blind is not acting). */
  acted: boolean;
  /** The bet to call when it last acted: a raise reopens the betting to it only if it adds a full raise to this. */
  actedAt: number;
}

export interface ActionRecord {
  street: Street;
  seat: number;
  /** The menu option played, or null for a raise to an amount of one's own. */
  key: OptionKey | null;
  kind: ActionKind;
  to: number;
  add: number;
  allIn: boolean;
}

/** A shown hand at a showdown. */
export interface ShownHand {
  seat: number;
  cards: Card[];
  value: number;
  category: Category;
  best: Card[];
}

/** What happened, in order, for the page and for replays. Cards are numbers (cards.ts). */
export type HandEvent =
  | { type: 'start'; button: number; sb: number; bb: number; ante: number; stacks: number[] }
  | { type: 'post'; seat: number; blind: 'ante' | 'sb' | 'bb'; amount: number; allIn: boolean }
  | { type: 'hole'; seat: number; cards: Card[] }
  | ({ type: 'action' } & Omit<ActionRecord, 'street'>)
  | { type: 'street'; street: Exclude<Street, 'preflop'>; cards: Card[]; board: Card[] }
  | { type: 'return'; seat: number; amount: number }
  | { type: 'showdown'; hands: ShownHand[] }
  | { type: 'award'; pot: number; amount: number; eligible: number[]; winners: number[]; shares: number[] }
  | { type: 'end'; stacks: number[]; net: number[] };

/** Where a hand sits in a Sit & Go, for the observation (null in a cash hand). */
export interface LevelInfo {
  /** Hand number, from 1. */
  hand: number;
  /** Blind level, from 1. */
  level: number;
  sb: number;
  bb: number;
  ante: number;
  /** Hands left at this level, this one included: the blinds go up after this many more. */
  handsUntilNextLevel: number;
  next: { sb: number; bb: number; ante: number };
}

export interface HandState {
  sb: number;
  bb: number;
  ante: number;
  button: number;
  sbSeat: number;
  bbSeat: number;
  deckSeed: number;
  /** The whole deck in deal order (see the top of this file). */
  deck: Card[];
  seats: SeatState[];
  board: Card[];
  street: Phase;
  /** The bet to call on this street: before the flop, the big blind even when its poster is short. */
  currentBet: number;
  /** The last full raise on this street (the big blind when there was none): a raise must add at least this. */
  minRaise: number;
  /** Bets and raises on this street, short all-ins included. */
  raises: number;
  /** The last seat to bet or raise on this street. */
  aggressor: number | null;
  toAct: number | null;
  actions: ActionRecord[];
  events: HandEvent[];
  level: LevelInfo | null;
}

export interface NewHand {
  /** Chips per seat; 0 is an empty or busted seat. 2 to 10 seats, at least two of them live. */
  stacks: readonly number[];
  /** A live seat. */
  button: number;
  sb: number;
  bb: number;
  ante?: number;
  deckSeed: number;
  /** Tests only: the first cards of the deck in deal order (the rest follow in DECK order). */
  deck?: readonly Card[];
  level?: LevelInfo | null;
}

const STREETS: readonly Street[] = ['preflop', 'flop', 'turn', 'river'];
const isWhole = (v: unknown, min = 0): v is number => Number.isInteger(v) && (v as number) >= min;

/** The next seat after `from` (going left) that passes `ok`, or -1. */
function nextSeat(n: number, from: number, ok: (i: number) => boolean): number {
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (ok(i)) return i;
  }
  return -1;
}

/** The live seats (chips > 0) in deal order: starting left of the button, the button last. */
export function dealOrder(stacks: readonly number[], button: number): number[] {
  const n = stacks.length;
  return Array.from({ length: n }, (_, k) => (button + 1 + k) % n).filter((i) => stacks[i]! > 0);
}

/** A copy that actions can change: seats copied, lists copied (their items are never changed). */
const copy = (s: HandState): HandState => ({ ...s, seats: s.seats.map((p) => ({ ...p })), board: [...s.board], actions: [...s.actions], events: [...s.events] });

/** Deals a hand: antes, blinds, hole cards, and then the first player to act (or the run-out, if nobody can). */
export function newHand(o: NewHand): HandState {
  const ante = o.ante ?? 0;
  const n = o.stacks.length;
  if (n < 2 || n > 10 || !o.stacks.every((x) => isWhole(x))) throw new Error('stacks must be 2 to 10 whole numbers');
  if (!isWhole(o.sb, 1) || !isWhole(o.bb, 1) || o.sb > o.bb || !isWhole(ante)) throw new Error('blinds must be whole numbers, the small blind at most the big');
  const order = dealOrder(o.stacks, o.button);
  if (order.length < 2) throw new Error('a hand needs at least two players with chips');
  if (!isWhole(o.button) || !(o.stacks[o.button]! > 0)) throw new Error('the button must be on a live seat');
  let deck: Card[];
  if (o.deck) {
    if (!o.deck.every(isCard) || new Set(o.deck).size !== o.deck.length) throw new Error('a stacked deck must be distinct cards');
    const used = new Set(o.deck);
    deck = [...o.deck, ...DECK.filter((c) => !used.has(c))];
  } else deck = shuffle(DECK, o.deckSeed);

  const seats: SeatState[] = o.stacks.map((stack) => ({ stack, start: stack, bet: 0, committed: 0, status: stack > 0 ? 'active' : 'empty', hole: [], acted: false, actedAt: 0 }));
  // Heads-up the button posts the small blind; otherwise the small blind sits left of the button.
  const sbSeat = order.length === 2 ? o.button : order[0]!;
  const bbSeat = order.length === 2 ? order[0]! : order[1]!;
  const s: HandState = {
    sb: o.sb,
    bb: o.bb,
    ante,
    button: o.button,
    sbSeat,
    bbSeat,
    deckSeed: o.deckSeed,
    deck,
    seats,
    board: [],
    street: 'preflop',
    currentBet: o.bb,
    minRaise: o.bb,
    raises: 0,
    aggressor: null,
    toAct: null,
    actions: [],
    events: [{ type: 'start', button: o.button, sb: o.sb, bb: o.bb, ante, stacks: [...o.stacks] }],
    level: o.level ?? null,
  };
  const post = (seat: number, blind: 'ante' | 'sb' | 'bb', want: number) => {
    const p = seats[seat]!;
    const amount = Math.min(want, p.stack);
    if (amount <= 0) return;
    p.stack -= amount;
    p.committed += amount;
    if (blind !== 'ante') p.bet += amount;
    if (p.stack === 0) p.status = 'allin';
    s.events.push({ type: 'post', seat, blind, amount, allIn: p.stack === 0 });
  };
  // Antes are dead money: in the pot, but not part of the bet to call.
  if (ante > 0) for (const seat of order) post(seat, 'ante', ante);
  post(sbSeat, 'sb', o.sb);
  post(bbSeat, 'bb', o.bb);
  order.forEach((seat, k) => (seats[seat]!.hole = [deck[k]!, deck[k + order.length]!]));
  for (const seat of order) s.events.push({ type: 'hole', seat, cards: [...seats[seat]!.hole] });
  // The first to act before the flop is left of the big blind (heads-up, that is the button).
  settle(s, bbSeat);
  return s;
}

/** The seat to act, or null when the hand is over. */
export const toAct = (s: HandState): number | null => s.toAct;

/** All chips at the table: stacks plus what is in the middle (the same before and after every action). */
export const chipsOf = (s: HandState): number => s.seats.reduce((a, p) => a + p.stack, 0) + (s.street === 'done' ? 0 : s.seats.reduce((a, p) => a + p.committed, 0));

/** Every chip in the middle, this street's bets included. */
const potTotal = (s: HandState): number => s.seats.reduce((a, p) => a + p.committed, 0);

const othersActive = (s: HandState, seat: number): boolean => s.seats.some((p, i) => i !== seat && p.status === 'active');
/** The biggest bet on this street among the others still in the hand. */
const maxOtherBet = (s: HandState, seat: number): number => s.seats.reduce((m, p, i) => (i !== seat && (p.status === 'active' || p.status === 'allin') ? Math.max(m, p.bet) : m), 0);

/** The bet a seat has to match: the current bet, but no more than an all-in can match when nobody else can bet. */
function callTarget(s: HandState, seat: number): number {
  return othersActive(s, seat) ? s.currentBet : Math.min(s.currentBet, Math.max(maxOtherBet(s, seat), s.seats[seat]!.bet));
}

function needsToAct(s: HandState, seat: number): boolean {
  const p = s.seats[seat]!;
  if (p.status !== 'active') return false;
  const target = callTarget(s, seat);
  if (!othersActive(s, seat)) return p.bet < target;
  return !p.acted || p.bet < target;
}

/**
 * Whether a seat may bet or raise: it has chips beyond the call, someone else could still call, and the betting is
 * open to it (it has not acted on this street, or the bet has gone up by a full raise since it did; a short all-in
 * does not reopen the betting).
 */
function mayRaise(s: HandState, seat: number): boolean {
  const p = s.seats[seat]!;
  if (p.status !== 'active' || !othersActive(s, seat)) return false;
  if (p.stack <= s.currentBet - p.bet) return false;
  return !p.acted || s.currentBet - p.actedAt >= s.minRaise;
}

const SIZES: readonly { key: OptionKey; f: number; name: string }[] = [
  { key: 'small', f: 1 / 3, name: 'a third of the pot' },
  { key: 'half', f: 1 / 2, name: 'half pot' },
  { key: 'three_quarters', f: 3 / 4, name: 'three quarters of the pot' },
  { key: 'pot', f: 1, name: 'pot' },
];

/**
 * The legal options for the seat to act, in menu order (empty when the hand is over). Sizes raise to
 * current bet + f x (pot + to call), with the pot every chip in the middle, this street's bets included, and f a
 * third, a half, three quarters or one; `small` before the flop, when nobody has raised yet, is a raise to 2.5 big
 * blinds instead, or to the half-pot size if that is less. Each size is raised to the minimum raise; a size the stack
 * cannot cover becomes all-in only; a size that is not bigger than the one before it goes (the smaller key stays), so
 * the amounts rise in menu order. All-in is there whenever a raise is, and a call that takes the whole stack is a call.
 */
export function legalOptions(s: HandState): Option[] {
  if (s.toAct === null) return [];
  const seat = s.toAct;
  const p = s.seats[seat]!;
  const out: Option[] = [];
  const target = callTarget(s, seat);
  const toCall = target - p.bet;
  if (toCall > 0) {
    const add = Math.min(toCall, p.stack);
    out.push({ key: 'fold', kind: 'fold', to: p.bet, add: 0, label: 'Fold' });
    out.push({ key: 'call', kind: 'call', to: p.bet + add, add, label: add === p.stack ? `Call ${add} (all-in)` : `Call ${add}` });
  } else out.push({ key: 'check', kind: 'check', to: p.bet, add: 0, label: 'Check' });
  if (!mayRaise(s, seat)) return out;
  const maxTo = p.bet + p.stack;
  const minTo = s.currentBet + s.minRaise;
  const kind: ActionKind = s.currentBet === 0 ? 'bet' : 'raise';
  const verb = kind === 'bet' ? 'Bet' : 'Raise to';
  const pot = potTotal(s);
  const sized = (f: number) => Math.max(s.currentBet + Math.round(f * (pot + toCall)), minTo);
  let last = 0;
  for (const { key, f, name } of SIZES) {
    let to = sized(f);
    let label = name;
    if (key === 'small' && s.street === 'preflop' && s.raises === 0) {
      // Unopened before the flop: 2.5 big blinds, unless half the pot is less (heads-up, or with antes in).
      const open = Math.max(Math.round(2.5 * s.bb), minTo);
      [to, label] = open <= sized(1 / 2) ? [open, '2.5 big blinds'] : [sized(1 / 2), 'half pot'];
    }
    if (to >= maxTo || to <= last) continue;
    last = to;
    out.push({ key, kind, to, add: to - p.bet, label: `${verb} ${to} (${label})` });
  }
  out.push({ key: 'allin', kind: 'allin', to: maxTo, add: p.stack, label: `All-in for ${maxTo}` });
  return out;
}

/** The option an action stands for, or why it is not legal now. */
function resolve(s: HandState, a: Action): Option | string {
  if (s.toAct === null) return 'nobody is to act: the hand is over';
  if ('key' in a) return legalOptions(s).find((o) => o.key === a.key) ?? `${String(a.key)} is not a legal option now`;
  if (a.kind !== 'raise' || !isWhole(a.to)) return 'a raise needs a whole number of chips to raise to';
  const seat = s.toAct;
  const p = s.seats[seat]!;
  if (!mayRaise(s, seat)) return 'this player cannot raise now';
  const maxTo = p.bet + p.stack;
  if (a.to === maxTo) return { key: 'allin', kind: 'allin', to: maxTo, add: p.stack, label: `All-in for ${maxTo}` };
  const minTo = s.currentBet + s.minRaise;
  if (a.to < minTo) return `a raise must be to at least ${minTo}`;
  if (a.to > maxTo) return `a raise can be to at most ${maxTo} (all-in)`;
  const kind: ActionKind = s.currentBet === 0 ? 'bet' : 'raise';
  return { key: 'pot', kind, to: a.to, add: a.to - p.bet, label: `${kind === 'bet' ? 'Bet' : 'Raise to'} ${a.to}` };
}

/** Plays an action for the seat to act and returns the new state; throws if it is not legal. */
export function applyAction(state: HandState, a: Action): HandState {
  const o = resolve(state, a);
  if (typeof o === 'string') throw new Error(o);
  const s = copy(state);
  const seat = s.toAct!;
  const p = s.seats[seat]!;
  if (o.kind === 'fold') p.status = 'folded';
  else {
    p.stack -= o.add;
    p.bet += o.add;
    p.committed += o.add;
    if (p.stack === 0) p.status = 'allin';
  }
  if (p.bet > s.currentBet) {
    // A full raise (at least the last one) sets the new minimum; a short all-in leaves it.
    if (p.bet - s.currentBet >= s.minRaise) s.minRaise = p.bet - s.currentBet;
    s.currentBet = p.bet;
    s.raises += 1;
    s.aggressor = seat;
  }
  p.acted = true;
  p.actedAt = s.currentBet;
  const record: ActionRecord = { street: s.street as Street, seat, key: 'key' in a ? o.key : null, kind: o.kind, to: o.to, add: o.add, allIn: p.status === 'allin' };
  s.actions.push(record);
  const { street: _street, ...event } = record;
  s.events.push({ type: 'action', ...event });
  settle(s, seat);
  return s;
}

/** After an action (or the deal): the next player to act, or the next street, or the end of the hand. Changes `s`. */
function settle(s: HandState, from: number): void {
  const n = s.seats.length;
  for (;;) {
    const inHand = s.seats.filter((p) => p.status === 'active' || p.status === 'allin').length;
    if (inHand === 1) return finish(s, false);
    const next = nextSeat(n, from, (i) => needsToAct(s, i));
    if (next >= 0) {
      s.toAct = next;
      return;
    }
    s.toAct = null;
    if (s.street === 'river') return finish(s, true);
    const street = STREETS[STREETS.indexOf(s.street as Street) + 1] as Exclude<Street, 'preflop'>;
    const live = s.seats.filter((p) => p.status !== 'empty').length;
    const start = 2 * live + s.board.length;
    const cards = s.deck.slice(start, start + (street === 'flop' ? 3 : 1));
    s.board = [...s.board, ...cards];
    s.street = street;
    s.events.push({ type: 'street', street, cards, board: [...s.board] });
    for (const p of s.seats) {
      p.bet = 0;
      p.acted = false;
      p.actedAt = 0;
    }
    s.currentBet = 0;
    s.minRaise = s.bb;
    s.raises = 0;
    s.aggressor = null;
    // After the flop the first live seat left of the button starts.
    from = s.button;
  }
}

export interface Pot {
  amount: number;
  /** The seats that can win it. */
  eligible: number[];
}

/**
 * The pots as the chips stand: a main pot, then a side pot above each all-in. A pot can be won by the players still
 * in the hand who matched it (or, while the hand runs, could still match it).
 */
export function potsOf(s: HandState): Pot[] {
  const levels = [...new Set(s.seats.filter((p) => p.status === 'allin').map((p) => p.committed))];
  levels.push(Math.max(...s.seats.map((p) => p.committed)));
  levels.sort((a, b) => a - b);
  const pots: Pot[] = [];
  let prev = 0;
  for (const level of levels) {
    if (level <= prev) continue;
    const amount = s.seats.reduce((a, p) => a + Math.min(p.committed, level) - Math.min(p.committed, prev), 0);
    const eligible = s.seats.flatMap((p, i) => (p.status === 'active' || (p.status === 'allin' && p.committed >= level) ? [i] : []));
    if (amount > 0) pots.push({ amount, eligible });
    prev = level;
  }
  return pots;
}

/** Seats from left of the button round to the button: the order for odd chips and showing hands. */
const fromButton = (s: HandState, seats: readonly number[], start = s.button + 1): number[] => {
  const n = s.seats.length;
  return [...seats].sort((a, b) => ((a - start + n) % n) - ((b - start + n) % n));
};

/** Ends the hand: the uncalled bet back, the showdown (if any), the pots awarded. Changes `s`. */
function finish(s: HandState, showdown: boolean): void {
  s.toAct = null;
  // The uncalled part of the biggest bet goes back to whoever made it.
  const sorted = s.seats.map((p, i) => [p.committed, i] as const).sort((a, b) => b[0] - a[0]);
  const [top, second] = [sorted[0]!, sorted[1]!];
  if (top[0] > second[0]) {
    const p = s.seats[top[1]]!;
    const amount = top[0] - second[0];
    p.stack += amount;
    p.committed -= amount;
    p.bet = Math.max(0, p.bet - amount);
    s.events.push({ type: 'return', seat: top[1], amount });
  }
  const contenders = s.seats.flatMap((p, i) => (p.status === 'active' || p.status === 'allin' ? [i] : []));
  const values = new Map<number, number>();
  if (showdown) {
    // The last bettor on the river shows first, else the first seat left of the button.
    const order = fromButton(s, contenders, s.aggressor ?? s.button + 1);
    const hands: ShownHand[] = order.map((seat) => {
      const r = rankHand([...s.seats[seat]!.hole, ...s.board]);
      values.set(seat, r.value);
      return { seat, cards: [...s.seats[seat]!.hole], value: r.value, category: r.category, best: r.best };
    });
    s.events.push({ type: 'showdown', hands });
  }
  const pots = showdown ? potsOf(s) : [{ amount: potTotal(s), eligible: contenders }];
  // Each pot goes to the best hand among the seats that can win it; a split gives the odd chips from left of the button.
  pots.forEach((pot, index) => {
    const best = Math.max(...pot.eligible.map((i) => values.get(i) ?? 0));
    const winners = fromButton(s, pot.eligible.filter((i) => (values.get(i) ?? 0) === best));
    const share = Math.floor(pot.amount / winners.length);
    const odd = pot.amount - share * winners.length;
    const shares = winners.map((_, k) => share + (k < odd ? 1 : 0));
    winners.forEach((w, k) => (s.seats[w]!.stack += shares[k]!));
    s.events.push({ type: 'award', pot: index, amount: pot.amount, eligible: pot.eligible, winners, shares });
  });
  s.street = 'done';
  s.events.push({ type: 'end', stacks: s.seats.map((p) => p.stack), net: s.seats.map((p) => p.stack - p.start) });
}

/** Chips won or lost in a finished hand, per seat. */
export const netOf = (s: HandState): number[] => s.seats.map((p) => p.stack - p.start);

// Views: what a player, a spectator or a reviewer sees, as JSON-able values with cards written 'As'.

const POSITIONS_AFTER_BB: readonly (readonly string[])[] = [[], ['UTG'], ['UTG', 'CO'], ['UTG', 'MP', 'CO'], ['UTG', 'MP', 'HJ', 'CO'], ['UTG', 'UTG+1', 'MP', 'HJ', 'CO'], ['UTG', 'UTG+1', 'UTG+2', 'MP', 'HJ', 'CO'], ['UTG', 'UTG+1', 'UTG+2', 'MP', 'MP+1', 'HJ', 'CO']];

/** Each seat's position name ('' for an empty seat): BTN, SB, BB, then UTG round to CO. Heads-up: BTN and BB. */
export function positionsOf(s: HandState): string[] {
  const names = s.seats.map(() => '');
  const live = dealOrder(s.seats.map((p) => p.start), s.button);
  names[s.button] = 'BTN';
  names[s.bbSeat] = 'BB';
  if (live.length > 2) names[s.sbSeat] = 'SB';
  const rest = live.filter((i) => i !== s.button && i !== s.sbSeat && i !== s.bbSeat);
  rest.forEach((seat, k) => (names[seat] = POSITIONS_AFTER_BB[rest.length]![k]!));
  return names;
}

export interface PlayerView {
  seat: number;
  position: string;
  stack: number;
  bet: number;
  committed: number;
  status: SeatStatus;
  button: boolean;
  /** Hole cards, when this view may see them; null otherwise. */
  cards: string[] | null;
}

export interface HistoryItem {
  street: Street;
  seat: number;
  position: string;
  key: OptionKey | null;
  kind: ActionKind;
  to: number;
  add: number;
  allIn: boolean;
}

export interface TableView {
  street: Phase;
  board: string[];
  /** Every chip in the middle. */
  pot: number;
  pots: Pot[];
  button: number;
  blinds: { sb: number; bb: number; ante: number };
  /** The Sit & Go's level and hand count; null in a cash hand. */
  level: LevelInfo | null;
  currentBet: number;
  toAct: number | null;
  players: PlayerView[];
  /** This hand's actions so far. */
  history: HistoryItem[];
  /** When the hand is over: who won each pot. */
  awards: { pot: number; amount: number; eligible: number[]; winners: number[]; shares: number[] }[];
}

/** What one player sees: its own cards, never another's (until shown), and its options when it is to act. */
export interface Observation extends TableView {
  seat: number;
  position: string;
  holeCards: string[];
  /** Chips to call (0 when it can check). */
  toCall: number;
  /** The smallest raise, as a street total, when a raise is open. */
  minRaiseTo: number | null;
  /** The legal options when this seat is to act; empty otherwise. */
  options: Option[];
}

const cardsText = (cs: readonly Card[]): string[] => cs.map(formatCard);

/** Seats whose cards were shown at a showdown. */
const shownSeats = (s: HandState): Set<number> => new Set(s.events.flatMap((e) => (e.type === 'showdown' ? e.hands.map((h) => h.seat) : [])));

function tableView(s: HandState, canSee: (seat: number) => boolean): TableView {
  const positions = positionsOf(s);
  return {
    street: s.street,
    board: cardsText(s.board),
    pot: potTotal(s),
    pots: s.street === 'done' ? [] : potsOf(s),
    button: s.button,
    blinds: { sb: s.sb, bb: s.bb, ante: s.ante },
    level: s.level && { ...s.level, next: { ...s.level.next } },
    currentBet: s.currentBet,
    toAct: s.toAct,
    players: s.seats.map((p, seat) => ({ seat, position: positions[seat]!, stack: p.stack, bet: p.bet, committed: p.committed, status: p.status, button: seat === s.button, cards: p.hole.length && canSee(seat) ? cardsText(p.hole) : null })),
    history: s.actions.map((a) => ({ street: a.street, seat: a.seat, position: positions[a.seat]!, key: a.key, kind: a.kind, to: a.to, add: a.add, allIn: a.allIn })),
    awards: s.events.flatMap((e) => (e.type === 'award' ? [{ pot: e.pot, amount: e.amount, eligible: [...e.eligible], winners: [...e.winners], shares: [...e.shares] }] : [])),
  };
}

/** The view for `seat`: what a model or a human at that seat is given to decide. */
export function observe(s: HandState, seat: number): Observation {
  const shown = shownSeats(s);
  const view = tableView(s, (i) => i === seat || shown.has(i));
  const p = s.seats[seat]!;
  const mine = s.toAct === seat;
  return {
    ...view,
    seat,
    position: view.players[seat]!.position,
    holeCards: cardsText(p.hole),
    toCall: p.status === 'active' ? Math.max(0, Math.min(callTarget(s, seat) - p.bet, p.stack)) : 0,
    minRaiseTo: mine && mayRaise(s, seat) ? Math.min(s.currentBet + s.minRaise, p.bet + p.stack) : null,
    options: mine ? legalOptions(s) : [],
  };
}

/** What a spectator sees: no hole cards until a showdown shows them. */
export const publicView = (s: HandState): TableView => {
  const shown = shownSeats(s);
  return tableView(s, (i) => shown.has(i));
};

/** Everything, every hole card included: for watching AIs play and for the review after a hand. */
export const fullView = (s: HandState): TableView => tableView(s, () => true);

/** The events a seat (or, with null, a spectator) may see: others' hole cards left out until shown. A deep copy. */
export function visibleEvents(events: readonly HandEvent[], seat: number | null): HandEvent[] {
  return events.map((e) => (e.type === 'hole' && e.seat !== seat ? { ...e, cards: [] } : structuredClone(e)));
}
