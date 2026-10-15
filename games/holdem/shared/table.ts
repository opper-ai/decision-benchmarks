// The table as the page sees it, whoever runs it: the snapshot of a Sit & Go for one seat (or a spectator), one action
// played, a finished hand for the review, and the service's table API (POST api/table/*), whose answers carry exactly
// these. The page's drivers (src/driver.ts) and the service (server/table.ts) build them with the same functions, so
// the browser can't tell a LocalDriver's table from the server's except by who decides. Isomorphic and Node-safe.
//
// What a seat may see: its own hole cards and the cards a showdown shows (engine observe, visibleEvents), until the
// hand is over; then the finished hand, every card face up, goes to the review. A spectator (watch mode) sees every
// card at once (fullView). The table key (which deals every hand to come) is only in the recording once the game is over.
import { formatCard } from './cards.ts';
import { fullView, legalOptions, observe, visibleEvents, type HandEvent, type Option, type OptionKey, type TableView } from './engine.ts';
import type { By, FallbackReason, Mood, Player, RecordedAction, Recording } from './recording.ts';
import { stacksOf, type Elimination, type SitAndGo } from './sitngo.ts';

export type SeatKind = 'human' | 'model' | 'bot';

/** Who sits in a seat: the human (any id, e.g. 'you'), a model by its Opper id, or a bot by its name (bots.ts). */
export interface SeatConfig {
  kind: SeatKind;
  id: string;
}

/** What the human may do, when it is their turn. */
export interface HumanTurn {
  seat: number;
  /** The menu with amounts filled in, in menu order (engine legalOptions). */
  options: Option[];
  toCall: number;
  /** The slider's range as street totals, when a raise is open: min raise to all-in. Null when no raise is possible. */
  raise: { min: number; max: number } | null;
}

/** The table as one seat (or a spectator) may see it, plus where the Sit & Go stands. */
export interface TableSnapshot {
  /** Play: the human's seat. Watch: null (every card face up). */
  viewer: number | null;
  /**
   * The engine's view of the hand in play: the human's own cards and cards shown at a showdown (play), or every card
   * (watch; engine fullView).
   */
  view: TableView;
  /** Every event of the hand in play so far, as the viewer may see them (engine visibleEvents). Grows within a hand. */
  events: HandEvent[];
  /** The hand in play, from 1. */
  hand: number;
  /** Chips per seat at the start of the hand in play. */
  startStacks: number[];
  /** Finishing place per seat (1 wins), null while still playing. */
  places: (number | null)[];
  eliminations: Elimination[];
  /** The Sit & Go is over. */
  over: boolean;
  /** The human's options when it is their turn; null otherwise. */
  turn: HumanTurn | null;
  /** The time the seat to act has to decide, in ms (null for no limit: the human, a bot). */
  timeBankMs: number | null;
  /**
   * Play mode, once the viewer is out of the game (busted, or the game is over): they can never act again, so from the
   * hand that knocked them out on they watch as a spectator, every card face up (fullView, every event) and the
   * models' reasoning with each step, as in watch mode. `viewer` stays their seat. Absent otherwise.
   */
  spectating?: true;
}

/** What came with an action besides the move itself. */
export interface ActionMeta {
  by: By;
  /** A fallback: why the model's move fell back (no answer in time, a failed call, an invalid answer, a refusal). */
  why?: FallbackReason;
  /** A chat model's table talk. */
  say?: string;
  /** A chat model's face. */
  mood?: Mood;
  /** A decision model's probabilities over its options: the tell meter. */
  probabilities?: Partial<Record<OptionKey, number>>;
  /** A chat model's reasoning: watch mode only (every card is face up there). In play it waits for the review. */
  reasoning?: string;
  latencyMs: number;
  /** What the model call cost, in USD, when the model was asked and Opper said. */
  costUsd?: number;
}

/** One action played, and the table after it. */
export interface StepResult {
  seat: number;
  /** The menu key played, or null for a raise to an amount of one's own (the human's slider). */
  key: OptionKey | null;
  meta: ActionMeta;
  snapshot: TableSnapshot;
}

/** A finished hand, everything face up. */
export interface ReviewHand {
  /** From 1. */
  hand: number;
  /** The engine's events, every hole card included. */
  events: HandEvent[];
  /** The actions in order with their metadata (one per 'action' event). */
  actions: RecordedAction[];
  /** The five board cards the deck held, dealt or not ('As'), so a review can tell who would have won. */
  runout: string[];
}

