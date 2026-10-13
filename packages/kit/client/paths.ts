// A game is served below its path (APP_BASE_PATH and its slug at build time, e.g. /decision-benchmarks/snake/), so
// every request and link the client makes goes through here instead of starting at the host's root.

/** Vite's `base`: the game's path, e.g. '/decision-benchmarks/snake/'. Always ends with a slash. */
export const BASE_URL: string = import.meta.env.BASE_URL;

/** `path` ('/api/me', '/?model=…', '/leaderboard') below `base` (which ends with a slash). */
export const withBase = (base: string, path: string): string => base + path.replace(/^\/+/, '');

/** An app path below the base path this build was made for. */
export const appPath = (path: string): string => withBase(BASE_URL, path);

/**
 * The service's base path, above every game (`/decision-benchmarks/` for `/decision-benchmarks/snake/`, `/` for the dev
 * server's `/snake/`): where the one Login with Opper lives.
 */
export const serviceBaseOf = (base: string): string => base.replace(/[^/]+\/$/, '');

/** A path below the service's base path, e.g. '/auth/login' -> '/decision-benchmarks/auth/login'. */
export const servicePath = (path: string): string => withBase(serviceBaseOf(BASE_URL), path);

/** The address share links point at: the bare origin at the root (as before), else the app's own address. */
export const shareUrlFor = (base: string, publicUrl: string, appUrl: string): string => (base === '/' ? publicUrl : appUrl);

/** E.g. https://opper.ai/decision-benchmarks/snake/ (VITE_PUBLIC_URL, APP_BASE_PATH and the slug), or just VITE_PUBLIC_URL at the root. */
export const SHARE_URL: string = shareUrlFor(BASE_URL, import.meta.env.VITE_PUBLIC_URL, import.meta.env.VITE_APP_URL);
