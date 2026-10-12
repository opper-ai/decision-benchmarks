// npm run submissions -- --game <slug> [--out <file>]: replays every games/<slug>/submissions/<id>/ with the game's
// own code and writes games/<slug>/public/community.json. Fails (for CI) when any submission is refused.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkSubmissions } from '../packages/kit/bench/submissions.ts';
import { gameArg } from './game-arg.ts';

const { values } = parseArgs({ options: { game: { type: 'string' }, out: { type: 'string' }, dir: { type: 'string' } } });
const { slug, game } = await gameArg(process.argv.slice(2));
const root = values.dir ?? fileURLToPath(new URL(`../games/${slug}/submissions`, import.meta.url));
const out = values.out ?? fileURLToPath(new URL(`../games/${slug}/public/community.json`, import.meta.url));
// The game's own official board, wherever --dir points: a submission may not take a name or id on it.
const leaderboard = fileURLToPath(new URL(`../games/${slug}/public/leaderboard.json`, import.meta.url));
const { community, refused } = checkSubmissions(await game.definition(), root, console.log, { leaderboard });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(community, null, 2)}\n`);
console.log(`wrote ${community.entries.length} self-reported ${community.entries.length === 1 ? 'entry' : 'entries'} to ${out}`);
if (refused.length) process.exit(1);
