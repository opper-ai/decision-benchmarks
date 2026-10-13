// Snake on the kit: a decision model steers a snake on a seeded 16 x 16 board, one choice per step (left, straight,
// right), in real time: the snake steps every 250 ms whatever the model does, and a step whose answer is not in by
// the tick is played by a fallback that never steers toward the apple. Every model plays at this one speed. The metric is the apples eaten, until death or 1000 steps. The kit's bench plays it (npm run bench --
// --game snake), free baselines included (--model baseline/greedy), and the submissions check replays its recordings
// (npm run submissions -- --game snake). Rules and question: SPEC.md.
import type { GameDefinition } from '../../packages/kit/shared/game.ts';
import { verifyGame } from './bench/verify.ts';
import { BASELINES } from './shared/baselines.ts';
import { playSnake, STEP_MS } from './shared/play.ts';
import { BENCH_VERSION, summarize, type Recording, type SnakeResult } from './shared/recording.ts';

/** Game i's seed (from 0): the golden-ratio multiple of i + 1, as a 31-bit number. Fixed: every model plays these. */
export const seedFor = (i: number): number => Math.imul(i + 1, 0x9e3779b1) >>> 1;

const game: GameDefinition<Recording, SnakeResult> = {
  slug: 'snake',
  benchVersion: BENCH_VERSION,
  mode: 'realtime',
  // A question is asked as soon as the previous step is applied and must be answered by the next tick; a call the
  // tick beats is cancelled and the fallback moves the snake. callTimeoutMs only bounds the warm-up and a transport
  // that can't cancel.
  timing: { decisionTimeoutMs: STEP_MS, callTimeoutMs: 2000, maxInFlight: 1 },
  rules: {
    minGames: 24,
    officialGames: 100,
    seedFor,
    // 1000 steps of a few dozen bytes each: well under 64 KB gzipped.
    maxRecordingBytes: 256 * 1024,
  },
  metric: { name: 'Apples', unit: 'apples', higherIsBetter: true },
  play: ({ transport, seed, signal, model }) => playSnake({ transport, seed, signal, model, timeoutMs: game.timing.callTimeoutMs, stepMs: STEP_MS }),
  verify: (rec, { seed }) => verifyGame(rec, { seed }),
  summarize: (results) => summarize(results),
  baselines: BASELINES,
};

export default game;
