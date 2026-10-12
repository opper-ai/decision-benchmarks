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
}

/** An unpacked recording may be this many times its gzipped size cap. */
export const UNPACKED_FACTOR = 8;

export type Checked = { entry: CommunityEntry } | { error: string; outdated?: boolean };

/** A submission's entry, or why it was refused (`outdated` ones are left out without failing). */
export function checkSubmission(game: GameDefinition<unknown, GameResult>, dir: string, id: string): Checked {
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
  // A submitted model must not pass for one we benchmark ourselves.
  if (DECISION_MODELS.some((m) => m.id === id || m.name.toLowerCase() === manifest.name.trim().toLowerCase())) return { error: `${manifest.name} is on the official leaderboard already` };
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
  return { entry };
}

/** Every submission of a game: the community board, and the folders that were refused (with why). */
export function checkSubmissions(game: GameDefinition<unknown, GameResult>, root: string, log: (line: string) => void = console.log): { community: Community; refused: { id: string; error: string }[] } {
  const ids = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
  const entries: CommunityEntry[] = [];
  const skipped: Community['skipped'] = [];
  const refused: { id: string; error: string }[] = [];
  for (const id of ids) {
    const checked = checkSubmission(game, join(root, id), id);
    if ('entry' in checked && entries.some((e) => e.name.toLowerCase() === checked.entry.name.toLowerCase())) {
      refused.push({ id, error: `another submission is called ${checked.entry.name}` });
    } else if ('entry' in checked) {
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
