import type { Community as ContractCommunity, Leaderboard as ContractBoard } from '../../../packages/kit/shared/contract.ts';
import type { GameResult as KitGameResult } from '../../../packages/kit/shared/game.ts';
import { jointLeaders as kitJointLeaders, stdError, tooCloseToCall as kitTooCloseToCall } from '../../../packages/kit/shared/stats.ts';
import { fromOpperId, modelName } from './models.ts';

/**
 * Pac-Man's results as its page shows them: jevman's leaderboard shape. The files it serves are in the kit's contract
 * shape (packages/kit/shared/contract.ts), which `fromContract` turns into this.
 */

/** One benchmark game, as the bench plays it (games/pacman/bench/play.ts). */
export interface GameResult extends KitGameResult {
  survived: number;
  pellets: number;
  deaths: number;
  level: number;
  fruitSpawned: number;
  fruitEaten: number;
  ghostsEaten: number;
  deathsBy: Record<string, number>;
}

/**
 * Bump when the game rules or the question the models get change: results from another version are not comparable,
 * and submissions recorded on it are refused. tests/bench-version.test.ts fails when either changes.
 */
export const BENCH_VERSION = 1;

export interface LeaderboardEntry {
  /** A model id from shared/models.ts, or a submitted model's own id. */
  model: string;
  name: string;
  games: number;
  meanScore: number;
  /** The best single game: not what the ranking uses (one game is mostly luck), but the high score to beat. */
  bestScore?: number;
  /** Standard error of the mean score: about two of these either way is the margin of error. */
  scoreStdError?: number;
  meanSurvivedSeconds: number;
  meanPellets: number;
  pelletsPerLife: number;
  meanGhostsEaten: number;
  fruitEaten: string;
  bestLevel: number;
  /** Share of decisions the greedy rule made because the model did not answer in time (or at all). */
  fallbackRate: number;
  meanLatencyMs: number | null;
  costPerGame: number;
  deathsBy: Record<string, number>;
}

export interface Leaderboard {
  generatedAt: string;
  settings: { gamesPerModel: number; maxSeconds: number; /** Missing in results from before versioning (version 1). */ benchVersion?: number; /** Only in results from before the game's safety check was removed. */ safetyCheck?: boolean; ghosts: 'scripted' };
  /** Best first: by mean score. */
  entries: LeaderboardEntry[];
  /** Models that could not play (not warm in time, not enabled for the key, ...). */
  skipped: { model: string; reason: string }[];
}

const round = (n: number, places = 0) => Math.round(n * 10 ** places) / 10 ** places;

export function summarize(model: string, games: GameResult[], name: string = modelName(model)): LeaderboardEntry {
  const mean = (f: (g: GameResult) => number) => (games.length ? games.reduce((a, g) => a + f(g), 0) / games.length : 0);
  const sum = (f: (g: GameResult) => number) => games.reduce((a, g) => a + f(g), 0);
  const deathsBy: Record<string, number> = {};
  for (const g of games) for (const [k, v] of Object.entries(g.deathsBy)) deathsBy[k] = (deathsBy[k] ?? 0) + v;
  const calls = sum((g) => g.calls);
  const decisions = sum((g) => g.decisions);
  return {
    model,
    name,
    games: games.length,
    meanScore: round(mean((g) => g.score)),
    bestScore: Math.max(0, ...games.map((g) => g.score)),
    scoreStdError: round(stdError(games.map((g) => g.score))),
    meanSurvivedSeconds: round(mean((g) => g.survived), 1),
    meanPellets: round(mean((g) => g.pellets)),
    pelletsPerLife: round(sum((g) => g.pellets) / Math.max(1, sum((g) => g.deaths))),
    meanGhostsEaten: round(mean((g) => g.ghostsEaten), 1),
    fruitEaten: `${sum((g) => g.fruitEaten)}/${sum((g) => g.fruitSpawned)}`,
    bestLevel: Math.max(1, ...games.map((g) => g.level)),
    fallbackRate: decisions ? round(sum((g) => g.fallbacks) / decisions, 3) : 0,
    meanLatencyMs: calls ? round(sum((g) => g.latencyMsSum) / calls) : null,
    costPerGame: round(mean((g) => g.cost), 5),
    deathsBy,
  };
}

