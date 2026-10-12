// The bench: plays a game's benchmark against decision models and writes what it found.
// Entry point: scripts/bench.ts (npm run bench -- --game <slug> ...), which picks the game from games/registry.ts.
//
//   --model <id> | --models all|<id>,<id>    listed models (packages/kit/shared/models.ts) through Opper (OPPER_API_KEY)
//                                            or, for Jev, TypeSafe (TYPESAFE_API_KEY); baseline/<name> plays one of the
//                                            game's free baselines (no key, no network)
//   --endpoint <url> [--format systemone|chat] [--chat-model <name>]
//                                            your own model: System One ({ state, questions } in) or OpenAI chat
//                                            completions through the chat adapter; BENCH_ENDPOINT_TOKEN is sent as a
//                                            bearer token
//   --games <n>  --parallel <n>  --seed <n>  how many games, how many at a time, one seed for every game (trying only)
//   --leaderboard [--out <file>]             official runs: writes games/<slug>/public/leaderboard.json (baselines only
//                                            with --out, e.g. games/<slug>/public/baselines.json)
//   --submit <dir> --name <name> --by <github-handle> [--url <https://...>]
//                                            records a submission (see CONTRIBUTING.md)
//   --record <file>                          writes the recording of one game (--games 1), e.g. a demo for Watch
//   --list-models                            compares the checked-in model list with GET /v3/models?type=evaluation
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { devTargetFromEnv } from '../server/systemone.ts';
import type { Entry, Leaderboard } from '../shared/contract.ts';
import { BASELINE_PREFIX, type GameDefinition, type GameResult } from '../shared/game.ts';
import { DECISION_MODELS, DEFAULT_MODEL, isModelId, modelName } from '../shared/models.ts';
import type { Transport } from '../shared/systemone.ts';
import { diffModels, fetchEvaluationModels } from './models.ts';
import { boardFor, entryFor, playMany } from './results.ts';
import { chatTransport, endpointTransport, systemOneTransport } from './transports.ts';
import { warmUp } from './warm.ts';

/** A usage problem: the message is for the person running the bench. */
export class BenchError extends Error {}

const fail = (msg: string): never => {
  throw new BenchError(msg);
};

/** One model the bench plays: its id on the leaderboard, its name, how to reach it. */
interface Contender {
  model: string;
  name: string;
  via: Entry['via'];
  transport: Transport;
  /** A game's own scripted player: nothing to warm up. */
  baseline?: boolean;
}

export interface BenchPaths {
  /** games/<slug>/public: where --leaderboard writes leaderboard.json. */
  publicDir: string;
}

