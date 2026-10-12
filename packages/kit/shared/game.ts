/**
 * What a game gives the kit (docs/design.md, "What a game gives the kit"). A game folder exports a GameDefinition from
 * games/<slug>/game.ts (the bench and the submissions check use it) and a GameServer from games/<slug>/game.server.ts
 * (the service uses it, so it imports Node-safe, erasable TypeScript only).
 */
import type { Metric } from './contract.ts';
import type { SystemOneRequest, Transport } from './systemone.ts';

/** What every benchmark game reports; a game's own result type adds its own numbers. */
export interface GameResult {
  /** The game's metric for this game (apples, points, a win share). */
  score: number;
  /** Model calls made, and what they cost and took. */
  calls: number;
  latencyMsSum: number;
  cost: number;
  /** Decisions the game needed, and how many its fallback made because the model did not answer in time. */
  decisions: number;
  fallbacks: number;
}

/**
 * A recorded game replayed with our code: its result, and a fingerprint of the game played (not of the file), so the
 * same game sent twice is caught however its timings were changed.
 */
export type Verdict<R> = { ok: true; result: R; fingerprint: string } | { ok: false; error: string };

export interface GameDefinition<Rec = unknown, R extends GameResult = GameResult> {
  slug: string;
  /** Bump when the rules or the questions change: results from another version are not comparable, so older submissions are refused. */
  benchVersion: number;
  /** Real time (the game runs on and the model must keep up) or paused (the game waits for each answer). */
  mode: 'realtime' | 'paused';
  timing: {
    /** How long a question may stay unanswered before the fallback decides. */
    decisionTimeoutMs: number;
    /** How long one model call may take before the bench gives up on it. */
    callTimeoutMs: number;
    /** Calls in flight at once, per game. */
    maxInFlight: number;
  };
  rules: {
    /** Games a submission needs at least. */
    minGames: number;
    /** Games an official run plays per model. */
    officialGames: number;
    /** The seed of game i (from 0): official runs and submissions play these, so every model faces the same games. */
    seedFor(i: number): number;
    /** Largest gzipped recording a submission may hold (unpacked, at most eight times this). */
    maxRecordingBytes: number;
  };
  metric: Metric;
  /** Plays one game through `transport` (already bound to the model) and returns its result and recording. */
  play(o: { transport: Transport; seed: number; signal: AbortSignal; model: string }): Promise<{ result: R; recording: Rec }>;
  /** Replays a recording with our code and recomputes its result; anything it cannot replay exactly is refused. */
  verify(rec: unknown, o: { seed: number }): Verdict<R>;
  /** Game-specific numbers for a model's results, shown as the leaderboard entry's `extra`. */
  summarize?(results: R[]): Record<string, number | string>;
  /**
   * Free players for reference, by name: the bench plays one with `--model baseline/<name>`, without a key or a network
   * call. Their results go to a file of their own (a game's baselines.json), never to the official leaderboard.
   */
  baselines?: Record<string, Baseline>;
}

/** A scripted player that answers the game's questions itself, through the same transport a model would. */
export interface Baseline {
  name: string;
  transport(): Transport;
}

/** The model id a baseline plays under: `baseline/<name>`. */
export const BASELINE_PREFIX = 'baseline/';

/** Checks a server signature on an answer message (the server passes one with the game's key; tests pass a stand-in). */
export type AnswerVerifier = (message: string, sig: string) => boolean;

export type DecideRequestVerdict =
  | {
      ok: true;
      /** The request to send upstream: rebuilt or strictly checked, so the pool only pays for what this game asks. */
      request: SystemOneRequest;
      /** Question name to question key, for signing each answer (at most one per question). */
      keys?: Record<string, string>;
      /**
       * The game's own name for the model, when it differs from the Opper id in `request.model`: the response names
       * the model this way and the answers are signed as it, so a game keeps the ids its recordings use.
       */
      as?: string;
    }
  | { ok: false; error: string };

export interface HighScoreBoard {
  id: string;
  label: string;
}

export type HighScoreCheck = { ok: true; score: number; board: string } | { ok: false; error: string };

/**
 * Checks a seed token the server issued (GET <game>/api/seed): the seed it stands for and how long ago it was issued,
 * or null when the token is not the server's or has expired. A game whose high scores play on issued seeds checks the
 * token in the recording, so a player cannot pick a seed they like.
 */
export type SeedVerifier = (token: unknown) => { seed: number; ageMs: number } | null;

export interface GameServer {
  slug: string;
  /** Required: the pool only pays for requests this game sends. Rebuild or strictly validate the request. */
  decideRequest(body: unknown): DecideRequestVerdict;
  highScores?: {
    /** Order matters: the hub shows the first board's top score. */
    boards: readonly HighScoreBoard[];
    /** True when a player's game starts from a seed the server issues: the service then answers GET /api/seed. */
    seeded?: boolean;
    /**
     * Replays a player's game for its score and board; signed model answers are checked with `verify`, and a seed
     * token the server issued with `seeds`.
     */
    check(rec: unknown, verify: AnswerVerifier, seeds: SeedVerifier): HighScoreCheck;
  };
}
