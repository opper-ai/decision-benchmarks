// What the table chat (views/chat.ts) says for a hand's events, as the dealer of an online card room would: a line to
// open each hand, every move, the board as it comes, and who won what. Pure, so tests check it; the chat adds the
// models' words and reasoning to the moves.
import { formatCard } from '../shared/cards.ts';
import type { HandEvent, Street } from '../shared/engine.ts';
import type { Category } from '../shared/evaluator.ts';

export type ActionEvent = Extract<HandEvent, { type: 'action' }>;

export type ChatLine =
  | { kind: 'hand'; hand: number; sb: number; bb: number; ante: number }
  | { kind: 'move'; seat: number; act: ActionEvent; street: Street }
  | { kind: 'board'; street: Exclude<Street, 'preflop'>; cards: string[] }
  | { kind: 'win'; winners: number[]; amount: number; side: boolean; category: Category | null };

/**
 * The chat's lines for some of a hand's events, in order: all of them, or those since the last answer (then the
 * street of a move is the last street among them, else before the flop; pass `street` to carry it over).
 */
export function chatLinesOf(events: readonly HandEvent[], hand: number, street: Street = 'preflop'): ChatLine[] {
  const shown = new Map<number, Category>();
  const out: ChatLine[] = [];
  let now = street;
  for (const e of events) {
    if (e.type === 'start') {
      out.push({ kind: 'hand', hand, sb: e.sb, bb: e.bb, ante: e.ante });
      now = 'preflop';
    } else if (e.type === 'action') out.push({ kind: 'move', seat: e.seat, act: e, street: now });
    else if (e.type === 'street') {
      now = e.street;
      out.push({ kind: 'board', street: e.street, cards: e.cards.map(formatCard) });
    } else if (e.type === 'showdown') for (const x of e.hands) shown.set(x.seat, x.category);
    else if (e.type === 'award' && e.winners.length) out.push({ kind: 'win', winners: [...e.winners], amount: e.amount, side: e.pot !== 0, category: shown.get(e.winners[0]!) ?? null });
  }
  return out;
}

/** The longest line a player may say to the table. */
export const SAY_MAX = 90;

/** The counter under the chat's input: "12/90". */
export const sayCount = (text: string): string => `${[...text].length}/${SAY_MAX}`;
