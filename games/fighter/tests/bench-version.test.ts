import { describe, expect, it } from 'vitest';
import game from '../game.ts';
import { BENCH_ENGINE, BENCH_MODE, BENCH_RULES, BENCH_TRACK, BENCH_VERSION, DEADLINE_MS, GAUNTLET, matchSpec } from '../shared/gauntlet.ts';
import { MOVES } from '../shared/engine/moves.ts';
import { instructionsFor, rawFacts, TRACKS } from '../shared/question.ts';

/** FNV-1a of everything a fighter score depends on that is not the engine's own code (that is ENGINE_VERSION). */
function benchmarkHash(): string {
  const text = JSON.stringify({
    engine: BENCH_ENGINE,
    mode: BENCH_MODE,
    track: BENCH_TRACK,
    rules: BENCH_RULES,
    deadline: DEADLINE_MS,
    gauntlet: GAUNTLET,
    seeds: Array.from({ length: game.rules.officialGames }, (_, i) => matchSpec(game.rules.seedFor(i))),
    instructions: TRACKS.flatMap((t) => [false, true].flatMap((c) => [false, true].map((p) => instructionsFor(t, c, p)))),
    moves: MOVES,
    raw: Object.keys(MOVES).map((m) => rawFacts(m as keyof typeof MOVES)),
  });
  let h = 0x811c9dc5;
  for (let k = 0; k < text.length; k++) {
    h ^= text.charCodeAt(k);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

describe('the bench version', () => {
  it('names the benchmark that results were played on', () => {
    // If this fails, the benchmark changed and old results are no longer comparable: bump BENCH_VERSION in
    // shared/gauntlet.ts (older submissions then drop off until re-run) and pin the new hash here.
    expect({ version: BENCH_VERSION, hash: benchmarkHash() }).toEqual({ version: 1, hash: '3b23e1a7' });
    expect(game.benchVersion).toBe(BENCH_VERSION);
  });
});
