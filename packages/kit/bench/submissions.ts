// Checks every submission of a game and writes its community.json (the self-reported results).
// Entry point: scripts/submissions.ts (npm run submissions -- --game <slug>).
// Each games/<slug>/submissions/<id>/ holds submission.json and game-NN.json.gz recordings written by bench --submit.
// Every game is replayed with the game's own verify, on the seed its number fixes; a submission on the current bench
// version that breaks a rule or does not replay fails the run (and CI). Submissions recorded on an older bench version
// are left out with a note: their games were a different benchmark.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Community, CommunityEntry, Entry } from '../shared/contract.ts';
import type { GameDefinition, GameResult } from '../shared/game.ts';
import { DECISION_MODELS } from '../shared/models.ts';
import { SUBMISSION_ID } from './bench.ts';
import { boardFor, entryFor } from './results.ts';

interface Manifest {
  name: string;
  by: string;
  url?: string;
  via?: Entry['via'];
  benchVersion: number;
  games: number;
  recordedAt: string;
}

/** An unpacked recording may be this many times its gzipped size cap. */
export const UNPACKED_FACTOR = 8;

/** How far in the future a recordedAt may be (clock skew). */
const CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/** The official leaderboard of the game whose submissions are in `root` (games/<slug>/submissions). */
export const officialBoardPath = (submissionsRoot: string): string => join(submissionsRoot, '..', 'public', 'leaderboard.json');

/**
 * The names and ids (lowercase) a submission may not take: every entry's name and model on the game's own official
 * leaderboard (its names may differ from the kit's), the kit's model list, and the game's baselines.
 */
export function reservedNames(game: GameDefinition<unknown, GameResult>, leaderboardPath?: string): Set<string> {
  const reserved = new Set<string>();
  const add = (s: unknown) => {
    if (typeof s === 'string' && s.trim()) reserved.add(s.trim().toLowerCase());
  };
  for (const m of DECISION_MODELS) {
    add(m.id);
    add(m.name);
  }
  for (const [name, b] of Object.entries(game.baselines ?? {})) {
    add(name);
    add(`baseline/${name}`);
    add(b.name);
  }
  if (leaderboardPath && existsSync(leaderboardPath)) {
    const board = JSON.parse(readFileSync(leaderboardPath, 'utf8')) as { entries?: unknown };
    for (const e of Array.isArray(board?.entries) ? (board.entries as { model?: unknown; name?: unknown }[]) : []) {
      add(e?.model);
      add(e?.name);
    }
  }
  return reserved;
}

/** A submission's entry and its games' fingerprints (fingerprint to file), or why it was refused (`outdated` ones are left out without failing). */
export type Checked = { entry: CommunityEntry; fingerprints: Map<string, string> } | { error: string; outdated?: boolean };

/**
 * A submission's entry, or why it was refused. `reserved` holds the names and ids it may not take (reservedNames); by
 * default the game's official leaderboard is found from the folder (games/<slug>/submissions/<id>).
 */
export function checkSubmission(game: GameDefinition<unknown, GameResult>, dir: string, id: string, reserved: Set<string> = reservedNames(game, officialBoardPath(join(dir, '..')))): Checked {
  if (!SUBMISSION_ID.test(id)) return { error: 'the folder name is the model id: lowercase letters, digits and dashes' };
  const manifestPath = join(dir, 'submission.json');
  if (!existsSync(manifestPath)) return { error: 'no submission.json' };
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  } catch (err) {
    return { error: `submission.json: ${(err as Error).message}` };
  }
  if (!manifest || typeof manifest !== 'object') return { error: 'submission.json must be an object' };
  // Plain printable text: no control or direction-changing characters in a name shown on a leaderboard.
  if (typeof manifest.name !== 'string' || !/^[\p{L}\p{N}\p{P}\p{Zs}\p{S}]{1,40}$/u.test(manifest.name) || !manifest.name.trim()) return { error: 'name must be 1 to 40 printable characters' };
  if (typeof manifest.by !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(manifest.by)) return { error: 'by must be a GitHub handle' };
  if (manifest.url !== undefined && (typeof manifest.url !== 'string' || !/^https:\/\/\S+$/.test(manifest.url))) return { error: 'url must start with https://' };
  if (manifest.via !== undefined && manifest.via !== 'systemone' && manifest.via !== 'chat-adapter') return { error: 'via must be systemone or chat-adapter' };
  // A submitted model must not pass for one we benchmark ourselves, under the kit's name or the game's.
  if (reserved.has(manifest.name.trim().toLowerCase())) return { error: `${manifest.name} is on the official leaderboard already` };
  if (reserved.has(id.toLowerCase())) return { error: `${id} is on the official leaderboard already` };
  // When it was recorded: game.json's updatedAt comes from it, so only a real, past date passes.
  const at = manifest.recordedAt;
  if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(at) || Number.isNaN(Date.parse(at))) return { error: 'recordedAt must be an ISO date (as bench --submit writes it)' };
  if (Date.parse(at) > Date.now() + CLOCK_SKEW_MS) return { error: `recordedAt ${at} is in the future` };
  const v = manifest.benchVersion;
  // Only a real older version is left out quietly; anything else is checked as a mistake.
  if (Number.isInteger(v) && v >= 1 && v < game.benchVersion) return { error: `recorded on bench version ${v}, the current one is ${game.benchVersion}: re-run it`, outdated: true };
  if (v !== game.benchVersion) return { error: `benchVersion must be ${game.benchVersion}` };

  const files = readdirSync(dir).filter((f) => /^game-\d+\.json\.gz$/.test(f));
  const numbers = files.map((f) => Number(/^game-(\d+)/.exec(f)![1])).sort((a, b) => a - b);
  if (files.length < game.rules.minGames) return { error: `${files.length} games; a submission needs at least ${game.rules.minGames}` };
  if (files.length !== manifest.games) return { error: `submission.json says ${manifest.games} games, the folder has ${files.length}` };
  // Game n plays seed seedFor(n - 1): the games are the first n of the fixed list, none skipped or picked.
  if (numbers.some((n, i) => n !== i + 1)) return { error: `the games must be game-01 to game-${String(files.length).padStart(2, '0')}, each once` };
  const results: GameResult[] = [];
  const seen = new Map<string, string>();
  for (const n of numbers) {
    const file = files.find((f) => Number(/^game-(\d+)/.exec(f)![1]) === n)!;
    const path = join(dir, file);
    if (statSync(path).size > game.rules.maxRecordingBytes) return { error: `${file} is larger than a recorded game` };
    let rec: unknown;
    try {
      rec = JSON.parse(gunzipSync(readFileSync(path), { maxOutputLength: game.rules.maxRecordingBytes * UNPACKED_FACTOR }).toString('utf8'));
    } catch (err) {
      return { error: `${file}: ${(err as Error).message}` };
    }
    let verdict: ReturnType<typeof game.verify>;
    try {
      verdict = game.verify(rec, { seed: game.rules.seedFor(n - 1) });
    } catch (err) {
      return { error: `${file}: the game could not be replayed: ${(err as Error).message}` };
    }
    if (!verdict.ok) return { error: `${file}: ${verdict.error}` };
    // The same game sent twice, however its timings were changed.
    const twin = seen.get(verdict.fingerprint);
    if (twin) return { error: `${file} is the same game as ${twin}` };
    seen.set(verdict.fingerprint, file);
    results.push(verdict.result);
  }
  const entry: CommunityEntry = {
    ...entryFor(game, id, manifest.name.trim(), results, manifest.via ?? 'systemone'),
    by: manifest.by,
    ...(manifest.url ? { url: manifest.url } : {}),
    selfReported: true,
  };
  return { entry, fingerprints: seen };
}

