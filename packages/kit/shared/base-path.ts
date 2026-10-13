// Serving the games below a path prefix (APP_BASE_PATH), e.g. https://opper.ai/decision-benchmarks/, and each game
// below its slug, e.g. https://opper.ai/decision-benchmarks/snake/. The proxies in front forward the full path, so the
// server removes the prefixes itself. Isomorphic (the Vite config and the server both use it).

/**
 * APP_BASE_PATH normalised: '' (served at the root, the default) or `/segment[/segment…]` without a trailing slash.
 * Throws for anything that is not a plain path, so a typo fails at startup instead of serving nothing.
 */
export function normalizeBasePath(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const segments = path.split('/').slice(1);
  if (!segments.every((s) => /^[A-Za-z0-9._~-]+$/.test(s) && s !== '.' && s !== '..')) {
    throw new Error(`APP_BASE_PATH must be a path like /decision-benchmarks, got ${JSON.stringify(raw)}`);
  }
  return path;
}

export type Mounted =
  /** Below the prefix: `url` is the request URL with the prefix removed (always starts with '/'). */
  | { kind: 'inside'; url: string }
  /** Exactly the prefix (`/decision-benchmarks`, maybe with a query): redirect to `location`, the same with a slash. */
  | { kind: 'bare'; location: string }
  /** Anywhere else on the host. */
  | { kind: 'outside' };

/** Where a request URL falls relative to the base path. With no base path everything is inside, unchanged. */
export function mountedUrl(url: string, base: string): Mounted {
  if (!base) return { kind: 'inside', url };
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const query = q === -1 ? '' : url.slice(q);
  if (path === base) return { kind: 'bare', location: `${base}/${query}` };
  if (path.startsWith(`${base}/`)) return { kind: 'inside', url: url.slice(base.length) };
  return { kind: 'outside' };
}

type Next = () => void;
type Handler<Req extends { url?: string }, Res> = (req: Req, res: Res, next: Next) => void;

/**
 * Connect-style mount, for the Vite dev and preview servers: the handler sees URLs without the prefix and requests
 * outside it skip the handler. `req.url` is restored before `next()`, so Vite's own middlewares see the full URL.
 */
export function mountAt<Req extends { url?: string }, Res>(base: string, handler: Handler<Req, Res>): Handler<Req, Res> {
  if (!base) return handler;
  return (req, res, next) => {
    const original = req.url ?? '/';
    const m = mountedUrl(original, base);
    if (m.kind !== 'inside') return next();
    req.url = m.url;
    handler(req, res, () => {
      req.url = original;
      next();
    });
  };
}

/** A game's slug: lowercase letters, digits and dashes. */
export const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export type GameMount =
  /** Below a game's slug: `url` is the rest, starting with '/'. */
  | { kind: 'game'; slug: string; url: string }
  /** Exactly `/<slug>` (maybe with a query): redirect to the same with a slash. */
  | { kind: 'bare'; slug: string; query: string }
  /** Anything else: the root of the base path, or a path that is no slug. */
  | { kind: 'none' };

/**
 * The second level of mounting: which game a URL (already below the base path) is for. Whether the slug is a game the
 * service serves is the caller's question; an unknown one is a 404 there.
 */
export function gameMount(url: string): GameMount {
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const query = q === -1 ? '' : url.slice(q);
  const m = /^\/([^/]+)(\/.*)?$/.exec(path);
  if (!m || !SLUG.test(m[1]!)) return { kind: 'none' };
  if (m[2] === undefined) return { kind: 'bare', slug: m[1]!, query };
  return { kind: 'game', slug: m[1]!, url: `${m[2]}${query}` };
}
