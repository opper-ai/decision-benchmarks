// Pac-Man on the kit (jevman's benchmark): a model plays Pac-Man in real time against the scripted ghosts, until game
// over or 300 s; the metric is the score. The kit's bench plays it (npm run bench -- --game jevman) and the
// submissions check replays its recordings (npm run submissions -- --game jevman).
import type { GameDefinition } from '../../packages/kit/shared/game.ts';
import { playGame } from './bench/play.ts';
import { verifyGame } from './bench/verify.ts';
import type { Recording } from './src/replay.ts';
import { BENCH_VERSION, extraFor, SUBMISSION_RULES, type GameResult } from './shared/leaderboard.ts';

const game: GameDefinition<Recording, GameResult> = {
  slug: 'jevman',
  benchVersion: BENCH_VERSION,
  mode: 'realtime',
  timing: { decisionTimeoutMs: 2000, callTimeoutMs: 2000, maxInFlight: 3 },
  rules: {
    minGames: SUBMISSION_RULES.minGames,
    officialGames: 100,
    // Pac-Man has no randomness: every game starts the same, and the model's timing makes it go differently.
    seedFor: () => 0,
    // A 300 s game gzips to well under 1 MB.
    maxRecordingBytes: 4 << 20,
  },
  metric: { name: 'Score', unit: 'points', higherIsBetter: true },
  play: ({ transport, signal, model }) => playGame({ transport, signal, model, timeoutMs: game.timing.decisionTimeoutMs, maxInFlight: game.timing.maxInFlight }),
  verify: (rec) => verifyGame(rec as Recording),
  summarize: extraFor,
};

export default game;
