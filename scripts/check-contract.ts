// npm run check-contract [-- --game <slug>]: validates the files each game serves to the hub (docs/design.md, "The
// contract with the hub") against packages/kit/shared/contract.ts: game.json, leaderboard.json, community.json and
// poster.png, plus the game's high-score boards. Checks every game in games/registry.ts; each is live, so each needs
// its poster. Run `npm run submissions -- --game <slug>` first for community.json.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { REGISTRY, type RegisteredGame } from '../games/registry.ts';
import { validateCommunity, validateGameInfo, validateLeaderboard, validatePoster, type Metric } from '../packages/kit/shared/contract.ts';

export async function checkGame(g: RegisteredGame, dir: string): Promise<string[]> {
  const problems: string[] = [];
  const read = (file: string): unknown => {
    try {
      return JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
    } catch (err) {
      problems.push(`${file}: ${(err as Error).message}`);
      return undefined;
    }
  };
  if (!existsSync(`${dir}/game.json`)) problems.push('game.json is missing');
  const info = existsSync(`${dir}/game.json`) ? read('game.json') : undefined;
  if (info !== undefined) problems.push(...validateGameInfo(info, g.slug));
  const metric = (info as { metric?: Metric } | undefined)?.metric;
  const definition = await g.definition();
  if (metric && JSON.stringify(metric) !== JSON.stringify(definition.metric)) problems.push("game.json's metric differs from the game's definition");
  for (const [file, validate] of [['leaderboard.json', validateLeaderboard], ['community.json', validateCommunity]] as const) {
    if (!existsSync(`${dir}/${file}`)) continue;
    const board = read(file);
    if (board === undefined) continue;
    problems.push(...validate(board, g.slug));
    if (metric && JSON.stringify((board as { metric?: unknown }).metric) !== JSON.stringify(metric)) problems.push(`${file}: its metric differs from game.json's`);
  }
  if (existsSync(`${dir}/poster.png`)) problems.push(...validatePoster(readFileSync(`${dir}/poster.png`)));
  else problems.push('poster.png is missing');
  const server = await g.server();
  if (server.slug !== g.slug) problems.push(`game.server.ts says slug ${server.slug}`);
  const boards = server.highScores?.boards ?? [];
  if (server.highScores && (!boards.length || new Set(boards.map((b) => b.id)).size !== boards.length)) problems.push('the high-score boards must be listed, each id once');
  return problems;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const { values } = parseArgs({ options: { game: { type: 'string', multiple: true } } });
  const picked = values.game?.length ? REGISTRY.filter((g) => values.game!.includes(g.slug)) : REGISTRY;
  if (values.game?.length && picked.length !== values.game.length) {
    console.error(`unknown game; one of: ${REGISTRY.map((g) => g.slug).join(', ')}`);
    process.exit(1);
  }
  let failed = false;
  for (const g of picked) {
    const problems = await checkGame(g, fileURLToPath(new URL(`../games/${g.slug}/public`, import.meta.url)));
    if (problems.length) {
      failed = true;
      console.error(`${g.slug}: ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
      for (const p of problems) console.error(`  ${p}`);
    } else console.log(`${g.slug}: ok`);
  }
  if (failed) process.exit(1);
}
