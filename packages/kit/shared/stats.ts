/**
 * The numbers every leaderboard shows, for any game: the mean, its standard error, and whether two means are too
 * close to call. Isomorphic, so the bench, the submissions check and a game's page rank the same way.
 */

export const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0);

/** The standard error of the mean (sample standard deviation over the square root of n); 0 below two values. */
export function stdError(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance / xs.length);
}

/** Rounds to `places` decimals. */
export const round = (n: number, places = 0): number => Math.round(n * 10 ** places) / 10 ** places;

/** What ranking needs from a row: its mean and the mean's standard error. */
export interface Measured {
  mean: number;
  stdError: number;
}

/** Whether two means are within the margin of error: about two standard errors of their difference. */
export const tooCloseToCall = (a: Measured, b: Measured): boolean => Math.abs(a.mean - b.mean) < 2 * Math.hypot(a.stdError, b.stdError);

/** Best first: by mean, highest or lowest first as the metric says. Stable, so equal means keep their order. */
export function sortBest<T>(rows: readonly T[], measure: (row: T) => Measured, higherIsBetter: boolean): T[] {
  return [...rows].sort((a, b) => (higherIsBetter ? measure(b).mean - measure(a).mean : measure(a).mean - measure(b).mean));
}

/**
 * The rows tied for first (rows best first): the leader, every row within the margin of error of it, and any row
 * between them. A 24-game run has a wider margin than a 100-game one, so it can tie the leader while a better mean
 * with a narrower margin doesn't; ranking that better mean below it would read wrong.
 */
export function jointLeaders<T>(rows: readonly T[], measure: (row: T) => Measured): T[] {
  let last = 0;
  rows.forEach((r, i) => {
    if (i > 0 && tooCloseToCall(measure(rows[0]!), measure(r))) last = i;
  });
  return last > 0 ? rows.slice(0, last + 1) : [];
}

/** Each row's rank label, rows best first: "=1" for the rows tied for first, else the position ("2", "3", ...). */
export function rankLabels<T>(rows: readonly T[], measure: (row: T) => Measured): string[] {
  const tied = new Set(jointLeaders(rows, measure));
  return rows.map((r, i) => (tied.has(r) ? '=1' : String(i + 1)));
}
