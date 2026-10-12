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
];

/**
 * Games the kit knows but does not serve: Pac-Man (jevman) is the kit's real-time test fixture, live in its own repo
 * at opper.ai/jevman-benchmark. Scripts take them with --game; the service mounts one only when GAMES names it.
 */
export const FIXTURES: readonly RegisteredGame[] = [
  {
    slug: 'pacman',
    server: () => import('./pacman/game.server.ts').then((m) => m.default),
    definition: () => import('./pacman/game.ts').then((m) => m.default as unknown as GameDefinition<unknown, GameResult>),
  },
];

/** A registered game or fixture by slug. */
export const findGame = (slug: string): RegisteredGame | undefined => [...REGISTRY, ...FIXTURES].find((g) => g.slug === slug);

/**
 * The games to serve: the registry, or the comma-separated slugs in `names` (GAMES), which may name fixtures (local
 * runs). An unknown slug throws, so a typo fails at startup.
 */
export function gamesToServe(names: string | undefined): RegisteredGame[] {
  const list = (names ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return [...REGISTRY];
  return list.map((slug) => findGame(slug) ?? fail(`GAMES names ${slug}, which is no game here; one of: ${[...REGISTRY, ...FIXTURES].map((g) => g.slug).join(', ')}`));
}

function fail(msg: string): never {
  throw new Error(msg);
}
