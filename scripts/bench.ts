// npm run bench -- --game <slug> [...]: the kit's bench (packages/kit/bench/bench.ts) on one game.
import { fileURLToPath } from 'node:url';
import { BenchError, runBench } from '../packages/kit/bench/bench.ts';
import { gameArg } from './game-arg.ts';

const { slug, game } = await gameArg(process.argv.slice(2));
try {
  await runBench(await game.definition(), process.argv.slice(2), process.env, { publicDir: fileURLToPath(new URL(`../games/${slug}/public`, import.meta.url)) });
} catch (err) {
  if (!(err instanceof BenchError)) throw err;
  console.error(err.message);
  process.exit(1);
}
