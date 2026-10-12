import { confidenceOf } from './adapter.ts';
import type { Side } from './engine/engine.ts';
import type { MoveId } from './engine/moves.ts';
import { won, type Decision, type FallbackReason, type Outcome, type Replay } from './replay.ts';

export interface MoveStats {
  uses: number;
  outcomes: Partial<Record<Outcome, number>>;
  dealt: number;
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  n: number;
  meanConfidence: number;
  winRate: number;
}

export interface FighterStats {
  model: string;
  label: string;
  result: 'win' | 'loss' | 'draw';
  roundsWon: number;
  dealt: number;
  taken: number;
  decisions: number;
  fallbacks: Record<FallbackReason, number>;
  fallbackRate: number;
  latency: { p50: number; p95: number; max: number; mean: number };
  /** Decisions whose answer arrived after the fighter was already free to act. */
  late: number;
  /** Ticks spent free but waiting for an answer. */
  waitTicks: number;
  cancellations: number;
  costUsd: number;
  inputTokens: number;
  moves: Partial<Record<MoveId, MoveStats>>;
  outcomes: Partial<Record<Outcome, number>>;
  /**
   * Brier score of the chosen move's confidence against winning the exchange, and its skill against
   * the model's own base rate (1 = perfect, 0 = no better than always predicting its average win rate,
   * negative = worse). Skill is what is comparable across models.
   */
  calibration: { bins: CalibrationBin[]; brier: number | null; skill: number | null; n: number; uncalibrated: number };
}

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const k = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[k];
}

/** Reliability of the chosen move's confidence against whether the exchange was won. */
export function calibration(ds: Decision[], bins = 10): FighterStats['calibration'] {
  const pts: { c: number; w: number }[] = [];
  let uncalibrated = 0;
  for (const d of ds) {
    if (d.fallback || !d.answer) continue;
    const w = won(d);
    if (w === null) continue;
    const c = confidenceOf(d.answer);
    if (c === null) {
      uncalibrated++;
      continue;
    }
    pts.push({ c, w: w ? 1 : 0 });
  }
  const out: CalibrationBin[] = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const inBin = pts.filter((p) => p.c >= lo && (b === bins - 1 ? p.c <= hi : p.c < hi));
    out.push({
      lo,
      hi,
      n: inBin.length,
      meanConfidence: inBin.length ? inBin.reduce((s, p) => s + p.c, 0) / inBin.length : 0,
      winRate: inBin.length ? inBin.reduce((s, p) => s + p.w, 0) / inBin.length : 0,
    });
  }
  const brier = pts.length ? pts.reduce((s, p) => s + (p.c - p.w) ** 2, 0) / pts.length : null;
  const base = pts.length ? pts.reduce((s, p) => s + p.w, 0) / pts.length : 0;
  const ref = base * (1 - base);
  const skill = brier !== null && ref > 0 ? 1 - brier / ref : null;
  return { bins: out, brier, skill, n: pts.length, uncalibrated };
}