/** Whether two models' mean scores are within the margin of error (the kit's rule; no margin, no tie). */
export function tooCloseToCall(a: LeaderboardEntry, b: LeaderboardEntry): boolean {
  if (a.scoreStdError === undefined || b.scoreStdError === undefined) return false;
  return kitTooCloseToCall({ mean: a.meanScore, stdError: a.scoreStdError }, { mean: b.meanScore, stdError: b.scoreStdError });
}

/** The models tied for first (entries best first), by the kit's rule; an entry without a margin ties nobody. */
export const jointLeaders = (entries: LeaderboardEntry[]): LeaderboardEntry[] => kitJointLeaders(entries, (e) => ({ mean: e.meanScore, stdError: e.scoreStdError ?? Number.NaN }));

export const rank = (entries: LeaderboardEntry[]): LeaderboardEntry[] => [...entries].sort((a, b) => b.meanScore - a.meanScore);

/** A model its makers benchmarked themselves and submitted by pull request (games/pacman/submissions/<id>/). */
export interface CommunityEntry extends LeaderboardEntry {
  /** Who submitted it (GitHub handle or organisation). */
  by: string;
  /** Where to learn more about the model. */
  url?: string;
  /**
   * Always true. The games were replayed and their scores checked, but the moves, latency, cost and choice of games
   * are as reported by the submitter.
   */
  selfReported: true;
}

export interface Community {
  generatedAt: string;
  benchVersion: number;
  /** Best first: by mean score. */
  entries: CommunityEntry[];
}

/** The rules every submission (and our own leaderboard run) follows. */
export interface SubmissionRules {
  minGames: number;
  /** Each game ends at game over or after this many seconds of play. */
  maxSeconds: number;
  /** The longest simulation step the bench takes (it caps a slow frame at 50 ms). */
  maxStep: number;
}
export const SUBMISSION_RULES: SubmissionRules = { minGames: 24, maxSeconds: 300, maxStep: 0.05 };

/** Pac-Man's own numbers for a model's games, as the leaderboard entry's `extra` (the kit's contract shape). */
export function extraFor(games: GameResult[]): Record<string, number | string> {
  const e = summarize('', games, '');
  return { meanSurvivedSeconds: e.meanSurvivedSeconds, meanPellets: e.meanPellets, pelletsPerLife: e.pelletsPerLife, meanGhostsEaten: e.meanGhostsEaten, fruitEaten: e.fruitEaten, bestLevel: e.bestLevel };
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** A results file in the kit's contract shape, as this page shows it. Models are named by the game's own ids. */
export function fromContract(board: ContractBoard): Leaderboard {
  const entries = board.entries.map((e): LeaderboardEntry => ({
    model: fromOpperId(e.model),
    name: e.name,
    games: e.games,
    meanScore: Math.round(e.metric.mean),
    bestScore: e.metric.best,
    scoreStdError: e.metric.stdError,
    meanSurvivedSeconds: num(e.extra?.meanSurvivedSeconds),
    meanPellets: num(e.extra?.meanPellets),
    pelletsPerLife: num(e.extra?.pelletsPerLife),
    meanGhostsEaten: num(e.extra?.meanGhostsEaten),
    fruitEaten: typeof e.extra?.fruitEaten === 'string' ? e.extra.fruitEaten : '0/0',
    bestLevel: num(e.extra?.bestLevel, 1),
    fallbackRate: e.fallbackRate,
    meanLatencyMs: e.meanLatencyMs,
    costPerGame: e.costPerGame ?? 0,
    deathsBy: {},
  }));
  return {
    generatedAt: board.generatedAt,
    settings: { gamesPerModel: Math.max(0, ...entries.map((e) => e.games)), maxSeconds: SUBMISSION_RULES.maxSeconds, benchVersion: board.benchVersion, ghosts: 'scripted' },
    entries,
    skipped: board.skipped,
  };
}

/** community.json in the kit's contract shape, as this page shows it. */
export function communityFromContract(board: ContractCommunity): Community {
  const base = fromContract(board);
  return {
    generatedAt: board.generatedAt,
    benchVersion: board.benchVersion,
    entries: base.entries.map((e, i) => {
      const c = board.entries[i]!;
      return { ...e, model: c.model, by: c.by, ...(c.url ? { url: c.url } : {}), selfReported: true as const };
    }),
  };
}