export const SUBMISSION_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Runs the bench for `game` with command-line `argv`; resolves once done, throws BenchError for a usage problem. */
export async function runBench(game: GameDefinition<unknown, GameResult>, argv: string[], env: Record<string, string | undefined>, paths: BenchPaths, log: (line: string) => void = console.log): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      game: { type: 'string' },
      model: { type: 'string' },
      models: { type: 'string' },
      endpoint: { type: 'string' },
      format: { type: 'string', default: 'systemone' },
      'chat-model': { type: 'string' },
      games: { type: 'string' },
      seed: { type: 'string' },
      parallel: { type: 'string' },
      leaderboard: { type: 'boolean', default: false },
      out: { type: 'string' },
      submit: { type: 'string' },
      name: { type: 'string' },
      by: { type: 'string' },
      url: { type: 'string' },
      record: { type: 'string' },
      'list-models': { type: 'boolean', default: false },
    },
  });

  if (values['list-models']) {
    const { added, gone } = diffModels(await fetchEvaluationModels());
    log(added.length || gone.length ? '' : 'the checked-in list matches the live one');
    for (const m of added) log(`new on Opper: ${m.id}${m.name ? ` (${m.name})` : ''}`);
    for (const id of gone) log(`no longer listed: ${id}`);
    return;
  }

  const submit = values.submit !== undefined;
  const leaderboard = values.leaderboard;
  const games = Number(values.games ?? (leaderboard ? game.rules.officialGames : submit ? game.rules.minGames : 4));
  if (!Number.isInteger(games) || games < 1) fail('--games must be a whole number of at least 1');
  const parallel = Number(values.parallel ?? 4);
  const fixedSeed = values.seed === undefined ? undefined : Number(values.seed);
  if (fixedSeed !== undefined && !Number.isInteger(fixedSeed)) fail('--seed must be a whole number');
  if (fixedSeed !== undefined && (submit || leaderboard)) fail('--seed is for trying a game; submissions and official runs play the fixed seeds');
  if (values.record && games !== 1) fail('--record needs --games 1');
  if (values.format !== 'systemone' && values.format !== 'chat') fail('--format is systemone or chat');
  if (values.endpoint && (values.model || values.models)) fail('--endpoint plays your model, instead of --model or --models');
  if (values.format === 'chat' && !values.endpoint) fail('--format chat needs --endpoint (a chat completions URL)');
  if (values.format === 'chat' && !values['chat-model']) fail('--format chat needs --chat-model (the model name the endpoint expects)');
  if (leaderboard && values.endpoint) fail('--leaderboard is for official runs of the listed models; send your model as a submission (--submit)');
  if (submit) {
    if (!values.endpoint) fail('--submit records your model through --endpoint');
    if (!values.name || !values.by) fail('--submit needs --name "Model name" and --by <your GitHub handle>');
    if (!SUBMISSION_ID.test(basename(values.submit!))) fail(`--submit folder name is the model id: lowercase letters, digits and dashes, e.g. games/${game.slug}/submissions/my-model`);
    if (games < game.rules.minGames) fail(`a submission needs at least ${game.rules.minGames} games`);
    if (!/^[A-Za-z0-9-]{1,39}$/.test(values.by!)) fail('--by must be a GitHub handle');
    if (values.url !== undefined && !/^https:\/\/\S+$/.test(values.url)) fail('--url must start with https://');
  }

  const timeoutMs = game.timing.callTimeoutMs;
  const contenders: Contender[] = [];
  if (values.endpoint) {
    const name = values.name ?? values.endpoint;
    const common = { url: values.endpoint, token: env.BENCH_ENDPOINT_TOKEN, timeoutMs, name };
    contenders.push({
      model: submit ? basename(values.submit!) : name,
      name,
      via: values.format === 'chat' ? 'chat-adapter' : 'systemone',
      transport: values.format === 'chat' ? chatTransport({ ...common, model: values['chat-model']! }) : endpointTransport(common),
    });
  } else {
    const ids = values.models === 'all' || values.models === '' ? DECISION_MODELS.map((m) => m.id as string) : values.models !== undefined ? values.models.split(',') : [values.model ?? DEFAULT_MODEL];
    const baselines = ids.filter((id) => id.startsWith(BASELINE_PREFIX));
    // Baselines are for reference: the official leaderboard ranks decision models only, so they go to a file of their own.
    if (baselines.length && (submit || (leaderboard && (baselines.length !== ids.length || values.out === undefined)))) {
      fail(`baselines never go on the leaderboard or into a submission: play them alone with --out, e.g. --leaderboard --out games/${game.slug}/public/baselines.json`);
    }
    const target = baselines.length === ids.length ? undefined : devTargetFromEnv(env);
    if (!target && baselines.length !== ids.length) fail('set OPPER_API_KEY (or TYPESAFE_API_KEY for Jev) to play the listed models');
    for (const id of ids) {
      if (id.startsWith(BASELINE_PREFIX)) {
        const b = game.baselines?.[id.slice(BASELINE_PREFIX.length)];
        if (!b) fail(`${game.slug} has no baseline ${id}; ${Object.keys(game.baselines ?? {}).length ? `one of: ${Object.keys(game.baselines!).map((n) => BASELINE_PREFIX + n).join(', ')}` : 'it has none'}`);
        contenders.push({ model: id, name: b!.name, via: 'systemone', transport: b!.transport(), baseline: true });
        continue;
      }
      if (!isModelId(id)) fail(`Unknown model ${id}; one of: ${DECISION_MODELS.map((m) => m.id).join(', ')}`);
      contenders.push({ model: id, name: modelName(id), via: 'systemone', transport: systemOneTransport(id, target, timeoutMs, `decision-benchmarks-bench-${game.slug}`) });
    }
  }

  const out = values.out ?? join(paths.publicDir, 'leaderboard.json');
  const entries: Entry[] = [];
  const skipped: Leaderboard['skipped'] = [];
  const write = () => {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(boardFor(game, entries, skipped), null, 2)}\n`);
  };
  const seedOf = (i: number) => fixedSeed ?? game.rules.seedFor(i);
  log(`${game.slug}: ${contenders.length} model${contenders.length === 1 ? '' : 's'} x ${games} games, ${parallel} at a time`);

  for (const c of contenders) {
    log(`\n${c.name} (${c.model})`);
    // Warm first: a cold model's first answers would come too late and count as fallbacks.
    const problem = c.baseline ? null : await warmUp(c.transport, { fastMs: timeoutMs * 0.9, log });
    if (problem) {
      if (!leaderboard) fail(`${c.name}: ${problem}`);
      // One unavailable model must not cost the others' results.
      log(`  skipped: ${problem}`);
      skipped.push({ model: c.model, reason: problem });
      write();
      continue;
    }
    const recordings: unknown[] = [];
    const results = await playMany(games, parallel, async (i) => {
      const { result, recording } = await game.play({ transport: c.transport, seed: seedOf(i), signal: new AbortController().signal, model: c.model });
      recordings[i] = recording;
      log(`  game ${i + 1}: ${game.metric.name.toLowerCase()} ${result.score}, calls ${result.calls}, fallbacks ${result.fallbacks}/${result.decisions}, $${result.cost.toFixed(4)}`);
      return result;
    });
    const entry = entryFor(game, c.model, c.name, results, c.via);
    log(`  MEAN ${entry.metric.mean} ± ${round2(2 * entry.metric.stdError)}, best ${entry.metric.best}, fallbacks ${(entry.fallbackRate * 100).toFixed(1)}%, latency ${entry.meanLatencyMs ?? '-'} ms, ${entry.costPerGame === null ? 'cost unknown' : `$${entry.costPerGame}/game`}`);
    entries.push(entry);
    if (leaderboard) write(); // after every model, so an interrupted run keeps what it has
    if (values.record) {
      mkdirSync(dirname(values.record), { recursive: true });
      writeFileSync(values.record, JSON.stringify(recordings[0]));
      log(`recorded the game to ${values.record}`);
    }
    if (submit) writeSubmission(game, values.submit!, recordings, seedOf, { name: values.name!, by: values.by!, url: values.url, via: c.via }, log);
  }
  if (leaderboard) {
    write();
    log(`\nwrote ${out}`);
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Writes the games as a submission folder, after checking each one replays the way CI will check it. */
export function writeSubmission(game: GameDefinition<unknown, GameResult>, dir: string, recordings: unknown[], seedOf: (i: number) => number, who: { name: string; by: string; url?: string; via: Entry['via'] }, log: (line: string) => void = console.log): void {
  recordings.forEach((rec, i) => {
    const verdict = game.verify(JSON.parse(JSON.stringify(rec)), { seed: seedOf(i) });
    if (!verdict.ok) fail(`game ${i + 1} does not replay: ${verdict.error}. Please open an issue: this is a bug in the game or the kit.`);
  });
  mkdirSync(dir, { recursive: true });
  // A run replaces the folder's games: none of an earlier run may be left behind.
  for (const f of readdirSync(dir)) if (/^game-\d+\.json\.gz$/.test(f)) rmSync(join(dir, f));
  recordings.forEach((rec, i) => writeFileSync(join(dir, gameFile(i)), gzipSync(JSON.stringify(rec))));
  const manifest = {
    name: who.name,
    by: who.by,
    ...(who.url ? { url: who.url } : {}),
    via: who.via,
    benchVersion: game.benchVersion,
    recordedAt: new Date().toISOString(),
    games: recordings.length,
  };
  writeFileSync(join(dir, 'submission.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  log(`\nwrote ${recordings.length} games to ${dir}. Check them with npm run submissions -- --game ${game.slug}, then open a pull request (see CONTRIBUTING.md).`);
}

/** Game i's file (from 0): game-01.json.gz, ..., game-100.json.gz. Its seed is the game's seedFor(i). */
export const gameFile = (i: number): string => `game-${String(i + 1).padStart(2, '0')}.json.gz`;
