// Production entry point: `node server/main.ts` (Node >= 22.18 runs the TypeScript directly). Serves every game in
// games/registry.ts at <APP_BASE_PATH>/<slug>/ from its build in dist/<slug>; GAMES=<slug>,<slug> serves only those
// (e.g. GAMES=snake after npm run build -- snake).
import { fileURLToPath } from 'node:url';
import { createApp } from '../packages/kit/server/app.ts';
import { gamesToServe } from '../games/registry.ts';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a valid port number');

const games = await Promise.all(
  gamesToServe(process.env.GAMES).map(async (g) => ({ server: await g.server(), distDir: fileURLToPath(new URL(`../dist/${g.slug}`, import.meta.url)) })),
);

const app = createApp({ env: process.env, games, commit: process.env.SOURCE_COMMIT || 'local' });

await app.listen(port);

process.once('SIGTERM', () => {
  void app.shutdown().then((outcome) => process.exit(outcome === 'clean' ? 0 : 1));
});
process.once('SIGINT', () => {
  void app.shutdown().then((outcome) => process.exit(outcome === 'clean' ? 0 : 1));
});
