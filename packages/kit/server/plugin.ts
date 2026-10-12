import type { Plugin } from 'vite';
import { mountAt } from '../shared/base-path.ts';
import type { GameServer } from '../shared/game.ts';
import { createGameMiddleware, gamePath } from './routes.ts';

/**
 * The production server's clean URLs for a game's other pages: `<base>/leaderboard` serves `leaderboard.html`.
 * `base` is the game's path ('' at the root), `pages` the page names without .html.
 */
export function cleanUrls(req: { url?: string }, _res: unknown, next: () => void, base: string, pages: readonly string[]): void {
  const [path, query] = (req.url ?? '').split(/(?=\?)/);
  for (const page of pages) if (path === `${base}/${page}`) req.url = `${base}/${page}.html${query ?? ''}`;
  next();
}

/**
 * Mounts one game's routes (Login with Opper, /api/me, /api/decide, /api/warm, /api/highscores) on the Vite dev and
 * preview servers, at <APP_BASE_PATH>/<slug>, as the production service does.
 */
export function gamePlugin(env: Record<string, string | undefined>, game: GameServer, opts: { quiet?: boolean; pages?: readonly string[] } = {}): Plugin {
  const base = gamePath(env, game.slug);
  const clean = (req: { url?: string }, res: unknown, next: () => void) => cleanUrls(req, res, next, base, opts.pages ?? []);
  const mount = (logger: { info(m: string): void; warn(m: string): void; error(m: string): void }) => mountAt(base, createGameMiddleware(game, env, logger, { quiet: opts.quiet }));
  return {
    name: 'decision-benchmarks-game',
    configureServer(server) {
      server.middlewares.use(mount(server.config.logger));
      server.middlewares.use(clean);
    },
    configurePreviewServer(server) {
      server.middlewares.use(mount(server.config.logger));
      server.middlewares.use(clean);
    },
  };
}
