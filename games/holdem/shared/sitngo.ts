// AI Hold'em's Sit & Go (the plan's "Rules"): 2 to 4 players with 1500 chips each play hands of the engine with rising
// blinds until one player has every chip. Pure and deterministic like the engine: a Sit & Go is its key plus its
// actions. Isomorphic.
//
// - Levels: 10/20, 15/30, 25/50, 50/100, 75/150, 100/200, 150/300, then doubling; 8 hands each, counted in hands so
//   slow models don't change the structure. From 100/200 every player antes an eighth of the big blind, rounded to a
//   whole chip (25, 38, 75, ...).
// - The deal: a Sit & Go has a secret 256-bit table key (64 hex digits). Hand h (from 0) is dealt from the deck
//   keyedShuffle(DECK, key, h), Fisher-Yates driven by the ChaCha20 keystream under the key (rng.ts); the first
//   button is drawn from the key's button stream. The cards a player sees say nothing about the cards to come.
// - The button moves to the next seat with chips after every hand. This is a simplified moving button: no dead button
//   and no rule that the big blind must move on by exactly one seat when a player busts.
// - Players who bust in the same hand place in order of the chips they started that hand with (more places higher),
//   then by seat (the lower seat places higher).
import { applyAction, newHand, type Action, type HandState, type LevelInfo } from './engine.ts';
import { DECK } from './cards.ts';
import { keyBytes, keyedShuffle, Keystream, PURPOSE } from './rng.ts';

export const STARTING_STACK = 1500;
export const HANDS_PER_LEVEL = 8;
const LEVELS: readonly (readonly [number, number])[] = [[10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200], [150, 300]];
/** The level (from 0) of 100/200, where antes start. */
const ANTE_LEVEL = 5;

/** The blinds and ante at a level (from 0). */
export function blindsAt(level: number): { sb: number; bb: number; ante: number } {
  const last = LEVELS.length - 1;
  const [sb, bb] = level <= last ? LEVELS[level]! : [LEVELS[last]![0] * 2 ** (level - last), LEVELS[last]![1] * 2 ** (level - last)];
  return { sb, bb, ante: level >= ANTE_LEVEL ? Math.round(bb / 8) : 0 };
}

/** Where hand `handIndex` (from 0) sits in the structure: what the observation tells a player. */
export function levelInfo(handIndex: number): LevelInfo {
  const level = Math.floor(handIndex / HANDS_PER_LEVEL);
  return { hand: handIndex + 1, level: level + 1, ...blindsAt(level), handsUntilNextLevel: HANDS_PER_LEVEL - (handIndex % HANDS_PER_LEVEL), next: blindsAt(level + 1) };
}

export interface Elimination {
  seat: number;
  place: number;
  /** The hand it busted in, from 1. */
  hand: number;
  /** Who knocked it out (knockedOutBy). */
  by: number[];
}

export interface SitAndGo {
  /** The table key (64 hex digits): it deals every hand, so it stays secret until the game is over. */
  key: string;
  startingStack: number;
  /** The hand in play (or just finished), from 0. */
  handIndex: number;
  button: number;
  hand: HandState;
  /** Finishing place per seat (1 wins), null while still playing. */
  places: (number | null)[];
  eliminations: Elimination[];
  over: boolean;
}

/** Chips per seat as they stand (in the middle not counted while a hand is played). */
export const stacksOf = (g: SitAndGo): number[] => g.hand.seats.map((p) => p.stack);

/**
 * Places for the players a hand busted, per seat (null for the rest): the players who had chips at the start of the
 * hand count down from the last place, and more chips at the start of the hand, then the lower seat, places higher.
 */