/** Every submission of a game: the community board, and the folders that were refused (with why). */
export function checkSubmissions(
  game: GameDefinition<unknown, GameResult>,
  root: string,
  log: (line: string) => void = console.log,
  opts: { leaderboard?: string } = {},
): { community: Community; refused: { id: string; error: string }[] } {
  const ids = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
  const reserved = reservedNames(game, opts.leaderboard ?? officialBoardPath(root));
  const entries: CommunityEntry[] = [];
  const skipped: Community['skipped'] = [];
  const refused: { id: string; error: string }[] = [];
  // Every accepted game, across submissions: a copy of another submission's game is refused (the later folder, by name).
  const owners = new Map<string, string>();
  for (const id of ids) {
    const checked = checkSubmission(game, join(root, id), id, reserved);
    const copied = 'entry' in checked ? [...checked.fingerprints].find(([f]) => owners.has(f)) : undefined;
    if ('entry' in checked && entries.some((e) => e.name.toLowerCase() === checked.entry.name.toLowerCase())) {
      refused.push({ id, error: `another submission is called ${checked.entry.name}` });
    } else if (copied) {
      refused.push({ id, error: `${copied[1]} is the same game as ${owners.get(copied[0])}` });
    } else if ('entry' in checked) {
      for (const [f, file] of checked.fingerprints) owners.set(f, `${id}/${file}`);
      const e = checked.entry;
      log(`${id}: ok, ${e.games} games, mean ${e.metric.mean} ± ${Math.round(200 * e.metric.stdError) / 100}`);
      entries.push(e);
    } else if (checked.outdated) {
      log(`${id}: left out, ${checked.error}`);
      skipped.push({ model: id, reason: checked.error });
    } else refused.push({ id, error: checked.error });
  }
  for (const r of refused) log(`${r.id}: REFUSED, ${r.error}`);
  return { community: boardFor(game, entries, skipped), refused };
}

/**
 * game.json's updatedAt: the newest of the official run's generatedAt and the recordedAt of each submission on the
 * community board (accepted ones only, whose dates checkSubmission checked). Undefined when there is neither.
 */
export function updatedAt(leaderboard: unknown, community: unknown, submissionsRoot: string): string | undefined {
  const dates: string[] = [];
  const generatedAt = (leaderboard as { generatedAt?: unknown } | null)?.generatedAt;
  if (typeof generatedAt === 'string') dates.push(generatedAt);
  const entries = (community as { entries?: unknown } | null)?.entries;
  for (const e of Array.isArray(entries) ? (entries as { model?: unknown }[]) : []) {
    if (typeof e?.model !== 'string' || !SUBMISSION_ID.test(e.model)) continue;
    const manifest = join(submissionsRoot, e.model, 'submission.json');
    if (existsSync(manifest)) dates.push((JSON.parse(readFileSync(manifest, 'utf8')) as Manifest).recordedAt);
  }
  const valid = dates.filter((d) => typeof d === 'string' && !Number.isNaN(Date.parse(d)));
  return valid.length ? valid.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : undefined;
}
