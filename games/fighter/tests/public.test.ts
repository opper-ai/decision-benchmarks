import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { validateLeaderboard } from '../../../packages/kit/shared/contract.ts';
import game from '../game.ts';
import { BASELINES } from '../shared/baselines.ts';
import { BENCH_ENGINE, BENCH_MODE, BENCH_RULES, BENCH_TRACK, DEADLINE_MS } from '../shared/gauntlet.ts';
import { ReplayPlayer, type Replay } from '../shared/replay.ts';

const file = (name: string) => new URL(`../public/${name}`, import.meta.url);
const json = (name: string) => JSON.parse(readFileSync(file(name), 'utf8')) as Record<string, any>;

describe('the files the page serves', () => {
  it("lists recordings for Watch, model against model, that replay exactly on the benchmark's settings", () => {
    const { demos } = json('demo/index.json') as { demos: { file: string; title: string }[] };
    expect(demos.length).toBeGreaterThanOrEqual(1);
    for (const d of demos) {
      const rec = JSON.parse(gunzipSync(readFileSync(file(`demo/${d.file}`))).toString('utf8')) as Replay;
      expect(new ReplayPlayer(rec).diverged, d.file).toBeNull();
      expect(d.title).toBe(`${rec.fighters[0].label} vs ${rec.fighters[1].label}`);
      // Watch plays decision models against each other only, never a model against a script (scripts/record-demo.ts
      // --left/--right): on the benchmark's settings all the same.
      expect(rec.bench, d.file).toBeUndefined();
      expect([rec.mode, rec.track, rec.deadlineMs, rec.engineVersion, JSON.stringify(rec.rules)], d.file).toEqual([BENCH_MODE, BENCH_TRACK, DEADLINE_MS, BENCH_ENGINE, JSON.stringify(BENCH_RULES)]);
      expect(rec.fighters.every((f) => f.kind === 'systemone'), d.file).toBe(true);
    }
  });

  it("has every baseline's own results on the benchmark, in the leaderboard's shape", () => {
    const b = json('baselines.json');
    expect(validateLeaderboard(b, 'fighter')).toEqual([]);
    expect(b.benchVersion).toBe(game.benchVersion);
    expect(b.metric).toEqual(game.metric);
    expect(b.entries.map((e: { model: string }) => e.model).sort()).toEqual([...BASELINES].sort());
    for (const e of b.entries) expect(e.games).toBeGreaterThanOrEqual(game.rules.officialGames);
  });
});
