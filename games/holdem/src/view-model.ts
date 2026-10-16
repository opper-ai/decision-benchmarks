// Pure helpers between the engine's views and the page: where each seat sits, how actions, cards, chips and levels
// read, and what the tell meter shows. No DOM here, so all of it is tested.
import { isBotName } from '../shared/bots.ts';
import type { ActionKind, LevelInfo, OptionKey, Pot } from '../shared/engine.ts';
import type { Category } from '../shared/evaluator.ts';
import type { SeatConfig } from './driver.ts';
import { BOT_LABELS, modelById } from './roster.ts';

/** Where a seat sits round the oval, as the viewer sees it. */
export type Slot = 'bottom' | 'left' | 'top' | 'right' | 'top-left' | 'top-right';

const SLOTS: Record<number, Slot[]> = {
  2: ['bottom', 'top'],
  3: ['bottom', 'top-left', 'top-right'],
  4: ['bottom', 'left', 'top', 'right'],
  // Five and six: the side seats lower down the oval, two across its top (and one at its head for six); style.css
  // places them by the table's seat count (data-seats).
  5: ['bottom', 'left', 'top-left', 'top-right', 'right'],
  6: ['bottom', 'left', 'top-left', 'top', 'top-right', 'right'],
};

/** The slot of each seat: the viewer (or seat 0) at the bottom, the others clockwise from there, as seats go. */
export function slotsFor(seats: number, viewer: number | null): Slot[] {
  const order = SLOTS[seats];
  if (!order) throw new Error('a table seats 2 to 6 players');
  const first = viewer ?? 0;
  return Array.from({ length: seats }, (_, seat) => order[(seat - first + seats) % seats]!);
}

/** 1500 -> "1,500". */
export const chips = (n: number): string => Math.round(n).toLocaleString('en-US');

/** What an action reads as after the player's name: "raises to 300", "is all-in for 1,500"; after "You": "raise to 300". */
export function actionText(a: { kind: ActionKind; to: number; add: number; allIn: boolean }, you = false): string {
  const text = thirdPerson(a);
  return you ? text.replace(/^is /, 'are ').replace(/^(\w+)s\b/, '$1') : text;
}

function thirdPerson(a: { kind: ActionKind; to: number; add: number; allIn: boolean }): string {
  if (a.kind === 'fold') return 'folds';
  if (a.kind === 'check') return 'checks';
  if (a.kind === 'call') return a.allIn ? `calls ${chips(a.add)}, all-in` : `calls ${chips(a.add)}`;
  if (a.kind === 'allin') return `is all-in for ${chips(a.to)}`;
  if (a.kind === 'bet') return a.allIn ? `bets ${chips(a.to)}, all-in` : `bets ${chips(a.to)}`;
  return a.allIn ? `raises to ${chips(a.to)}, all-in` : `raises to ${chips(a.to)}`;
}

/** How an action reads at a glance in the thinking log and the review: its words, and a colour for what it does. */
export type ChipTone = 'fold' | 'calm' | 'push' | 'allin';
export function actionChip(a: { kind: ActionKind; to: number; add: number; allIn: boolean }): { label: string; tone: ChipTone } {
  if (a.kind === 'fold') return { label: 'Fold', tone: 'fold' };
  if (a.kind === 'check') return { label: 'Check', tone: 'calm' };
  if (a.kind === 'call') return a.allIn ? { label: `Call ${chips(a.add)}, all-in`, tone: 'allin' } : { label: `Call ${chips(a.add)}`, tone: 'calm' };
  if (a.allIn || a.kind === 'allin') return { label: `All-in ${chips(a.to)}`, tone: 'allin' };
  return { label: a.kind === 'bet' ? `Bet ${chips(a.to)}` : `Raise to ${chips(a.to)}`, tone: 'push' };
}

/** The streets as the log's and the review's headers name them. */
export const STREET_NAMES: Record<'preflop' | 'flop' | 'turn' | 'river', string> = { preflop: 'Before the flop', flop: 'Flop', turn: 'Turn', river: 'River' };

/**
 * How long a speech bubble stays up: time to read it (about 15 characters a second, after a moment to notice it),
 * between 2.5 and 8 seconds, shorter when the table is sped up, but never less than 1.2 seconds.
 */
export function bubbleMs(text: string, speed: number): number {
  const read = Math.min(8000, Math.max(2500, 1200 + 65 * [...text].length));
  return Math.max(1200, Math.round(read / Math.sqrt(Math.max(1, speed))));
}

/** Up to this many characters a speech bubble's words are at full size; a longer line (talk is at most 90) a step smaller, so it fits three lines. */
export const BUBBLE_FULL_SIZE = 45;

/** A speech bubble's text size for a line: 'full' or, for a long line, 'long' (a step smaller). */
export function bubbleSize(text: string): 'full' | 'long' {
  return [...text].length <= BUBBLE_FULL_SIZE ? 'full' : 'long';
}

