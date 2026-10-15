// What the table shows, rebuilt one event at a time, so the page can animate a step that holds many events (an all-in
// run-out deals the flop, turn and river, shows the hands and pays the pots in one step). Pure: the snapshot's view
// stays the authority, and the page checks the two agree at the end of every step.
import { formatCard } from '../shared/cards.ts';
import type { ActionKind, HandEvent, Street } from '../shared/engine.ts';
import type { Category } from '../shared/evaluator.ts';

export interface SeatModel {
  stack: number;
  /** Chips in front of the seat on this street. */
  bet: number;
  /** In the hand (dealt and not folded). */
  live: boolean;
  /** Dealt into this hand. */
  dealt: boolean;
  allIn: boolean;
  folded: boolean;
  /** Hole cards when this viewer may see them ('As'), [] when dealt face down, null when not dealt. */
  cards: string[] | null;
  /** Shown at the showdown. */
  shown: Category | null;
  /** The last thing it did on this street, for its name plate. */
  last: { kind: ActionKind; allIn: boolean } | null;
  /** Chips won this hand. */
  won: number;
  /** Everything it has put in this hand (antes and blinds too, less any uncalled bet back). */
  committed: number;
}

export interface TableModel {
  street: Street | 'done';
  button: number;
  sb: number;
  bb: number;
  ante: number;
  board: string[];
  /** Chips gathered in the middle from earlier streets and antes (not this street's bets). */
  middle: number;
  seats: SeatModel[];
}

export function emptyModel(seats: number): TableModel {
  return {
    street: 'preflop',
    button: 0,
    sb: 0,
    bb: 0,
    ante: 0,
    board: [],
    middle: 0,
    seats: Array.from({ length: seats }, () => ({ stack: 0, bet: 0, live: false, dealt: false, allIn: false, folded: false, cards: null, shown: null, last: null, won: 0, committed: 0 })),
  };
}

/** Moves every bet into the middle. Changes `m`. */
function gather(m: TableModel): void {
  for (const p of m.seats) {
    m.middle += p.bet;
    p.bet = 0;
  }
}

/** The model after one event. Returns a new model; the one given is left as it was. */
export function applyEvent(prev: TableModel, e: HandEvent): TableModel {
  const m: TableModel = { ...prev, board: [...prev.board], seats: prev.seats.map((p) => ({ ...p, cards: p.cards && [...p.cards] })) };
  switch (e.type) {
    case 'start':
      m.street = 'preflop';
      m.button = e.button;
      m.sb = e.sb;
      m.bb = e.bb;
      m.ante = e.ante;
      m.board = [];
      m.middle = 0;
      m.seats = e.stacks.map((stack) => ({ stack, bet: 0, live: stack > 0, dealt: false, allIn: false, folded: false, cards: null, shown: null, last: null, won: 0, committed: 0 }));
      break;
    case 'post': {
      const p = m.seats[e.seat]!;
      p.stack -= e.amount;
      p.committed += e.amount;
      if (e.blind === 'ante') m.middle += e.amount;
      else p.bet += e.amount;
      if (e.allIn) p.allIn = true;
      break;
    }
    case 'hole': {
      const p = m.seats[e.seat]!;
      p.dealt = true;
      p.cards = e.cards.map(formatCard);
      break;
    }
    case 'action': {
      const p = m.seats[e.seat]!;
      p.stack -= e.add;
      p.committed += e.add;
      if (e.kind === 'fold') {
        p.folded = true;
        p.live = false;
      } else p.bet = e.to;
      if (e.allIn) p.allIn = true;
      p.last = { kind: e.kind, allIn: e.allIn };
      break;
    }
    case 'street':
      gather(m);
      m.street = e.street;
      m.board = e.board.map(formatCard);
      for (const p of m.seats) if (!p.folded && !p.allIn) p.last = null;
      break;
    case 'return': {
      const p = m.seats[e.seat]!;
      const fromBet = Math.min(p.bet, e.amount);
      p.bet -= fromBet;
      m.middle -= e.amount - fromBet;
      p.stack += e.amount;
      p.committed -= e.amount;
      break;
    }
    case 'showdown':
      for (const h of e.hands) {
        const p = m.seats[h.seat]!;
        p.cards = h.cards.map(formatCard);
        p.shown = h.category;
      }
      break;
    case 'award':
      gather(m);
      e.winners.forEach((w, k) => {
        m.seats[w]!.stack += e.shares[k]!;
        m.seats[w]!.won += e.shares[k]!;
      });
      m.middle -= e.amount;
      break;
    case 'end':
      m.street = 'done';
      e.stacks.forEach((s, i) => (m.seats[i]!.stack = s));
      break;
  }
  return m;
}

/**
 * The pots as the chips stand, as the engine builds them (engine.ts potsOf): a main pot, then a side pot above each
 * all-in, each with the seats that can win it. Every chip put in counts, this street's bets too.
 */
export function potsOfModel(m: TableModel): { amount: number; eligible: number[] }[] {
  const levels = [...new Set(m.seats.filter((p) => p.allIn && !p.folded).map((p) => p.committed))];
  levels.push(Math.max(0, ...m.seats.map((p) => p.committed)));
  levels.sort((a, b) => a - b);
  const pots: { amount: number; eligible: number[] }[] = [];
  let prev = 0;
  for (const level of levels) {
    if (level <= prev) continue;
    const amount = m.seats.reduce((a, p) => a + Math.min(p.committed, level) - Math.min(p.committed, prev), 0);
    const eligible = m.seats.flatMap((p, i) => (p.dealt && !p.folded && (!p.allIn || p.committed >= level) ? [i] : []));
    if (amount > 0) pots.push({ amount, eligible });
    prev = level;
  }
  return pots;
}

/** The model after a list of events, from an empty table. */
export const modelOf = (seats: number, events: readonly HandEvent[]): TableModel => events.reduce(applyEvent, emptyModel(seats));
