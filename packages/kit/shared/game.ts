/**
 * What a game gives the kit (docs/design.md, "What a game gives the kit"). A game folder exports a GameDefinition from
 * games/<slug>/game.ts (the bench and the submissions check use it) and a GameServer from games/<slug>/game.server.ts
 * (the service uses it, so it imports Node-safe, erasable TypeScript only).
 */
import type { ChatFormat, ChatModel } from './chat.ts';
import type { Entry, Metric } from './contract.ts';
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
    /** A chat model's question (its decision and its call), when chat models get longer than decision models (default callTimeoutMs). */
    chatTimeoutMs?: number;
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
  /**
   * Plays one game through `transport` (already bound to the model) and returns its result and recording. `via` says
   * how the model is reached: a game that gives chat models more time (timing.chatTimeoutMs) reads it.
   */
  play(o: { transport: Transport; seed: number; signal: AbortSignal; model: string; via?: Entry['via'] }): Promise<{ result: R; recording: Rec }>;
  /** Replays a recording with our code and recomputes its result; anything it cannot replay exactly is refused. */
  verify(rec: unknown, o: { seed: number }): Verdict<R>;
  /** Game-specific numbers for a model's results, shown as the leaderboard entry's `extra`. */
  summarize?(results: R[]): Record<string, number | string>;
  /**
   * Free players for reference, by name: the bench plays one with `--model baseline/<name>`, without a key, a warm-up or
   * a network call. Their results go to a file of their own (a game's baselines.json), never to the official leaderboard.
   */
  baselines?: Record<string, Baseline>;
  /**
   * Chat models the official runs play besides the decision models, through Opper's OpenAI-compatible chat endpoint
   * (`--model <id>`; `--models all` plays them after the decision models, `--models chat` them alone). Their rows say "chat-adapter".
   */
  chatModels?: readonly ChatModel[];
  /** How the game asks a chat model (its own models, and a submitter's `--format chat` endpoint); else the kit's choice-and-probabilities format. */
  chat?: ChatFormat;
}

/**
 * A scripted player for reference. With `transport` it answers the game's questions itself, through the same transport
 * a model would. Without one the game plays it: `play` gets `model: 'baseline/<name>'` and a transport that throws if
 * ever called (for baselines that read the full game state rather than the questions).
 */
export interface Baseline {
  name: string;
  transport?(): Transport;
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

/** Who pays for a model call a game's own API makes (GameApiCall.payer). */
export interface ApiPayer {
  /** player: the signed-in player's key; pool: the free credits (signed out); dev: the server's local key. */
  mode: 'player' | 'pool' | 'dev';
  provider: 'opper' | 'typesafe';
  apiKey: string;
  baseUrl: string;
  /** Opper only: the project an organization key calls for (X-Opper-Project). */
  project?: string;
}

export interface GameApiResponse {
  status: number;
  /** Sent as JSON. */
  body: unknown;
  headers?: Record<string, string>;
  /** Opper refused the player's key (their sign-in expired): the session cookie is cleared with the answer. */
  clearSession?: boolean;
}

/** One request to a game's own API route, and what the kit lends the route to answer it. */
export interface GameApiCall {
  /** The request's JSON body. */
  body: unknown;
  /**
   * The client's IP address as the free credits' limits count it (the connection's, or behind TRUSTED_PROXIES the hop
   * the first trusted proxy saw), for a game's own per-visitor limits: VisitorLimits.take(call.visitor).
   */
  visitor: string;
  /**
   * Who would pay for a model call now, as /api/decide picks it: the signed-in player, else the free credits while they
   * are open (unless `pool` is false, for models they don't pay for), else the server's local key; null when nobody.
   */
  payer(o?: { pool?: boolean }): ApiPayer | null;
  /** The answer when nobody can pay: 402 when the free credits could have paid but are spent, else 401 sign in. */
  unpaid(o?: { pool?: boolean; error?: string }): GameApiResponse;
  /** For a call the free credits pay: one request from the visitor's allowance, or the 429 to answer when it is spent. */
  takePool(): GameApiResponse | null;
  /** A call the free credits paid: its cost, and whether Opper refused it for money (the credits are spent). */
  poolSpent(costUsd: number | null, exhausted?: boolean): void;
  /** Seals a value for one of the game's purposes (AES-256-GCM, key HMAC(SESSION_SECRET, "decision-benchmarks:<slug>-<purpose>")). */
  seal(purpose: string, value: unknown): string;
  /** A value sealed for that purpose, or null for anything tampered, malformed or sealed for another. */
  open(purpose: string, token: unknown): unknown;
  fetch: typeof fetch;
  log(line: string): void;
  /** Aborted when the client goes away before the answer, so a model call in flight can be cancelled. */
  signal: AbortSignal;
}

/**
 * A game's own API, for a game whose server does more than check and forward one question (AI Hold'em deals the cards
 * and asks the models itself). The kit mounts each route below the game's path next to its own, refuses what needs no
 * body (anything but POST, cross-site, not JSON), reads the body up to `maxBodyBytes` and parses it.
 */
export interface GameApi {
  /** Path below the game's own, starting /api/ (not one of the kit's: /api/me, decide, warm, highscores, seed), to route. */
  routes: Readonly<Record<string, (call: GameApiCall) => Promise<GameApiResponse>>>;
  /** Largest body read (default 256 KB). */
  maxBodyBytes?: number;
}

export interface GameServer {
  slug: string;
  /** Required: the pool only pays for requests this game sends. Rebuild or strictly validate the request. */
  decideRequest(body: unknown): DecideRequestVerdict;
  /**
   * The Opper ids this game plays (what its requests carry upstream). When set, /api/warm and /api/decide refuse any
   * other model with 400 before calling upstream, so the pool never pays for a model the game does not use. A request
   * without a model plays the kit's default, which must then be listed.
   */
  models?: readonly string[];
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
  /** The game's own API routes, when it has any. */
  api?: GameApi;
}