/** What an empty thinking log says, by the styles at the table (null for you or a bot): why it is empty. */
export function logNote(styles: readonly ('decision' | 'chat' | null)[]): string {
  return styles.includes('chat')
    ? 'Nothing said yet. What the models say, and why they play as they do, shows here.'
    : 'Decision models don’t explain their moves: their tell meters show how sure they were.';
}

/** A short word for the seat's last action, shown on its name plate. */
export function actionTag(kind: ActionKind, allIn: boolean): string {
  if (allIn) return 'All-in';
  return { fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise', allin: 'All-in' }[kind];
}

export interface CardFace {
  rank: string;
  suit: '♠' | '♥' | '♦' | '♣';
  red: boolean;
  /** For screen readers: "Ace of spades". */
  label: string;
}

const RANK_NAMES: Record<string, string> = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack', T: 'Ten', '9': 'Nine', '8': 'Eight', '7': 'Seven', '6': 'Six', '5': 'Five', '4': 'Four', '3': 'Three', '2': 'Two' };
const SUITS: Record<string, { suit: CardFace['suit']; name: string; red: boolean }> = {
  s: { suit: '♠', name: 'spades', red: false },
  h: { suit: '♥', name: 'hearts', red: true },
  d: { suit: '♦', name: 'diamonds', red: true },
  c: { suit: '♣', name: 'clubs', red: false },
};

/** 'Td' -> 10 of diamonds, red. */
export function cardFace(text: string): CardFace {
  const r = text[0]!;
  const s = SUITS[text[1]!];
  if (!RANK_NAMES[r] || !s) throw new Error(`not a card: ${text}`);
  return { rank: r === 'T' ? '10' : r, suit: s.suit, red: s.red, label: `${RANK_NAMES[r]} of ${s.name}` };
}

/** The tell meter: a decision model's probabilities folded into fold, call (or check) and raise (any size). */
export function tellBars(p: Partial<Record<OptionKey, number>> | undefined): { fold: number; call: number; raise: number } | null {
  if (!p) return null;
  const fold = p.fold ?? 0;
  const call = (p.call ?? 0) + (p.check ?? 0);
  const raise = (p.small ?? 0) + (p.half ?? 0) + (p.three_quarters ?? 0) + (p.pot ?? 0) + (p.allin ?? 0);
  const sum = fold + call + raise;
  if (!(sum > 0)) return null;
  return { fold: fold / sum, call: call / sum, raise: raise / sum };
}

/** The pots in the middle as the page lists them: the main pot, then side pots. */
export function potLabels(pots: readonly Pot[]): { label: string; amount: number }[] {
  return pots.map((p, i) => ({ label: i === 0 ? 'Pot' : pots.length > 2 ? `Side pot ${i}` : 'Side pot', amount: p.amount }));
}

const A_HAND: Record<Category, string> = {
  'high card': 'just a high card',
  pair: 'a pair',
  'two pair': 'two pair',
  'three of a kind': 'three of a kind',
  straight: 'a straight',
  flush: 'a flush',
  'full house': 'a full house',
  'four of a kind': 'four of a kind',
  'straight flush': 'a straight flush',
};

/** "a flush", "two pair", "just a high card": a hand in a sentence. */
export const aHand = (c: Category): string => A_HAND[c];

/** "Three of a kind" from the evaluator's category. */
export const handName = (c: Category): string => c[0]!.toUpperCase() + c.slice(1);

/** The blind level as the table shows it. */
export function levelText(level: LevelInfo | null): { blinds: string; next: string | null } {
  if (!level) return { blinds: '', next: null };
  const blinds = `${chips(level.sb)}/${chips(level.bb)}${level.ante ? `, ante ${chips(level.ante)}` : ''}`;
  const n = level.handsUntilNextLevel;
  const next = n <= 1 ? `${chips(level.next.sb)}/${chips(level.next.bb)} next hand` : `${chips(level.next.sb)}/${chips(level.next.bb)} in ${n} hands`;
  return { blinds, next };
}

/** 1 -> "1st". */
export const ordinal = (n: number): string => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

/** Chip colours by value, biggest first: the stack drawn for an amount. */
const DENOMS: readonly [number, string][] = [
  [1000, 'gold'],
  [500, 'violet'],
  [100, 'black'],
  [25, 'green'],
  [5, 'red'],
  [1, 'white'],
];

/** The chips that make up an amount, biggest first, at most `max` (the rest is in the label). */
export function chipStack(amount: number, max = 6): string[] {
  const out: string[] = [];
  let left = Math.max(0, Math.round(amount));
  for (const [value, colour] of DENOMS) {
    while (left >= value && out.length < max) {
      out.push(colour);
      left -= value;
    }
  }
  return out;
}

export interface SeatPerson {
  name: string;
  /** For a phone's name plate: "Luna", with `tag` ("GPT-6") under it. */
  short: string;
  tag: string;
  /** A short line under the name: the model's family, "Bot", or nothing for you. */
  badge: string;
  /** The avatar folder, or null (you, a bot). */
  slug: string | null;
  style: 'decision' | 'chat' | null;
}

/** A character's colour, 0 to 359 on the colour wheel: the same every time for the same name. */
export function hueOf(key: string): number {
  let x = 2166136261;
  for (const ch of key) x = Math.imul(x ^ ch.codePointAt(0)!, 16777619);
  return (x >>> 0) % 360;
}

/** Who a seat is, for the page. */
export function personOf(s: SeatConfig): SeatPerson {
  // You at your own table; in a shared replay, the person who played it.
  if (s.kind === 'human') return s.id === 'you' ? { name: 'You', short: 'You', tag: '', badge: '', slug: null, style: null } : { name: 'Human', short: 'Human', tag: 'Player', badge: 'Player', slug: null, style: null };
  if (s.kind === 'bot') {
    const name = isBotName(s.id) ? BOT_LABELS[s.id] : s.id;
    return { name, short: name, tag: 'Bot', badge: 'Bot', slug: null, style: null };
  }
  const m = modelById(s.id);
  if (!m) return { name: s.id, short: s.id, tag: 'Model', badge: 'Model', slug: null, style: 'chat' };
  return { name: m.name, short: m.short, tag: m.tag, badge: m.badge, slug: m.slug, style: m.style };
}

/** A pause, scaled for the watch speed and reduced motion. */
export const paced = (ms: number, speed: number, reduced: boolean): number => (reduced ? Math.min(ms, 150) : ms) / Math.max(0.25, speed);

export interface MenuButton {
  key: OptionKey;
  /** The button's look: fold, check or call, a raise size, all-in. */
  look: 'fold' | 'call' | 'raise' | 'allin';
  /** The small line: "Call", "Raise to ½ pot". */
  what: string;
  /** Raises only, the small line in two: "Raise to" (or "Bet") and "½ pot". */
  verb?: string;
  size?: string;
  /** The big line: chips, or '' for fold and check. */
  amount: string;
  /** The keyboard shortcut, if any. */
  shortcut: 'F' | 'C' | 'A' | null;
  /** The engine's own words, for screen readers: "Raise to 450 (half pot)". */
  label: string;
}

/** The engine's size names (in its labels' brackets) as a button says them. */
const SIZE_WORDS: Record<string, string> = { '2.5 big blinds': '2.5 BB', 'a third of the pot': '⅓ pot', 'half pot': '½ pot', 'three quarters of the pot': '¾ pot', pot: 'Pot' };

/** The human's menu as buttons, in menu order. */
export function menuButtons(options: readonly { key: OptionKey; kind: ActionKind; to: number; add: number; label: string }[]): MenuButton[] {
  return options.map((o) => {
    if (o.key === 'fold') return { key: o.key, look: 'fold', what: 'Fold', amount: '', shortcut: 'F', label: o.label };
    if (o.key === 'check') return { key: o.key, look: 'call', what: 'Check', amount: '', shortcut: 'C', label: o.label };
    if (o.key === 'call') return { key: o.key, look: 'call', what: o.label.includes('all-in') ? 'Call, all-in' : 'Call', amount: chips(o.add), shortcut: 'C', label: o.label };
    if (o.key === 'allin') return { key: o.key, look: 'allin', what: 'All-in', amount: chips(o.to), shortcut: 'A', label: o.label };
    const named = /\(([^)]+)\)$/.exec(o.label)?.[1] ?? '';
    const size = SIZE_WORDS[named] ?? named;
    const verb = o.kind === 'bet' ? 'Bet' : 'Raise to';
    return { key: o.key, look: 'raise', what: `${verb} ${size}`, verb, size, amount: chips(o.to), shortcut: null, label: o.label };
  });
}

