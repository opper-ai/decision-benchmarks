// npm run build [-- <slug> ...]: builds every game in games/registry.ts (or the slugs named, fixtures included) into
// dist/<slug>: replays its submissions into community.json, runs Vite with GAME=<slug>, then sets game.json's
// updatedAt from the newest results: the official run's generatedAt, or a newer accepted submission's recordedAt.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findGame, REGISTRY } from '../games/registry.ts';
import { updatedAt } from '../packages/kit/bench/submissions.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const slugs = process.argv.slice(2).length ? process.argv.slice(2) : REGISTRY.map((g) => g.slug);
for (const slug of slugs) {
  if (!findGame(slug)) {
    console.error(`${slug} is no game here`);
    process.exit(1);
  }
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, GAME: slug } });
    if (r.status !== 0) process.exit(r.status ?? 1);
  };
  console.log(`\n=== ${slug}`);
  run(['scripts/submissions.ts', '--game', slug]);
  run(['node_modules/vite/bin/vite.js', 'build']);
  const dist = `${root}dist/${slug}`;
  if (existsSync(`${dist}/game.json`)) {
    const info = JSON.parse(readFileSync(`${dist}/game.json`, 'utf8')) as { updatedAt?: string };
    const json = (file: string): unknown => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
    // Only the submissions on community.json count: a refused or outdated one never moves the date.
    const at = updatedAt(json(`${dist}/leaderboard.json`), json(`${dist}/community.json`), `${root}games/${slug}/submissions`);
    if (at) info.updatedAt = at;
    writeFileSync(`${dist}/game.json`, `${JSON.stringify(info, null, 2)}\n`);
  }
}
if (!slugs.length) console.log('no games in games/registry.ts yet: nothing to build');
