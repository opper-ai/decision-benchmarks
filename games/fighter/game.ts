// Jev Fighter on the kit: one game is one paused match (assisted track) of the model under test against one baseline of
// the gauntlet (greedy, payoff, maximin), from one side; the metric is the model's share of the rounds won (a drawn round
// counts half), in percent. The kit's bench plays it (npm run bench -- --game fighter) and the submissions check replays
// its recordings (npm run submissions -- --game fighter). See shared/gauntlet.ts.
import { BASELINE_PREFIX, type GameDefinition } from '../../packages/kit/shared/game.ts';
import { baselineAdapter, baselineName, BASELINES, isBaseline } from './shared/baselines.ts';
import { BENCH_MODE, BENCH_VERSION, DEADLINE_MS, matchSpec, playGauntlet, resultOf, summarize, verifyGauntlet, type FighterResult, type GauntletRecording } from './shared/gauntlet.ts';
import { transportAdapter } from './shared/transport-adapter.ts';

const game: GameDefinition<GauntletRecording, FighterResult> = {
  slug: 'fighter',
  benchVersion: BENCH_VERSION,
  mode: BENCH_MODE,
  // Paused: the fight waits for each answer, up to the deadline. One question at a time.
  timing: { decisionTimeoutMs: DEADLINE_MS, callTimeoutMs: DEADLINE_MS, maxInFlight: 1 },
  rules: {
    // A multiple of the 6 games one fight makes (3 baselines x 2 sides), so every baseline is met as often from each side.
    minGames: 24,
    // 17 fights x 3 baselines x 2 sides.
    officialGames: 102,
    seedFor: (i) => i,
    // A long match (five drawn-out rounds) gzips to a few hundred KB.
    maxRecordingBytes: 2 << 20,
  },
  metric: { name: 'Round-win share vs baselines', unit: '%', higherIsBetter: true },
  // Every baseline can be the player under test, for the reference results in public/baselines.json. They read the full
  // fight state, so `play` plays them itself (no transport): `--model baseline/<name>`.
  baselines: Object.fromEntries(BASELINES.map((id) => [id.slice(BASELINE_PREFIX.length), { name: baselineName(id) }])),
  async play({ transport, seed, signal, model }) {
    const adapter = isBaseline(model) ? baselineAdapter(model) : transportAdapter(model, transport);
    const recording = await playGauntlet({ seed, model, adapter, signal });
    return { result: resultOf(matchSpec(seed), recording.decisions, recording.result), recording };
  },
  verify: (rec, { seed }) => verifyGauntlet(rec, seed),
  summarize,
};

export default game;