export function bustPlaces(start: readonly number[], end: readonly number[]): (number | null)[] {
  const remaining = start.filter((x) => x > 0).length;
  const busted = start.flatMap((x, seat) => (x > 0 && end[seat] === 0 ? [seat] : [])).sort((a, b) => start[b]! - start[a]! || a - b);
  const places: (number | null)[] = start.map(() => null);
  busted.forEach((seat, k) => (places[seat] = remaining - busted.length + 1 + k));
  return places;
}

/**
 * Who knocked `seat` out of a finished hand: the winners of the last pot it could win (the side pot it lost, not the
 * main pot a shorter stack took), less itself.
 */
export function knockedOutBy(hand: HandState, seat: number): number[] {
  const pots = hand.events.flatMap((e) => (e.type === 'award' && e.eligible.includes(seat) ? [e] : []));
  return (pots.at(-1)?.winners ?? []).filter((w) => w !== seat);
}

/** Records the places a finished hand settles (once per hand). */
function afterHand(g: SitAndGo): SitAndGo {
  if (g.hand.street !== 'done') return g;
  const start = g.hand.seats.map((p) => p.start);
  const end = stacksOf(g);
  const busts = bustPlaces(start, end);
  const places = g.places.map((p, seat) => p ?? busts[seat] ?? null);
  const eliminations = [...g.eliminations];
  for (const seat of busts.map((_, seat) => seat).filter((seat) => busts[seat] !== null).sort((a, b) => busts[b]! - busts[a]!)) {
    eliminations.push({ seat, place: busts[seat]!, hand: g.handIndex + 1, by: knockedOutBy(g.hand, seat) });
  }
  const alive = end.flatMap((x, seat) => (x > 0 ? [seat] : []));
  const over = alive.length === 1;
  if (over) places[alive[0]!] = 1;
  return { ...g, places, eliminations, over };
}

function deal(g: Omit<SitAndGo, 'hand'>, stacks: readonly number[]): SitAndGo {
  const level = levelInfo(g.handIndex);
  // The whole deck, shuffled from the key's keystream for this hand (the engine's deck seed plays no part: 0).
  const deck = keyedShuffle(DECK, keyBytes(g.key), g.handIndex);
  const hand = newHand({ stacks, button: g.button, sb: level.sb, bb: level.bb, ante: level.ante, deckSeed: 0, deck, level });
  // A hand can end as it is dealt (blinds and antes putting everyone all-in).
  return afterHand({ ...g, hand });
}

export function newSitAndGo(o: { seats: number; key: string; startingStack?: number }): SitAndGo {
  const startingStack = o.startingStack ?? STARTING_STACK;
  if (!Number.isInteger(o.seats) || o.seats < 2 || o.seats > 4) throw new Error('a Sit & Go seats 2 to 4 players');
  const key = keyBytes(o.key); // throws for anything that is not a table key
  if (!Number.isInteger(startingStack) || startingStack < 1) throw new Error('the starting stack must be a whole number of chips');
  const button = new Keystream(key, 0, PURPOSE.button).below(o.seats);
  return deal({ key: o.key, startingStack, handIndex: 0, button, places: Array<null>(o.seats).fill(null), eliminations: [], over: false }, Array<number>(o.seats).fill(startingStack));
}

/** Plays an action in the hand in play; throws if it is not legal or the Sit & Go is over. */
export function actSitAndGo(g: SitAndGo, a: Action): SitAndGo {
  if (g.over) throw new Error('the Sit & Go is over');
  return afterHand({ ...g, hand: applyAction(g.hand, a) });
}

/** Deals the next hand, the button moved on; throws while a hand is still in play or when the Sit & Go is over. */
export function nextHand(g: SitAndGo): SitAndGo {
  if (g.over) throw new Error('the Sit & Go is over');
  if (g.hand.street !== 'done') throw new Error('the hand in play is not over');
  const stacks = stacksOf(g);
  const n = stacks.length;
  let button = g.button;
  do button = (button + 1) % n;
  while (stacks[button] === 0);
  return deal({ ...g, handIndex: g.handIndex + 1, button }, stacks);
}
