// What the table chat (views/chat.ts) says for a hand's events, as the dealer of an online card room would: a line to
// open each hand, every move, the board as it comes, and who won what. Pure, so tests check it; the chat adds the
// models' words and reasoning to the moves.
import { formatCard } from '../shared/cards.ts';
import type { HandEvent, Street } from '../shared/engine.ts';
import type { Category } from '../shared/evaluator.ts';
import type { Mood } from '../shared/recording.ts';

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

/**
 * Your lines sent and not yet answered, oldest first. The table answers them in the order they were sent (said, or
 * not said and why), so each answer settles the oldest ones: matched by order, never by text (the server cleans a line
 * again, and a line may come back other than it was typed).
 */
export class PendingTalk<T> {
  private q: T[] = [];

  get size(): number {
    return this.q.length;
  }

  add(x: T): void {
    this.q.push(x);
  }

  /** The `n` oldest, settled. */
  take(n: number): T[] {
    return this.q.splice(0, n);
  }
}

/** Why a line of yours was not said, as the chat shows it under the line. */
export const NOT_SAID: Record<'busy' | 'full' | 'refused' | 'over', string> = {
  busy: 'not sent: too much talk for now',
  full: 'not sent: enough talk this hand',
  refused: 'not sent',
  over: 'not sent: the game is over',
};

/** Where the chat's "Show thinking" switch is remembered, per kind of table (playing, or watching and replays). */
export const thinkingKey = (mode: 'play' | 'watch'): string => `holdem:show-thinking:${mode}`;

/** Whether the chat opens every "what it was thinking": as last set for this kind of table, else on when watching. */
export const showThinking = (mode: 'play' | 'watch', stored: string | null): boolean => (stored === 'on' ? true : stored === 'off' ? false : mode === 'watch');

/** A finished hand's chat, as it went: each line with the words that came with its move, and the player's own talk. */
export type PlayedLine = { line: ChatLine; words?: { say?: string; mood?: Mood; reasoning?: string } } | { talk: { seat: number; say: string } };

/**
 * The chat of a finished hand (a review's hand): what a replay that jumps ahead shows for the hands it skipped. The
 * moves take their words and reasoning from the hand's actions, in order; the player's lines go in before the move
 * they came with (talk[].after), the last after the hand's last move.
 */
export function playedHandLines(hand: { hand: number; events: readonly HandEvent[]; actions: readonly { say?: string; mood?: Mood; reasoning?: string }[]; talk?: readonly { seat: number; after: number; say: string }[] }): PlayedLine[] {
  const out: PlayedLine[] = [];
  const talk = hand.talk ?? [];
  let move = 0;
  const said = (upTo: number) => {
    for (const t of talk) if (t.after === upTo) out.push({ talk: { seat: t.seat, say: t.say } });
  };
  for (const line of chatLinesOf(hand.events, hand.hand)) {
    if (line.kind === 'move') {
      said(move);
      const a = hand.actions[move++];
      out.push(a && (a.say || a.reasoning || a.mood) ? { line, words: { ...(a.say ? { say: a.say } : {}), ...(a.mood ? { mood: a.mood } : {}), ...(a.reasoning ? { reasoning: a.reasoning } : {}) } } : { line });
    } else out.push({ line });
  }
  for (const t of talk) if (t.after >= move) out.push({ talk: { seat: t.seat, say: t.say } });
  return out;
}
