// Cards as small integers, so hands, decks and recordings stay plain numbers and the evaluator can work with bits.
// A card is 0 to 51: its rank is card >> 2 (0 is a two, 12 an ace) and its suit card & 3 (clubs, diamonds, hearts,
// spades). Written as two characters: rank then suit, 'As', 'Td', '7h'. Isomorphic.

export type Card = number;

export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';

export const rankOf = (c: Card): number => c >> 2;
export const suitOf = (c: Card): number => c & 3;
export const cardOf = (rank: number, suit: number): Card => (rank << 2) | suit;

/** Every card, 2c first and As last. */
export const DECK: readonly Card[] = Array.from({ length: 52 }, (_, i) => i);

export const isCard = (v: unknown): v is Card => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 52;

export const formatCard = (c: Card): string => `${RANKS[rankOf(c)]}${SUITS[suitOf(c)]}`;
export const formatCards = (cs: readonly Card[]): string => cs.map(formatCard).join(' ');

/** 'As' to its number; throws on anything else (lower-case ranks and '10' too). */
export function parseCard(text: string): Card {
  const r = text.length === 2 ? RANKS.indexOf(text[0]!) : -1;
  const s = text.length === 2 ? SUITS.indexOf(text[1]!) : -1;
  if (r < 0 || s < 0) throw new Error(`not a card: ${JSON.stringify(text)}`);
  return cardOf(r, s);
}

/** 'As Kd 7h' or 'AsKd7h' to cards. */
export function parseCards(text: string): Card[] {
  const compact = text.replaceAll(' ', '');
  if (compact.length % 2) throw new Error(`not a list of cards: ${JSON.stringify(text)}`);
  return Array.from({ length: compact.length / 2 }, (_, i) => parseCard(compact.slice(2 * i, 2 * i + 2)));
}