export function fighterStats(r: Replay, side: Side): FighterStats {
  const ds = r.decisions.filter((d) => d.fighter === side);
  const fallbacks: Record<FallbackReason, number> = { timeout: 0, error: 0, invalid: 0, illegal: 0 };
  const moves: Partial<Record<MoveId, MoveStats>> = {};
  const outcomes: Partial<Record<Outcome, number>> = {};
  let dealt = 0;
  let taken = 0;
  let late = 0;
  let waitTicks = 0;
  let costUsd = 0;
  let inputTokens = 0;
  for (const d of ds) {
    if (d.fallback) fallbacks[d.fallback]++;
    const m = (moves[d.move] ??= { uses: 0, outcomes: {}, dealt: 0 });
    m.uses++;
    if (d.outcome) {
      m.outcomes[d.outcome] = (m.outcomes[d.outcome] ?? 0) + 1;
      outcomes[d.outcome] = (outcomes[d.outcome] ?? 0) + 1;
    }
    m.dealt += d.dealt ?? 0;
    dealt += d.dealt ?? 0;
    taken += d.taken ?? 0;
    const wait = Math.max(0, d.appliedTick - d.questionTick);
    if (wait > 0) late++;
    waitTicks += wait;
    costUsd += d.answer?.costUsd ?? 0;
    inputTokens += d.answer?.inputTokens ?? 0;
  }
  const lats = ds.filter((d) => d.answer).map((d) => d.latencyMs);
  const roundsWon = r.result.rounds.filter((x) => x.winner === side).length;
  return {
    model: r.fighters[side].model,
    label: r.fighters[side].label,
    result: r.result.winner === null ? 'draw' : r.result.winner === side ? 'win' : 'loss',
    roundsWon,
    dealt,
    taken,
    decisions: ds.length,
    fallbacks,
    fallbackRate: ds.length ? Object.values(fallbacks).reduce((a, b) => a + b, 0) / ds.length : 0,
    latency: {
      p50: percentile(lats, 50),
      p95: percentile(lats, 95),
      max: lats.length ? Math.max(...lats) : 0,
      mean: lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : 0,
    },
    late,
    waitTicks,
    cancellations: r.cancellations.filter((c) => c.fighter === side).length,
    costUsd,
    inputTokens,
    moves,
    outcomes,
    calibration: calibration(ds),
  };
}

export const matchStats = (r: Replay): [FighterStats, FighterStats] => [fighterStats(r, 0), fighterStats(r, 1)];

/** Official: our own runs (bench, samples, admin uploads). Community: saved from the site, unchecked. */
export type Source = 'official' | 'community';

export interface MatchSummary {
  id: string;
  /** Absent in summaries from before sources existed: see sourceOf. */
  source?: Source;
  mode: Replay['mode'];
  track?: 'assisted' | 'raw';
  engineVersion?: string;
  left: string;
  right: string;
  winner: Side | null;
  createdAt: string;
  stats: [FighterStats, FighterStats];
  /** Older summaries: saved from the site without a sign-in, or with a custom endpoint. */
  unverified?: boolean;
}

/** Older summaries had no source: the unverified ones were the site's. */
export const sourceOf = (s: Pick<MatchSummary, 'source' | 'unverified'>): Source => s.source ?? (s.unverified ? 'community' : 'official');

/** Fewer matches than this and a rating is provisional. */
export const PROVISIONAL_BELOW = 6;

export interface LeaderboardRow {
  model: string;
  label: string;
  /** Bradley-Terry strength on an Elo-like scale (1500 = the pool's average). */
  rating: number;
  /** Bootstrap 95% interval of the rating. */
  ci: [number, number];
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  p50LatencyMs: number;
  fallbackRate: number;
  costPerMatch: number;
}

export interface Leaderboard {
  rows: LeaderboardRow[];
  /** score[a][b] = a's points against b (win 1, draw 0.5) and games played. */
  matrix: Record<string, Record<string, { points: number; games: number }>>;
}

type Game = { left: string; right: string; winner: Side | null };

/**
 * Bradley-Terry strengths by the MM algorithm, iterated to convergence. Every player also gets one
 * draw against a virtual player (a weak prior), so undefeated and winless players stay finite. Ratings
 * are on an Elo-like scale centred so the pool's average is 1500.
 */
export function bradleyTerry(games: Game[], players: string[], maxIters = 5000): Map<string, number> {
  const idx = new Map(players.map((p, k) => [p, k]));
  const n = players.length;
  const wins = new Float64Array(n + 1);
  const pairs: { a: number; b: number; n: number }[] = [];
  const pairMap = new Map<string, { a: number; b: number; n: number }>();
  const add = (a: number, b: number, sa: number) => {
    wins[a] += sa;
    wins[b] += 1 - sa;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    let pr = pairMap.get(key);
    if (!pr) {
      pr = { a: Math.min(a, b), b: Math.max(a, b), n: 0 };
      pairMap.set(key, pr);
      pairs.push(pr);
    }
    pr.n++;
  };
  for (const g of games) add(idx.get(g.left)!, idx.get(g.right)!, g.winner === null ? 0.5 : g.winner === 0 ? 1 : 0);
  // The virtual average player (index n, strength fixed at 1).
  for (let k = 0; k < n; k++) add(k, n, 0.5);
  const p = new Float64Array(n + 1).fill(1);
  for (let it = 0; it < maxIters; it++) {
    const denom = new Float64Array(n + 1);
    for (const pr of pairs) {
      const d = pr.n / (p[pr.a] + p[pr.b]);
      denom[pr.a] += d;
      denom[pr.b] += d;
    }
    let change = 0;
    for (let k = 0; k < n; k++) {
      const next = denom[k] > 0 ? wins[k] / denom[k] : p[k];
      change = Math.max(change, Math.abs(Math.log(next / p[k])));
      p[k] = next;
    }
    p[n] = 1;
    if (change < 1e-9) break;
  }
  const logs = players.map((_, k) => Math.log10(Math.max(1e-9, p[k])));
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  return new Map(players.map((pl, k) => [pl, 1500 + 400 * (logs[k] - mean)]));
}

