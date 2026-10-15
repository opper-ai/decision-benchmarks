import { describe, expect, it } from 'vitest';
import { bb, extraFacts, holdemRows } from '../src/views/leaderboard';
import { DEMO_FILE, parseDemoIndex } from '../src/views/watch-list';

const entry = (model: string, mean: number, extra?: Record<string, number | string>) => ({
  model,
  name: model,
  games: 4,
  metric: { mean, stdError: 2, best: mean + 5 },
  meanLatencyMs: 900,
  fallbackRate: 0.01,
  costPerGame: 0.4,
  via: 'chat-adapter',
  ...(extra ? { extra } : {}),
});

describe('the leaderboard section', () => {
  it('names chat models and bots as the page does, best first', () => {
    const official = { entries: [entry('sference/clef', -3.2), entry('aws/claude-opus-5-5', 12.5)] };
    const baselines = { entries: [entry('baseline/rock', 1), entry('baseline/random', -40)] };
    const rows = holdemRows(official, null, baselines);
    expect(rows.ranked.map((r) => [r.rank, r.name])).toEqual([['1', 'Opus 5.5'], ['2', 'Clef']]);
    expect(rows.baselines.map((r) => r.name)).toEqual(['Rock (bot)', 'Random (bot)']);
    expect(holdemRows(null, null, null)).toEqual({ ranked: [], baselines: [] });
  });

  it('turns a row’s extra numbers into the Stats row', () => {
    const facts = extraFacts({ hands: 480, 'VPIP %': 24.5, 'PFR %': 18, 'Aggression factor': 2.25, 'Fold to 3-bet %': 50, 'Went to showdown %': 30, 'Won at showdown %': 55.5, 'Bluff rate %': 12, 'bb/100 vs rock': 4.5, 'bb/100 vs station': 21, 'bb/100 vs maniac': -7.25, 'Fallback %': 0 });
    expect(facts).toEqual([
      ['VPIP', '24.5%'],
      ['PFR', '18%'],
      ['Aggression', '2.25'],
      ['Fold to a 3-bet', '50%'],
      ['Went to showdown', '30%'],
      ['Won at showdown', '55.5%'],
      ['Bluff rate', '12%'],
      ['vs Rock', '+4.5 bb/100'],
      ['vs Station', '+21 bb/100'],
      ['vs Maniac', '−7.3 bb/100'],
      ['Fallbacks', '0%'],
    ]);
    expect(extraFacts({ 'Aggression factor': '∞' })).toEqual([['Aggression', '∞']]);
    expect(extraFacts(undefined)).toEqual([]);
    expect([bb(3), bb(-1.25), bb(0)]).toEqual(['+3', '−1.3', '0']);
  });
});

describe('the replays list', () => {
  it('keeps only well-formed entries with safe file names', () => {
    const ok = { file: 'titans-headsup.json.gz', title: 'Fable vs Astra', blurb: 'Heads-up.', players: ['anthropic/claude-fable-5-1', 'azure/gpt-6-astra-global'], hands: 41, recordedAt: '2026-10-20' };
    const index = { format: 1, replays: [ok, { ...ok, file: '../secret.json' }, { ...ok, file: 'x.txt' }, { ...ok, players: ['one'] }, { ...ok, title: '' }, null, 'nope'] };
    expect(parseDemoIndex(index)).toEqual([ok]);
    expect(parseDemoIndex({ format: 1, replays: [] })).toEqual([]);
    // Tables of up to six: a six-player replay is listed, a seventh player is not.
    const six = { ...ok, players: ['a', 'b', 'c', 'd', 'e', 'f'] };
    expect(parseDemoIndex({ format: 1, replays: [six, { ...six, players: [...six.players, 'g'] }] })).toEqual([six]);
    expect(parseDemoIndex(null)).toEqual([]);
    expect(['a.json', 'claude-vs-gpt.json.gz'].every((f) => DEMO_FILE.test(f))).toBe(true);
    expect(['A.json', '-x.json', 'x.json.zip', 'x/y.json', '.json'].some((f) => DEMO_FILE.test(f))).toBe(false);
  });
});
