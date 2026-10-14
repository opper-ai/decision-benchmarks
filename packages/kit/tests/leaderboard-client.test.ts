import { describe, expect, it } from 'vitest';
import { fmt, leaderboardRows, modelNote, numberCells, tableHeadings, tableOrder } from '../client/leaderboard.ts';

const entry = (model: string, mean: number, stdError: number, more: Record<string, unknown> = {}) => ({ model, name: model, games: 100, metric: { mean, stdError, best: 60 }, meanLatencyMs: 300, fallbackRate: 0.01, costPerGame: 0.0123, via: 'systemone', ...more });

describe("the game pages' shared leaderboard", () => {
  it('ranks official and self-reported rows together with =1 ties, keeps the baselines apart and unranked', () => {
    const { ranked, baselines } = leaderboardRows(
      { entries: [entry('sference/clef', 30, 1), entry('opper/kev-4b', 10, 1)] },
      { entries: [entry('my-bot', 31, 1, { name: 'My Bot', by: 'acme', selfReported: true })] },
      { entries: [entry('baseline/b', 5, 1, { meanLatencyMs: 0 }), entry('baseline/a', 9, 1, { extra: { vsGreedy: 70.6 } })] },
    );
    expect(ranked.map((r) => [r.rank, r.name, r.by, r.kind, r.tie])).toEqual([
      ['=1', 'My Bot', 'acme', 'community', true],
      ['=1', 'Clef', 'opper-ai', 'official', true],
      ['3', 'Kev 4B', 'opper-ai', 'official', false],
    ]);
    expect(baselines.map((b) => [b.model, b.rank, b.kind])).toEqual([
      ['baseline/a', '', 'baseline'],
      ['baseline/b', '', 'baseline'],
    ]);
    expect(baselines[0]!.extra).toEqual({ vsGreedy: 70.6 });
    // Under each name, as on jevman: the maker, Community for a self-reported model, or what a baseline is.
    expect(modelNote(ranked[0]!)).toBe('Community');
    expect(modelNote(ranked[1]!)).toBe('Cloudflare');
    expect(modelNote(baselines[0]!)).toBe('Script, no model');
  });

  it("puts the baselines among the models at their score, unranked, so the ranks stay the models' own", () => {
    const rows = leaderboardRows(
      { entries: [entry('sference/clef', 30, 1), entry('opper/kev-4b', 10, 1)] },
      null,
      { entries: [entry('baseline/flood', 31, 1), entry('baseline/greedy', 20, 1), entry('baseline/random', 10, 1)] },
    );
    // A baseline that scores the same as a model comes after it.
    expect(tableOrder(rows).map((r) => [r.model, r.rank])).toEqual([
      ['baseline/flood', ''],
      ['sference/clef', '1'],
      ['baseline/greedy', ''],
      ['opper/kev-4b', '2'],
      ['baseline/random', ''],
    ]);
  });

  it('copes with missing files (community.json before any submission)', () => {
    expect(leaderboardRows(null, null, null)).toEqual({ ranked: [], baselines: [] });
  });

  it("shows Snake's columns by default and a game's own columns when it names them", () => {
    const { ranked, baselines } = leaderboardRows({ entries: [entry('sference/clef', 30, 1, { extra: { vsGreedy: 61.25 } })] }, null, { entries: [entry('baseline/a', 9, 1)] });
    expect(tableHeadings({ metric: 'Apples (mean ± margin)' }).map(([l]) => l)).toEqual(['#', 'Model', 'Apples (mean ± margin)', 'Best', 'Games', 'Fallbacks', 'Latency', 'Cost / game', 'Run by']);
    // A real-time game names the fallback share for what it is: the steps the model was too late for.
    expect(tableHeadings({ metric: 'Apples (mean ± margin)', fallbacks: 'Late steps', latency: 'Mean latency' }).map(([l]) => l)).toEqual(['#', 'Model', 'Apples (mean ± margin)', 'Best', 'Games', 'Late steps', 'Mean latency', 'Cost / game', 'Run by']);
    expect(numberCells(ranked[0]!)).toEqual(['60', '100', '1%', '300 ms', '$0.0123']);
    expect(numberCells(baselines[0]!)).toEqual(['60', '100', '1%', '-', '$0.0123']);
    const fighter = { metric: 'Round-win share', best: false, format: (n: number) => `${fmt(n)}%`, extra: [{ label: 'vs greedy', key: 'vsGreedy', format: (v: number | string) => `${fmt(Number(v))}%` }, { label: 'vs payoff', key: 'vsPayoff' }] };
    expect(tableHeadings(fighter).map(([l, c]) => `${l}${c ? `:${c}` : ''}`)).toEqual(['#', 'Model', 'Round-win share', 'vs greedy:r', 'vs payoff:r', 'Games:r hide-m', 'Fallbacks:r', 'Latency:r', 'Cost / game:r', 'Run by:hide-m']);
    expect(numberCells(ranked[0]!, fighter)).toEqual(['61.3%', '-', '100', '1%', '300 ms', '$0.0123']);
  });

  it('formats numbers without trailing zeros', () => {
    expect([fmt(48.9), fmt(100), fmt(0.04), fmt(2.25, 2)]).toEqual(['48.9', '100', '0', '2.25']);
  });
});
