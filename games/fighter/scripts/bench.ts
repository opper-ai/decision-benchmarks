import { parseArgs } from 'node:util';
import { adapterFor } from '../adapters/index.ts';
import { isBaseline } from '../shared/baselines.ts';
import { Match, instantClock } from '../shared/match.ts';
import { DEFAULT_LEFT, DEFAULT_RIGHT, OFFICIAL_ROSTER, modelInfo } from '../shared/models.ts';
import { encodeReplay, type Replay } from '../shared/replay.ts';
import type { Track } from '../shared/question.ts';
import type { FighterMeta } from '../shared/replay.ts';
import type { FighterStats } from '../shared/stats.ts';
import { leaderboardFor, saveReplay } from '../server/store.ts';
import { keyFor as fighterKey, loadFighters } from '../server/fighters.ts';
import { endpointAdapter, endpointModelId, hostOf } from '../shared/endpoints.ts';

const { values } = parseArgs({
  options: {
    left: { type: 'string', default: DEFAULT_LEFT },
    right: { type: 'string', default: DEFAULT_RIGHT },
    models: { type: 'string' },
    matches: { type: 'string', default: '2' },
    mode: { type: 'string', default: 'paused' },
    track: { type: 'string', default: 'assisted' },
    deadline: { type: 'string' },
    parallel: { type: 'string', default: '2' },
    seed: { type: 'string' },
    leaderboard: { type: 'boolean', default: false },
    // The official run: every model in the roster against every other.
    official: { type: 'boolean', default: false },
    // Also save each replay to a hosted site as official (needs ADMIN_TOKEN).
    upload: { type: 'string' },
  },
});

const uploadTo = values.upload?.replace(/\/+$/, '');
const adminToken = process.env.ADMIN_TOKEN ?? '';
if (uploadTo && !adminToken) {
  console.error('--upload needs ADMIN_TOKEN (the one set on the site).');
  process.exit(1);
}

async function upload(r: Replay): Promise<string> {
  const res = await fetch(`${uploadTo}/api/replays`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/gzip' },
    body: (await encodeReplay(r)) as BodyInit,
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; source?: string; error?: string };
  if (!res.ok || !body.id) throw new Error(`upload failed: ${body.error ?? `HTTP ${res.status}`}`);
  if (body.source !== 'official') throw new Error('upload was not saved as official');
  return body.id;
}

const mode = values.mode === 'realtime' ? 'realtime' : 'paused';
const track: Track = values.track === 'raw' ? 'raw' : 'assisted';
// Paused mode waits for answers, so its deadline only catches hung calls.
const deadlineMs = Number(values.deadline ?? (mode === 'paused' ? 10000 : 2000));
const perPair = Math.max(1, Number(values.matches));
const parallel = Math.max(1, Number(values.parallel));
/** Baselines "think" for as long as a fast classifier in real time, so speed doesn't flatter them. */
const BASELINE_LATENCY_MS = mode === 'realtime' ? 250 : 0;

const fighters = loadFighters();
for (const e of fighters.errors) console.warn(`fighters.json: ${e}`);
const fileEndpoint = (id: string) => fighters.endpoints.find((e) => e.id === id);

const meta = (model: string, k: number): FighterMeta => {
  const color = k === 0 ? '#E07B45' : '#1FA3B3';
  const e = fileEndpoint(model);
  if (e) return { model: endpointModelId(e), label: e.name, kind: e.format === 'chat' ? 'chat' : 'systemone', color, via: 'custom', host: hostOf(e.url) };
  const info = modelInfo(model);
  return { model, label: info.label, kind: info.kind, color };
};
const label = (id: string) => fileEndpoint(id)?.name ?? modelInfo(id).label;
const adapter = (id: string, deps: { apiKey: string; baseUrl?: string }) => {
  const e = fileEndpoint(id);
  return e ? endpointAdapter(e, fighterKey(e)) : adapterFor(id, deps, modelInfo(id).kind, BASELINE_LATENCY_MS);
};

/**
 * Each pairing is played from both sides: even matches as given, odd matches swapped. Every pairing
 * gets the same seeds, and both sides of a seed, so no pair draws easier fights than another.
 */
const seedBase = values.seed ? Number(values.seed) : Math.floor(Math.random() * 2 ** 30);
type Job = { pair: [string, string]; seed: number };
function schedule(): Job[] {
  const pairs: [string, string][] = [];
  if (values.official || values.leaderboard || values.models) {
    const models = values.models
      ? values.models.split(',').map((s) => s.trim())
      : values.official
        ? OFFICIAL_ROSTER
        : ['typesafe/jev-1.13.0', 'sference/clef', 'baseline/random', 'baseline/greedy'];
    for (let a = 0; a < models.length; a++) for (let b = a + 1; b < models.length; b++) pairs.push([models[a], models[b]]);
  } else {
    pairs.push([values.left!, values.right!]);
  }
  const out: Job[] = [];
  for (const [a, b] of pairs) for (let k = 0; k < perPair; k++) out.push({ pair: k % 2 === 0 ? [a, b] : [b, a], seed: seedBase + Math.floor(k / 2) });
  return out;
}