/** Deterministic bootstrap, resampling within each pairing so every pairing keeps its size. */
function bootstrap(games: Game[], players: string[], rounds = 200): Map<string, [number, number]> {
  const samples = new Map(players.map((pl) => [pl, [] as number[]]));
  let seed = 12345;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const strata = new Map<string, Game[]>();
  for (const g of games) {
    const key = [g.left, g.right].sort().join(' vs ');
    strata.set(key, [...(strata.get(key) ?? []), g]);
  }
  for (let b = 0; b < rounds; b++) {
    const g: Game[] = [];
    for (const list of strata.values()) for (let k = 0; k < list.length; k++) g.push(list[Math.floor(rnd() * list.length)]);
    const r = bradleyTerry(g, players);
    for (const pl of players) samples.get(pl)!.push(r.get(pl)!);
  }
  return new Map(players.map((pl) => [pl, [percentile(samples.get(pl)!, 2.5), percentile(samples.get(pl)!, 97.5)] as [number, number]]));
}

export function leaderboard(summaries: MatchSummary[]): Leaderboard {
  const games: Game[] = summaries.map((s) => ({ left: s.left, right: s.right, winner: s.winner }));
  const by = new Map<string, FighterStats[]>();
  for (const s of summaries) for (const f of s.stats) by.set(f.model, [...(by.get(f.model) ?? []), f]);
  const players = [...by.keys()];
  if (!players.length) return { rows: [], matrix: {} };
  const ratings = bradleyTerry(games, players);
  const cis = bootstrap(games, players);
  const matrix: Leaderboard['matrix'] = {};
  for (const g of games) {
    const sa = g.winner === null ? 0.5 : g.winner === 0 ? 1 : 0;
    for (const [a, b, pts] of [
      [g.left, g.right, sa],
      [g.right, g.left, 1 - sa],
    ] as [string, string, number][]) {
      matrix[a] ??= {};
      matrix[a][b] ??= { points: 0, games: 0 };
      matrix[a][b].points += pts;
      matrix[a][b].games++;
    }
  }
  const rows: LeaderboardRow[] = [];
  for (const [model, fs] of by) {
    const wins = fs.filter((f) => f.result === 'win').length;
    const losses = fs.filter((f) => f.result === 'loss').length;
    const decisions = fs.reduce((a, f) => a + f.decisions, 0);
    const fallbacksN = fs.reduce((a, f) => a + Object.values(f.fallbacks).reduce((x, y) => x + y, 0), 0);
    rows.push({
      model,
      label: fs[0].label,
      rating: Math.round(ratings.get(model)!),
      ci: cis.get(model)!.map(Math.round) as [number, number],
      matches: fs.length,
      wins,
      losses,
      draws: fs.length - wins - losses,
      winRate: fs.length ? (wins + (fs.length - wins - losses) / 2) / fs.length : 0,
      p50LatencyMs: percentile(
        fs.map((f) => f.latency.p50),
        50,
      ),
      fallbackRate: decisions ? fallbacksN / decisions : 0,
      costPerMatch: fs.reduce((a, f) => a + f.costUsd, 0) / fs.length,
    });
  }
  return { rows: rows.sort((a, b) => b.rating - a.rating), matrix };
}
