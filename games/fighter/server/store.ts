import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeReplay, encodeReplay, type Replay } from '../shared/replay.ts';
import { ENGINE_VERSION } from '../shared/engine/engine.ts';
import { leaderboard, matchStats, sourceOf, type Leaderboard, type MatchSummary, type Source } from '../shared/stats.ts';

export const DATA_DIR = process.env.JEV_FIGHTER_DATA_DIR ?? join(process.cwd(), 'data');
const REPLAYS = () => join(DATA_DIR, 'replays');
const MATCHES = () => join(DATA_DIR, 'matches.jsonl');
const file = (id: string) => join(REPLAYS(), `${id}.fight.json.gz`);

export const isCustom = (model: string) => model.startsWith('custom:');
/** Every person at a keyboard plays as this one id. */
export const HUMAN = 'human';

/** The largest replay kept, compressed. Real ones are 15-150 KB. */
export const MAX_REPLAY_BYTES = 400 * 1024;
/** Community replays kept; beyond this the oldest go. Official ones are never pruned. */
export const MAX_COMMUNITY = Number(process.env.JEV_FIGHTER_MAX_COMMUNITY ?? 20_000);

export const isReplayId = (id: string) => /^[a-z0-9-]{8,64}$/.test(id);

export function newReplayId(): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${ts}-${randomBytes(4).toString('hex')}`;
}

/** Only the fields a replay has, so nothing else rides along into storage. */
function clean(r: Replay): Replay {
  const { format, engineVersion, seed, mode, track, rules, deadlineMs, fighters, createdAt, ticks, costUsd, decisions, cancellations, checkpoints, result } = r;
  return { format, engineVersion, seed, mode, track, rules, deadlineMs, fighters, createdAt, ticks, costUsd, decisions, cancellations, checkpoints, result };
}

export class TooLarge extends Error {}

/**
 * Official matches come from our own runs (the bench, the samples, an admin upload); community
 * matches from the site. Only official ones make the default leaderboard.
 */
export async function saveReplay(r: Replay, id = newReplayId(), opts: { source?: Source } = {}): Promise<MatchSummary> {
  const source = opts.source ?? 'official';
  const bytes = await encodeReplay(clean(r));
  if (bytes.length > MAX_REPLAY_BYTES) throw new TooLarge(`replay too large (${Math.round(bytes.length / 1024)} KB, the limit is ${MAX_REPLAY_BYTES / 1024} KB)`);
  await mkdir(REPLAYS(), { recursive: true });
  await writeFile(file(id), bytes);
  const summary: MatchSummary = {
    id,
    source,
    mode: r.mode,
    track: r.track ?? 'assisted',
    engineVersion: r.engineVersion,
    left: r.fighters[0].model,
    right: r.fighters[1].model,
    winner: r.result.winner,
    createdAt: r.createdAt,
    stats: matchStats(r),
  };
  await appendFile(MATCHES(), `${JSON.stringify(summary)}\n`);
  if (source === 'community') await pruneCommunity();
  return summary;
}

/** Deletes replays and their summaries. Returns the ids that existed. */
export async function deleteReplays(ids: string[]): Promise<string[]> {
  const gone: string[] = [];
  for (const id of ids) {
    if (!isReplayId(id)) continue;
    try {
      await rm(file(id));
      gone.push(id);
    } catch {
      // not there
    }
  }
  if (gone.length) await rewriteSummaries((s) => !gone.includes(s.id));
  return gone;
}

/** Keeps matches.jsonl to the summaries that pass `keep`, replacing the file in one step. */
async function rewriteSummaries(keep: (s: MatchSummary) => boolean): Promise<void> {
  const kept = (await readSummaries()).filter(keep);
  const tmp = `${MATCHES()}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, kept.map((s) => `${JSON.stringify(s)}\n`).join(''));
  await rename(tmp, MATCHES());
}

async function pruneCommunity(max = MAX_COMMUNITY): Promise<void> {
  const community = (await listSummaries()).filter((s) => sourceOf(s) === 'community');
  if (community.length <= max) return;
  community.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  await deleteReplays(community.slice(0, community.length - max).map((s) => s.id));
}

/** Replays shipped with the repo (samples/), so a fresh clone or deploy has fights to watch. */
export const SAMPLES_DIR = join(process.cwd(), 'samples');

/** Copies the sample replays in when there are no replays yet. Returns how many it added. */
export async function seedSamples(from = SAMPLES_DIR): Promise<number> {
  if ((await readdir(REPLAYS()).catch(() => [])).some((f) => f.endsWith('.fight.json.gz'))) return 0;
  const files = (await readdir(from).catch(() => [])).filter((f) => f.endsWith('.fight.json.gz')).sort();
  for (const f of files) await saveReplay(await decodeReplay(await readFile(join(from, f))), f.replace('.fight.json.gz', ''), { source: 'official' });
  return files.length;
}

export async function loadReplayBytes(id: string): Promise<Buffer | null> {
  if (!isReplayId(id)) return null;
  try {
    return await readFile(file(id));
  } catch {
    return null;
  }
}

export async function loadReplay(id: string): Promise<Replay | null> {
  const b = await loadReplayBytes(id);
  return b ? decodeReplay(b) : null;
}

async function readSummaries(): Promise<MatchSummary[]> {
  let text = '';
  try {
    text = await readFile(MATCHES(), 'utf8');
  } catch {
    return [];
  }
  const out: MatchSummary[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as MatchSummary);
    } catch {
      // skip a torn line
    }
  }
  return out;
}

export async function listSummaries(): Promise<MatchSummary[]> {
  // Only summaries whose replay file still exists.
  const have = new Set((await readdir(REPLAYS()).catch(() => [])).map((f) => f.replace('.fight.json.gz', '')));
  return (await readSummaries()).filter((s) => have.has(s.id));
}

/**
 * Leaderboard of matches on the current engine for one mode and track: official matches only, or
 * with the community's too (which anyone can save, so they cannot be checked).
 */
export async function leaderboardFor(mode: 'realtime' | 'paused', track: 'assisted' | 'raw' = 'assisted', withCommunity = false): Promise<Leaderboard> {
  return leaderboard(
    (await listSummaries()).filter(
      (s) => s.mode === mode && (s.track ?? 'assisted') === track && s.engineVersion === ENGINE_VERSION && (withCommunity || sourceOf(s) === 'official'),
    ),
  );
}
