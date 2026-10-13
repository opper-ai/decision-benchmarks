// The games the service serves, the build builds and CI checks: one line each. Loaders are lazy, so a script that
// works on one game only loads that one. Each game.server.ts must be Node-safe (the service runs it as is).
import type { GameDefinition, GameResult, GameServer } from '../packages/kit/shared/game.ts';

export interface RegisteredGame {
  slug: string;
  /** games/<slug>/game.server.ts: what the service needs. */
  server(): Promise<GameServer>;
  /** games/<slug>/game.ts: what the bench and the submissions check need. */
  definition(): Promise<GameDefinition<unknown, GameResult>>;
}

/** Served at <APP_BASE_PATH>/<slug>/. */
export const REGISTRY: readonly RegisteredGame[] = [
  {
    slug: 'snake',
    server: () => import('./snake/game.server.ts').then((m) => m.default),
    definition: () => import('./snake/game.ts').then((m) => m.default as unknown as GameDefinition<unknown, GameResult>),
  },
  {
    slug: 'fighter',
    server: () => import('./fighter/game.server.ts').then((m) => m.default),
    definition: () => import('./fighter/game.ts').then((m) => m.default as unknown as GameDefinition<unknown, GameResult>),
  },
];

/**
 * Games served here once that now live elsewhere on opper.ai: slug -> the path they moved to. Anything below
 * <APP_BASE_PATH>/<slug> redirects there for good, so old links and search engines follow.
 *
 * jevman lives in its own repository (opper-ai/jevman-benchmark) at /jevman-benchmark/, the URL its links point to.
 * The hub lists it there; this repository holds every other game.
 */
export const MOVED: Readonly<Record<string, string>> = { jevman: '/jevman-benchmark/' };

/** A registered game by slug. */
export const findGame = (slug: string): RegisteredGame | undefined => REGISTRY.find((g) => g.slug === slug);

/**
 * The games to serve: the registry, or the comma-separated slugs in `names` (GAMES), a subset of it (local runs). An
 * unknown slug throws, so a typo fails at startup.
 */
export function gamesToServe(names: string | undefined): RegisteredGame[] {
  const list = (names ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return [...REGISTRY];
  return list.map((slug) => findGame(slug) ?? fail(`GAMES names ${slug}, which is no game here; one of: ${REGISTRY.map((g) => g.slug).join(', ')}`));
}

function fail(msg: string): never {
  throw new Error(msg);
}
