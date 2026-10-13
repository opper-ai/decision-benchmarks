import type { CommunityEntry, Entry, Leaderboard } from '../shared/contract.ts';
import type { GameDefinition, GameResult } from '../shared/game.ts';
import { mean, round, sortBest, stdError } from '../shared/stats.ts';

/**
 * A model's games as a leaderboard row in the hub's contract shape: the metric's mean, standard error and best game,
 * latency, fallback share and cost, and the game's own numbers in `extra`.
 */
export function entryFor<R extends GameResult>(game: Pick<GameDefinition<unknown, R>, 'metric' | 'summarize'>, model: string, name: string, results: R[], via: Entry['via']): Entry {
  const scores = results.map((r) => r.score);
  const sum = (f: (r: R) => number) => results.reduce((a, r) => a + f(r), 0);
  const calls = sum((r) => r.calls);
  const decisions = sum((r) => r.decisions);
  const cost = sum((r) => r.cost);
  const extra = game.summarize?.(results);
  return {
    model,
    name,
    games: results.length,
    metric: {
      mean: round(mean(scores), 3),
      stdError: round(stdError(scores), 3),
      best: scores.length ? (game.metric.higherIsBetter ? Math.max(...scores) : Math.min(...scores)) : 0,
    },
    meanLatencyMs: calls ? Math.round(sum((r) => r.latencyMsSum) / calls) : null,
    fallbackRate: decisions ? round(sum((r) => r.fallbacks) / decisions, 3) : 0,
    // No call reported a cost (an endpoint that sends none): unknown, not free.
    costPerGame: cost > 0 && results.length ? round(cost / results.length, 5) : null,
    via,
    ...(extra && Object.keys(extra).length ? { extra } : {}),
  };
}

/** Best first by the metric's mean. */
export const rankEntries = <E extends Entry>(entries: E[], higherIsBetter: boolean): E[] => sortBest(entries, (e) => e.metric, higherIsBetter);

/** leaderboard.json (or, with community entries, community.json) for a game. */
export function boardFor<E extends Entry | CommunityEntry>(game: Pick<GameDefinition, 'slug' | 'benchVersion' | 'metric'>, entries: E[], skipped: Leaderboard['skipped'] = [], now = new Date()): Leaderboard<E> {
  return { generatedAt: now.toISOString(), game: game.slug, benchVersion: game.benchVersion, metric: game.metric, entries: rankEntries(entries, game.metric.higherIsBetter), skipped };
}

/** Runs `n` jobs, at most `parallel` at a time, keeping their order. */
export async function playMany<T>(n: number, parallel: number, play: (i: number) => Promise<T>): Promise<T[]> {
  if (!Number.isInteger(parallel) || parallel < 1) throw new Error('--parallel must be a whole number of at least 1');
  const results: T[] = [];
  for (let i = 0; i < n; i += parallel) results.push(...(await Promise.all(Array.from({ length: Math.min(parallel, n - i) }, (_, j) => play(i + j)))));
  return results;
}
