import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { validateLeaderboard } from '../../../packages/kit/shared/contract';
import { leaderboardRows } from '../../../packages/kit/client/leaderboard';
import { demoFrom, loadDemo, RECORDINGS } from '../src/recordings';
import game, { seedFor } from '../game';
import { DECISION_MODELS } from '../../../packages/kit/shared/models';
import { BENCH_VERSION } from '../shared/recording';

const pub = (f: string) => JSON.parse(readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8'));
const gz = (f: string) => JSON.parse(gunzipSync(readFileSync(new URL(`../public/${f}`, import.meta.url))).toString('utf8'));
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
  it('has an official leaderboard of decision models only (100 games each, a skipped model unranked), and baselines in the same shape, kept out of it', () => {
    const lb = pub('leaderboard.json');
    expect(validateLeaderboard(lb, 'snake')).toEqual([]);
    expect(lb.benchVersion).toBe(BENCH_VERSION);
    const listed = new Set<string>(DECISION_MODELS.map((m) => m.id));
    expect(lb.entries.length).toBeGreaterThan(0);
    for (const e of lb.entries as { model: string; games: number }[]) {
      expect(listed.has(e.model), e.model).toBe(true);
      expect(e.games).toBe(100);
    }
    for (const s of lb.skipped as { model: string }[]) expect(lb.entries.some((e: { model: string }) => e.model === s.model)).toBe(false);
    const bl = pub('baselines.json');
    expect(validateLeaderboard(bl, 'snake')).toEqual([]);
    expect(bl.entries.map((e: { model: string; games: number }) => [e.model, e.games])).toEqual([['baseline/flood', 100], ['baseline/greedy', 100], ['baseline/random', 100]]);
  });

  it('has a Watch chip for every ranked model, in leaderboard order, and none for a skipped one', () => {
    const lb = pub('leaderboard.json');
    expect(RECORDINGS.map((r) => r.model)).toEqual(lb.entries.map((e: { model: string }) => e.model));
    expect(RECORDINGS.map((r) => r.name)).toEqual(lb.entries.map((e: { name: string }) => e.name));
    for (const s of lb.skipped as { model: string }[]) expect(RECORDINGS.some((r) => r.model === s.model)).toBe(false);
  });

  it("plays each chip's own official game, which verifies on its seed and replays without divergence", () => {
    for (const r of RECORDINGS) {
      expect(r.path, r.model).toMatch(/^demo\/[a-z0-9][a-z0-9.-]*\.json\.gz$/);
      const rec = gz(r.path);
      expect(rec.model, r.path).toBe(r.model);
      expect(r.seed, r.path).toBe(seedFor(r.game - 1));
      const verdict = game.verify(rec, { seed: r.seed });
      expect(verdict.ok, `${r.path}: ${verdict.ok ? '' : verdict.error}`).toBe(true);
      const demo = demoFrom(rec);
      expect(demo, r.path).not.toBeNull();
      expect([demo!.seed, demo!.final.apples, demo!.final.steps, demo!.final.over]).toEqual([r.seed, rec.result.score, rec.result.steps, rec.result.end]);
    }
    const tampered = gz(RECORDINGS[0]!.path);
    tampered.result.score += 1;
    expect(demoFrom(tampered)).toBeNull();
  });

  it('loads a recording gzipped, or unpacked by a server on the way', async () => {
    const r = RECORDINGS[0]!;
    const bytes = readFileSync(new URL(`../public/${r.path}`, import.meta.url));
    for (const body of [bytes, gunzipSync(bytes)]) {
      vi.stubGlobal('fetch', async () => new Response(new Uint8Array(body)));
      expect((await loadDemo(r.path))?.seed).toBe(r.seed);
    }
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }));
    expect(await loadDemo(r.path)).toBeNull();
    vi.unstubAllGlobals();
  });
});
