import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateLeaderboard } from '../../../packages/kit/shared/contract';
import { leaderboardRows } from '../src/leaderboard';
import { demoFrom, RECORDINGS } from '../src/recordings';

const pub = (f: string) => JSON.parse(readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8'));
const entry = (model: string, mean: number, stdError: number, extra: Record<string, unknown> = {}) => ({ model, name: model, games: 100, metric: { mean, stdError, best: mean * 2 }, meanLatencyMs: 300, fallbackRate: 0.01, costPerGame: 0.01, via: 'systemone', ...extra });

describe("the page's leaderboard", () => {
  it('ranks official and self-reported rows together, with =1 ties and who ran them, and keeps the baselines apart', () => {
    const official = { entries: [entry('sference/clef', 30, 1), entry('opper/kev-4b', 10, 1)] };
    const community = { entries: [entry('my-bot', 31, 1, { name: 'My Bot', by: 'acme', selfReported: true })] };
    const { ranked, baselines } = leaderboardRows(official, community, pub('baselines.json'));
    expect(ranked.map((r) => [r.rank, r.name, r.by, r.kind])).toEqual([
      ['=1', 'My Bot', 'acme', 'community'],
      ['=1', 'Clef', 'opper-ai', 'official'],
      ['3', 'Kev 4B', 'opper-ai', 'official'],
    ]);
    expect(baselines.map((b) => b.model)).toEqual(['baseline/flood', 'baseline/greedy', 'baseline/random']);
    expect(baselines.every((b) => b.rank === '' && b.kind === 'baseline')).toBe(true);
  });

  it('copes with missing files (community.json before any submission)', () => {
    expect(leaderboardRows(null, null, null)).toEqual({ ranked: [], baselines: [] });
  });
});

describe('the committed files', () => {
  it('has an official leaderboard with no entries until the official run, and baselines in the same shape, kept out of it', () => {
    const lb = pub('leaderboard.json');
    expect(validateLeaderboard(lb, 'snake')).toEqual([]);
    expect(lb.entries).toEqual([]);
    const bl = pub('baselines.json');
    expect(validateLeaderboard(bl, 'snake')).toEqual([]);
    expect(bl.entries.map((e: { model: string; games: number }) => [e.model, e.games])).toEqual([['baseline/flood', 100], ['baseline/greedy', 100], ['baseline/random', 100]]);
  });

  it('has a recording for every Watch chip that replays to its claimed score', () => {
    for (const r of RECORDINGS) expect(demoFrom(pub(r.path)), r.path).not.toBeNull();
    const tampered = pub('demo/greedy.json');
    tampered.result.score += 1;
    expect(demoFrom(tampered)).toBeNull();
  });
});
