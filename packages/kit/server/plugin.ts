import type { Plugin } from 'vite';
import { mountAt } from '../shared/base-path.ts';
import type { GameServer } from '../shared/game.ts';
import { authConfigFromEnv, createAuthMiddleware, createGameMiddleware, gamePath } from './routes.ts';

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
 * Mounts Login with Opper at <APP_BASE_PATH>/auth/* and one game's routes (/api/me, /api/decide, /api/warm,
 * /api/highscores) at <APP_BASE_PATH>/<slug> on the Vite dev and preview servers, as the production service does.
 * Without APP_BASE_PATH the sign-in is at /auth/*, so local dev needs one redirect URI:
 * http://localhost:5173/auth/callback.
 */
export function gamePlugin(env: Record<string, string | undefined>, game: GameServer, opts: { quiet?: boolean; pages?: readonly string[] } = {}): Plugin {
  const base = gamePath(env, game.slug);
  const clean = (req: { url?: string }, res: unknown, next: () => void) => cleanUrls(req, res, next, base, opts.pages ?? []);
  const mount = (logger: { info(m: string): void; warn(m: string): void; error(m: string): void }) => {
    // One config for both, so the game's /api/me opens the session the sign-in sealed.
    const auth = authConfigFromEnv(env, (m) => logger.warn(m));
    return { auth: mountAt(gamePath(env), createAuthMiddleware(auth, logger)), game: mountAt(base, createGameMiddleware(game, env, logger, { quiet: opts.quiet, auth })) };
  };
  return {
    name: 'decision-benchmarks-game',
    configureServer(server) {
      const m = mount(server.config.logger);
      server.middlewares.use(m.auth);
      server.middlewares.use(m.game);
      server.middlewares.use(clean);
    },
    configurePreviewServer(server) {
      const m = mount(server.config.logger);
      server.middlewares.use(m.auth);
      server.middlewares.use(m.game);
      server.middlewares.use(clean);
    },
  };
}