export interface Review {
  players: Player[];
  hands: ReviewHand[];
  /** The whole game as a recording (with its table key), once the Sit & Go is over; null before. */
  recording: Recording | null;
}

/**
 * The table as `viewer` may see it (null: a spectator, every card face up), with the time bank of the seat to act.
 * Play: the viewer's own cards and the cards a showdown showed, never another's; the human's options when it is their turn.
 */
export function snapshotOf(g: SitAndGo, viewer: number | null, timeBankOf: (seat: number) => number | null): TableSnapshot {
  const s = g.hand;
  // Out of the game (busted, or the game is over): the player can never act again, so they watch with every card up.
  const spectating = viewer !== null && g.places[viewer] !== null;
  let view: TableView;
  if (viewer === null || spectating) view = fullView(s);
  else {
    const { seat: _seat, position: _position, holeCards: _hole, toCall: _toCall, minRaiseTo: _min, options: _options, ...rest } = observe(s, viewer);
    view = rest;
  }
  let turn: HumanTurn | null = null;
  if (viewer !== null && !spectating && s.toAct === viewer) {
    const o = observe(s, viewer);
    const p = s.seats[viewer]!;
    turn = { seat: viewer, options: legalOptions(s), toCall: o.toCall, raise: o.minRaiseTo === null ? null : { min: o.minRaiseTo, max: p.bet + p.stack } };
  }
  return {
    viewer,
    view,
    events: viewer === null || spectating ? structuredClone(s.events) : visibleEvents(s.events, viewer),
    hand: g.handIndex + 1,
    startStacks: s.seats.map((p) => p.start),
    places: [...g.places],
    eliminations: structuredClone(g.eliminations),
    over: g.over,
    turn,
    timeBankMs: s.toAct === null ? null : timeBankOf(s.toAct),
    ...(spectating ? { spectating: true } : {}),
  };
}

/** The hand in play, once it is over, for the review: every event (every hole card), its actions and the board's run-out. */
export function finishedHandOf(g: SitAndGo, actions: readonly RecordedAction[]): ReviewHand {
  const s = g.hand;
  if (s.street !== 'done') throw new Error('the hand in play is not over');
  const live = s.seats.filter((p) => p.status !== 'empty').length;
  return { hand: g.handIndex + 1, events: structuredClone(s.events), actions: structuredClone([...actions]), runout: s.deck.slice(2 * live, 2 * live + 5).map(formatCard) };
}

/** The whole Sit & Go as a recording, with its table key: only once it is over (the key deals every hand to come). */
export function recordingOf(g: SitAndGo, players: readonly Player[], hands: readonly (readonly RecordedAction[])[]): Recording {
  if (!g.over) throw new Error('the Sit & Go is not over');
  return {
    format: 1,
    game: 'holdem',
    mode: 'sitngo',
    players: players.map((p) => ({ kind: p.kind, id: p.id })),
    sitngo: { key: g.key, startingStack: g.startingStack },
    hands: hands.map((actions) => ({ actions: structuredClone([...actions]) })),
    result: { chips: stacksOf(g), places: g.places as number[] },
  };
}

// ---------- the service's table API (POST api/table/*): what goes in and what comes back ----------

/** POST api/table/start: the seats in order (2 to 4; play: one human, watch: none). The server picks the table key. */
export interface StartRequest {
  seats: { kind: 'human' | 'model'; id: string }[];
  mode: 'play' | 'watch';
}

/** start and next: the table to come, sealed in `token`, and the hand that just finished (if it ended as it was dealt). */
export interface SnapshotReply {
  token: string;
  snapshot: TableSnapshot;
  finished?: ReviewHand;
}

/** step and act: one action played, and the hand it finished (if it did), every card face up. */
export interface StepReply {
  token: string;
  result: StepResult;
  finished?: ReviewHand;
}

/** An error: what went wrong, and what the page should do about it. */
export interface TableErrorBody {
  error: string;
  /** 401: sign in (the chat models play on the player's own credits, or the free credits need it). */
  signedOut?: boolean;
  /** 402 / 429: the free credits are spent or busy. */
  poolEmpty?: boolean;
  /** 402: the player's Opper wallet is empty. */
  walletUrl?: string;
}