export interface QuickBet {
  key: OptionKey;
  /** The size in words: "½", "2.5 BB", "Pot", and " pot" after a fraction. */
  size: string;
  word: string;
  /** Raise (or bet) to this many chips. */
  to: number;
  amount: string;
  /** Its key, 1 to 4 in menu order. */
  shortcut: string;
  /** The engine's own words, for screen readers. */
  label: string;
}

/**
 * The menu's sizes as keys 1 to 4 (instant raises) and the raise panel's quick picks: menu order, without a size that
 * is the all-in (the bar has its own button) or one that repeats a smaller size's amount.
 */
export function quickBets(options: readonly { key: OptionKey; kind: ActionKind; to: number; add: number; label: string }[]): QuickBet[] {
  const allin = options.find((o) => o.key === 'allin')?.to ?? Infinity;
  const seen = new Set<number>();
  const out: QuickBet[] = [];
  for (const b of menuButtons(options)) {
    if (b.look !== 'raise') continue;
    const o = options.find((x) => x.key === b.key)!;
    if (o.to >= allin || seen.has(o.to)) continue;
    seen.add(o.to);
    const size = b.size ?? '';
    const word = / pot$/.test(size) ? ' pot' : '';
    out.push({ key: b.key, size: size.slice(0, size.length - word.length), word, to: o.to, amount: chips(o.to), shortcut: String(out.length + 1), label: o.label });
  }
  return out.slice(0, 4);
}
