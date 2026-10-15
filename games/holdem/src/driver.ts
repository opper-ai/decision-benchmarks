// The table the page talks to. The page never runs the engine itself: it asks a TableDriver for snapshots and plays
// them. RemoteDriver (remote-driver.ts) is the service's table (POST api/table/*), where the server deals and asks the
// models, and the AIs' hole cards never reach the browser until a showdown or the hand is over (review). LocalDriver
// (local-driver.ts) runs the engine in the browser with bots standing in for the AI seats (tests, ?practice), and
// ReplayDriver plays a recording back. The snapshot and step types live in shared/table.ts, which the service builds too.
//
// Everything is async because real models take seconds. One AI action per step(), so the page animates each action as
// it arrives.
import type { Action } from '../shared/engine.ts';
import type { Review, SeatConfig, StepResult, TableSnapshot } from '../shared/table.ts';

export type { ActionMeta, HumanTurn, Review, ReviewHand, SeatConfig, SeatKind, StepResult, TableSnapshot } from '../shared/table.ts';

export interface TableConfig {
  /**
   * 2 to 6 seats (shared/sitngo.ts MIN_SEATS to MAX_SEATS, 4 by default: DEFAULT_SEATS), seat 0 first. Play mode has
   * exactly one human seat; watch mode has none.
   */
  seats: SeatConfig[];
  /** The table key (rng.ts) that deals the Sit & Go; the driver picks a random one when left out (the service always does). */
  key?: string;
  /** Tests and practice: a small seed the key is made from (keyFromSeed), and the stand-ins' coins. */
  seed?: number;
}

export interface TableDriver {
  /** Seats the players and deals the first hand. */
  start(config: TableConfig): Promise<TableSnapshot>;
  /** The human's action; rejects when it is not their turn or the action is not legal. */
  act(action: Action): Promise<StepResult>;
  /** Plays one AI action (the seat to act must be an AI); rejects when it is the human's turn or the hand is over. */
  step(signal?: AbortSignal): Promise<StepResult>;
  /** Deals the next hand once the hand in play is over; rejects while it runs or when the Sit & Go is over. */
  nextHand(): Promise<TableSnapshot>;
  /**
   * The finished hands so far with every hole card and every action's metadata, AI reasoning included, for the hand
   * review. Never the hand in play, and never the seed (it deals the hands to come).
   */
  review(): Promise<Review>;
}
