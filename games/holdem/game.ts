// AI Hold'em on the kit: one benchmark game is 120 duplicate cash hands (30 deals, each played from all four seats)
// of the model under test against rock, station and maniac, 4-handed at 1/2 with 100 big blinds reset every hand. The
// metric is big blinds won per 100 hands. Paused: the table waits for each answer, up to 2.5 s for a decision model
// and 20 s for a chat model (the kit's one timing is the decision models'; chat models get timing.chatTimeoutMs, and
// play reads `via` and the model's kind to pick the deadline). Decision models answer a System One choice; chat models
// (the Claude, GPT, Gemini and Titan sets, and Grok, DeepSeek, Qwen, Kimi, GLM and MiniMax) answer the same question
// through Opper's chat completions with table talk, a mood and their reasoning (shared/questions.ts). The kit's bench
// plays it (npm run bench -- --game holdem), the bots and random as free baselines (--model baseline/rock), and the
// submissions check replays its recordings.
import type { GameDefinition } from '../../packages/kit/shared/game.ts';
import { BENCH_VERSION, playBench, seedFor, summarize, verifyBench, type BenchRecording, type HoldemResult } from './shared/bench.ts';
import { CHAT_MODELS, CHAT_TIMEOUT_MS, DECISION_TIMEOUT_MS } from './shared/models.ts';
import { CHAT_FORMAT } from './shared/questions.ts';

const BASELINE_NAMES = { rock: 'Rock (bot)', station: 'Station (bot)', maniac: 'Maniac (bot)', random: 'Random' } as const;

const game: GameDefinition<BenchRecording, HoldemResult> = {
  slug: 'holdem',
  benchVersion: BENCH_VERSION,
  mode: 'paused',
  timing: { decisionTimeoutMs: DECISION_TIMEOUT_MS, callTimeoutMs: DECISION_TIMEOUT_MS, chatTimeoutMs: CHAT_TIMEOUT_MS, maxInFlight: 1 },
  rules: {
    // Four games: 480 hands, about 1200 decisions.
    minGames: 4,
    officialGames: 4,
    seedFor,
    // 120 hands; a chat model's moves carry up to 90 characters of talk and 600 of reasoning: a few hundred KB of JSON,
    // under 100 KB gzipped.
    maxRecordingBytes: 512 * 1024,
  },
  metric: { name: 'bb/100', unit: 'bb/100', higherIsBetter: true },
  // The three bots and random, each in the model's seat against the field, for reference: never ranked.
  baselines: Object.fromEntries(Object.entries(BASELINE_NAMES).map(([id, name]) => [id, { name }])),
  chatModels: CHAT_MODELS,
  chat: CHAT_FORMAT,
  // A failed call is the fallback's move; the bench says why, so a flaky route shows.
  play: ({ transport, seed, signal, model, via }) => playBench({ transport, seed, signal, model, via, onError: (m) => console.warn(`  ${model}: call failed, the fallback played: ${m}`) }),
  verify: (rec, { seed }) => verifyBench(rec, seed),
  summarize,
};

export default game;