const jobs = schedule();
const needsKey = jobs.some(({ pair }) => pair.some((id) => !isBaseline(id) && !fileEndpoint(id)));
const apiKey = process.env.OPPER_API_KEY ?? '';
if (needsKey && !apiKey) {
  console.error('Set OPPER_API_KEY (in .env or the environment).');
  process.exit(1);
}

const fmt = (n: number, d = 0) => n.toFixed(d);
function row(f: FighterStats): string {
  const fb = Object.values(f.fallbacks).reduce((a, b) => a + b, 0);
  return [
    f.label.padEnd(22),
    f.result.padEnd(5),
    `rounds ${f.roundsWon}`,
    `hp ${String(f.dealt).padStart(3)}/${String(f.taken).padStart(3)}`,
    `dec ${String(f.decisions).padStart(3)}`,
    `p50 ${fmt(f.latency.p50).padStart(5)}ms`,
    `fallback ${fb} (${fmt(f.fallbackRate * 100)}%)`,
    `$${f.costUsd.toFixed(4)}`,
  ].join('  ');
}

const warmed = new Set<string>();
async function playOne({ pair: [l, r], seed }: Job, k: number): Promise<void> {
  const deps = { apiKey, baseUrl: process.env.OPPER_BASE_URL };
  const a = adapter(l, deps);
  const b = adapter(r, deps);
  const m = new Match({
    seed,
    mode,
    track,
    deadlineMs,
    adapters: [a, b],
    fighters: [meta(l, 0), meta(r, 1)],
    maxTokens: [modelInfo(l).contextTokens, modelInfo(r).contextTokens],
    paced: mode === 'realtime',
    ...(mode === 'paused' && isBaseline(l) && isBaseline(r) ? { clock: instantClock } : {}),
  });
  if (!warmed.has(l) || !warmed.has(r)) {
    for (const e of await m.warmUp()) console.warn(`  warm-up failed: ${e}`);
    warmed.add(l).add(r);
  }
  const t0 = performance.now();
  const replay = await m.run();
  // Endpoints from fighters.json are yours, not part of an official board.
  const custom = [l, r].some((id) => fileEndpoint(id));
  const summary = await saveReplay(replay, undefined, { source: custom ? 'community' : 'official' });
  const remote = uploadTo && !custom ? await upload(replay) : null;
  const secs = ((performance.now() - t0) / 1000).toFixed(0);
  const winner = replay.result.winner === null ? 'draw' : replay.fighters[replay.result.winner].label;
  console.log(`\n#${k + 1} ${label(l)} vs ${label(r)}: ${winner} (${secs}s, seed ${seed}, replay ${summary.id}${remote ? `, uploaded ${remote}` : ''})`);
  for (const f of summary.stats) console.log(`  ${row(f)}`);
}

console.log(`${jobs.length} match(es), mode ${mode}, track ${track}, deadline ${deadlineMs} ms, ${parallel} at a time, seeds from ${seedBase}${uploadTo ? `, uploading to ${uploadTo}` : ''}`);
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(parallel, jobs.length) }, async () => {
    while (next < jobs.length) {
      const k = next++;
      try {
        await playOne(jobs[k], k);
      } catch (e) {
        console.error(`#${k + 1} failed: ${(e as Error).message}`);
      }
    }
  }),
);

// Endpoint matches are community matches (kept off the official board), but this is your own bench.
const withEndpoints = jobs.some(({ pair }) => pair.some((id) => fileEndpoint(id)));
const lb = await leaderboardFor(mode, track, withEndpoints);
console.log(`\nLeaderboard (${mode}, ${track}, ${withEndpoints ? 'all' : 'official'} saved matches on this engine):`);
for (const r of lb.rows) {
  console.log(
    `  ${r.label.padEnd(24)} ${String(r.rating).padStart(5)} [${r.ci[0]}, ${r.ci[1]}]  ${r.wins}-${r.losses}-${r.draws}  score ${fmt(r.winRate * 100)}%  p50 ${fmt(r.p50LatencyMs)}ms  fallback ${fmt(r.fallbackRate * 100)}%  $${r.costPerMatch.toFixed(4)}/match`,
  );
}
const names = lb.rows.map((r) => r.model);
const rowLabel = (model: string) => lb.rows.find((r) => r.model === model)?.label ?? model;
if (names.length > 1) {
  console.log('\nScore of row vs column (points / games):');
  console.log(`  ${''.padEnd(24)}${names.map((n) => rowLabel(n).slice(0, 12).padStart(14)).join('')}`);
  for (const a of names) {
    const cells = names.map((b) => {
      const c = lb.matrix[a]?.[b];
      return (a === b || !c ? '' : `${c.points}/${c.games}`).padStart(14);
    });
    console.log(`  ${rowLabel(a).padEnd(24)}${cells.join('')}`);
  }
}
