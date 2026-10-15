// Helpers for AI Hold'em's tests: hands dealt from a stacked deck, actions written short, and whole games played by
// stand-ins and recorded.
import { botDecide, fallbackKey, type BotName } from '../shared/bots';
import { DECK, parseCards, type Card } from '../shared/cards';
import { applyAction, dealOrder, newHand, observe, toAct, type Action, type HandEvent, type HandState, type Observation, type OptionKey } from '../shared/engine';
import type { Player, RecordedAction, Recording } from '../shared/recording';
import { keyFromSeed, mulberry32 } from '../shared/rng';
import { actSitAndGo, newSitAndGo, nextHand } from '../shared/sitngo';

export interface Setup {
  stacks: number[];
  button?: number;
  sb?: number;
  bb?: number;
  ante?: number;
  /** Hole cards by seat ('As Kd'); seats left out get cards nobody named. */
  holes?: Record<number, string>;
  /** Up to five board cards, flop first. */
  board?: string;
}

/** The deck that deals `holes` and `board` as named, in the engine's documented deal order. */
export function stackDeck(s: Setup): Card[] {
  const button = s.button ?? 0;
  const holes = Object.fromEntries(Object.entries(s.holes ?? {}).map(([seat, text]) => [seat, parseCards(text)]));
  const board = parseCards(s.board ?? '');
  const named = new Set([...Object.values(holes).flat(), ...board]);
  const spare = DECK.filter((c) => !named.has(c));
  const take = () => spare.shift()!;
  const order = dealOrder(s.stacks, button);
  const deck: Card[] = [];
  for (const round of [0, 1]) for (const seat of order) deck.push(holes[seat]?.[round] ?? take());
  for (let i = 0; i < 5; i++) deck.push(board[i] ?? take());
  return deck;
}

export const deal = (s: Setup): HandState => newHand({ stacks: s.stacks, button: s.button ?? 0, sb: s.sb ?? 10, bb: s.bb ?? 20, ante: s.ante ?? 0, deckSeed: 0, deck: stackDeck(s) });

/** Applies actions in turn: an option key, or a number for a raise to that street total. */
export function act(s: HandState, ...moves: (OptionKey | number)[]): HandState {
  for (const m of moves) {
    const a: Action = typeof m === 'number' ? { kind: 'raise', to: m } : { key: m };
    s = applyAction(s, a);
  }
  return s;
}

export const keys = (s: HandState, legal: (s: HandState) => { key: string }[]) => legal(s).map((o) => o.key);


/** How each kind of player decides here: bots as bots; a "model" at random, with the fallback now and then; a "human" at random, with slider raises. */
function decide(p: Player, o: Observation, coin: () => number): Omit<RecordedAction, 'seat'> {
  if (p.kind === 'bot') return { key: botDecide(p.id as BotName, o), by: 'bot' };
  if (p.kind === 'model') {
    if (coin() < 0.1) return { key: fallbackKey(o.options), by: 'fallback', latencyMs: 30_000 };
    const key = o.options[Math.floor(coin() * o.options.length)]!.key;
    return { key, by: 'answer', latencyMs: Math.round(coin() * 3000), say: 'Your move.', mood: 'smug', reasoning: 'Pot odds.', probabilities: { [key]: 0.7 } };
  }
  if (o.minRaiseTo !== null && coin() < 0.2) {
    const max = o.options.at(-1)!.to;
    return { to: o.minRaiseTo + Math.floor(coin() * (max - o.minRaiseTo + 1)), by: 'human' };
  }
  return { key: o.options[Math.floor(coin() * o.options.length)]!.key, by: 'human' };
}

const coinFrom = (seed: number) => {
  let s = seed;
  return () => {
    let r: number;
    [r, s] = mulberry32(s);
    return r;
  };
};

const step = (o: Omit<RecordedAction, 'seat'>) => ('to' in o && o.to !== undefined ? { kind: 'raise' as const, to: o.to } : { key: o.key! });

/** A whole Sit & Go, players[i] in seat i: its recording and every hand's events. */
export function playSitAndGo(players: Player[], seed: number, coinSeed = seed): { recording: Recording; events: HandEvent[][] } {
  const coin = coinFrom(coinSeed);
  const key = keyFromSeed(seed);
  let g = newSitAndGo({ seats: players.length, key });
  const hands: Recording['hands'] = [{ actions: [] }];
  const events: HandEvent[][] = [];
  for (;;) {
    if (toAct(g.hand) === null) {
      events.push(g.hand.events);
      if (g.over) break;
      g = nextHand(g);
      hands.push({ actions: [] });
      continue;
    }
    const seat = toAct(g.hand)!;
    const d = decide(players[seat]!, observe(g.hand, seat), coin);
    hands.at(-1)!.actions.push({ seat, ...d });
    g = actSitAndGo(g, step(d));
  }
  const chips = g.hand.seats.map((p) => p.stack);
  return { recording: { format: 1, game: 'holdem', mode: 'sitngo', players, sitngo: { key, startingStack: g.startingStack }, hands, result: { chips, places: g.places as number[] } }, events };
}

/** Duplicate cash hands: each deal played once per rotation of the players round the seats. */
export function playDuplicate(players: Player[], deals: number, seed: number): { recording: Recording; events: HandEvent[][] } {
  const coin = coinFrom(seed);
  const n = players.length;
  const cash = { stack: 200, sb: 1, bb: 2, ante: 0 };
  const hands: Recording['hands'] = [];
  const events: HandEvent[][] = [];
  const chips = players.map(() => 0);
  for (let d = 0; d < deals; d++) {
    for (let rot = 0; rot < n; rot++) {
      const seating = Array.from({ length: n }, (_, seat) => (seat + rot) % n);
      const deckSeed = seed * 1000 + d;
      const button = d % n;
      let s = newHand({ stacks: seating.map(() => cash.stack), button, sb: cash.sb, bb: cash.bb, ante: cash.ante, deckSeed });
      const actions: RecordedAction[] = [];
      while (toAct(s) !== null) {
        const seat = toAct(s)!;
        const dec = decide(players[seating[seat]!]!, observe(s, seat), coin);
        actions.push({ seat, ...dec });
        s = applyAction(s, step(dec));
      }
      s.seats.forEach((p, seat) => (chips[seating[seat]!]! += p.stack - p.start));
      hands.push({ deckSeed, button, seating, actions });
      events.push(s.events);
    }
  }
  return { recording: { format: 1, game: 'holdem', mode: 'cash', players, cash, hands, result: { chips } }, events };
}
