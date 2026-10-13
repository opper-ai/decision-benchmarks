import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { gameMount, mountedUrl, normalizeBasePath } from '../shared/base-path.ts';
import type { GameServer } from '../shared/game.ts';
import type { PoolAccess } from './decide.ts';
import { authConfigFromEnv, createAuthMiddleware, createGameMiddleware, poolAccessFromEnv, type Middleware } from './routes.ts';

export type Log = (event: string, details?: Record<string, unknown>) => void;

/** A game the service mounts: its server side, and its `vite build` output (dist/<slug>). */
export interface MountedGame {
  server: GameServer;
  distDir: string;
}

export interface AppOptions {
  env: Record<string, string | undefined>;
  /** The games, each at <APP_BASE_PATH>/<slug>/. */
  games: readonly MountedGame[];
  /** The deployed Git commit (SOURCE_COMMIT, set at image build time). */
  commit: string;
  log?: Log;
  /** How long to keep serving after SIGTERM while health checks and the load balancer withdraw this container. */
  drainMs?: number;
  /** Hard limit from SIGTERM to exit; below ECS's 30 s stopTimeout, so the process exits before SIGKILL. */
  deadlineMs?: number;
  /** The free credits for every game (null: none); by default from OPPER_POOL_API_KEY. Tests pass their own. */
  poolAccess?: PoolAccess | null;
}

export interface App {
  listen(port: number, host?: string): Promise<number>;
  /** Withdraw readiness, keep serving for `drainMs`, then close and wait for in-flight requests. */
  shutdown(): Promise<'clean' | 'deadline'>;
  /** Immediate close, for tests. */
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

/**
 * An SVG opened on its own (not as an <img>) runs no script and loads nothing: a game's SVG is only ever a picture.
 * The inline styles keep it drawing as it should.
 */
export const SVG_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/** The SHA-256 sources of a page's inline scripts (`<script>` without src), for its script-src. */
export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(m[1]!)) continue;
    hashes.add(`'sha256-${createHash('sha256').update(m[2]!, 'utf8').digest('base64')}'`);
  }
  return [...hashes];
}

/**
 * The Content-Security-Policy for one of the games' pages. Scripts: the page's own files, Plausible's script and the
 * page's two inline scripts (the theme and Plausible's queue), by hash, so a script injected into the page doesn't run.
 * Styles: the page's files, plus inline styles (the opper.ai header and footer copies carry style attributes, and the
 * games set some). Images: the page's own, data and blob URLs, and opper.ai's (the icons, the backgrounds and the
 * footer's compliance badges). Data (the game's JSON, sounds, /api/*, Plausible's events): this origin only. Video
 * export (fighter) runs mediabunny's workers from blob URLs and previews the clip from one. Sign-in leaves the page by
 * navigation (<base>/auth/login, then Opper), which CSP does not limit.
 */
export function htmlCsp(html: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${inlineScriptHashes(html).join(' ')}`.trimEnd(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://opper.ai",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** After SIGTERM: keep serving this long so the load balancer stops sending traffic, then wait for open requests. */
export const SHUTDOWN_DRAIN_MS = 5000;
/** Then give up on open requests, inside ECS's 30 s stopTimeout. */
export const SHUTDOWN_DEADLINE_MS = 25_000;

/**
 * The production service: every game at <APP_BASE_PATH>/<slug>/ (its built page and files, /api/me, /api/decide,
 * /api/warm, /api/highscores), with one Login with Opper at <APP_BASE_PATH>/auth/* (one session for every game), one
 * free-credits pool and one visitor limiter for all of them. The
 * bare `<base>/<slug>` redirects to `<base>/<slug>/`, an unknown slug is 404, and a game's files are only served
 * below its own slug. /health answers at the root (for the load balancer) and below the base path, as does /revision.
 */
export function createApp(opts: AppOptions): App {
  const log: Log = opts.log ?? ((event, details = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...details })));
  const drainMs = opts.drainMs ?? SHUTDOWN_DRAIN_MS;
  const deadlineMs = opts.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  const basePath = normalizeBasePath(opts.env.APP_BASE_PATH);
  const env = Object.fromEntries(Object.entries(opts.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
  const logger = (slug: string) => ({
    info: (msg: string) => log('game', { game: slug, msg }),
    warn: (msg: string) => log('warn', { game: slug, msg }),
    error: (msg: string) => log('error', { game: slug, msg }),
  });
  // One sign-in for every game: one config (one session secret, also when it is a random dev one), checked up front so
  // a misconfigured image refuses to start even with no games.
  const auth = authConfigFromEnv(env, (msg) => log('warn', { msg }));
  const authRoutes = createAuthMiddleware(auth, { warn: (msg) => log('warn', { msg }) });
  // One pool and one limiter, shared by every game: a visitor's allowance does not grow with the number of games.
  const poolAccess = opts.poolAccess !== undefined ? opts.poolAccess : (poolAccessFromEnv(env, (msg) => log('warn', { msg })) ?? null);
  if (poolAccess) log('pool', { msg: 'free credits on: signed-out visitors play on OPPER_POOL_API_KEY until its balance runs out' });
  const games = new Map<string, { root: string; routes: Middleware }>();
  for (const g of opts.games) {
    if (games.has(g.server.slug)) throw new Error(`two games are called ${g.server.slug}`);
    if (g.server.slug === 'auth') throw new Error('no game can be called auth: <APP_BASE_PATH>/auth/ is the sign-in');
    games.set(g.server.slug, { root: resolve(g.distDir), routes: createGameMiddleware(g.server, env, logger(g.server.slug), { poolAccess, auth }) });
  }
  let ready = false;
  let draining = false;
  let shutdownPromise: Promise<'clean' | 'deadline'> | null = null;

  const sendJson = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    res.end(JSON.stringify(body));
  };

  async function serveStatic(root: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', ...SECURITY_HEADERS });
      res.end();
      return;
    }
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://game').pathname);
    } catch {
      return notFound(res);
    }
    // Hidden files and folders (.env, .git, .secret.txt) are never served.
    if (path.split('/').some((seg) => seg.startsWith('.'))) return notFound(res);
    if (path.endsWith('/')) path += 'index.html';
    else if (!extname(path)) path += '.html'; // clean URLs: /leaderboard serves leaderboard.html
    const file = resolve(join(root, path));
    if (!file.startsWith(root + sep)) return notFound(res);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return notFound(res);
    const hashed = path.startsWith('/assets/');
    const ext = extname(file);
    // A page is read whole (a few tens of KB) for the hashes of its inline scripts, once per version of the file.
    const page = ext === '.html' ? await readPage(file, info) : null;
    res.writeHead(200, {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': page ? page.body.length : info.size,
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...SECURITY_HEADERS,
      ...(page ? { 'Content-Security-Policy': page.csp } : ext === '.svg' ? { 'Content-Security-Policy': SVG_CSP } : {}),
    });
    if (req.method === 'HEAD') return void res.end();
    if (page) return void res.end(page.body);
    createReadStream(file).pipe(res);
  }

  const pages = new Map<string, { version: string; body: Buffer; csp: string }>();
  async function readPage(file: string, info: { mtimeMs: number; size: number }): Promise<{ body: Buffer; csp: string }> {
    const version = `${info.mtimeMs}:${info.size}`;
    const known = pages.get(file);
    if (known?.version === version) return known;
    const body = await readFile(file);
    const page = { version, body, csp: htmlCsp(body.toString('utf8')) };
    pages.set(file, page);
    return page;
  }

  function notFound(res: http.ServerResponse): void {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end('Not found');
  }

  const health = (res: http.ServerResponse) => {
    const healthy = ready && !draining;
    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end(healthy ? 'ready' : 'not ready');
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    // The load balancer checks /health at the root, whatever the base path.
    if (url.split('?')[0] === '/health') return health(res);
    const mounted = mountedUrl(url, basePath);
    // The bare base path is the hub page on the website (the load balancer sends it there), not ours: never redirect
    // it to the slashed form, which comes back here.
    if (mounted.kind === 'bare') return notFound(res);
    if (mounted.kind === 'outside') return notFound(res);
    const inside = mounted.url;
    const path = inside.split('?')[0];
    // `<base>/` would reach this service (the load balancer's `<base>/*` matches it): send it to the hub at `<base>`.
    if (path === '/' && basePath) {
      const q = inside.indexOf('?');
      res.writeHead(308, { Location: `${basePath}${q === -1 ? '' : inside.slice(q)}`, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      res.end();
      return;
    }
    if (path === '/health') return health(res);
    if (path === '/revision') return sendJson(res, 200, { app: 'decision-benchmarks', commit: opts.commit, draining, games: [...games.keys()] });
    if (path.startsWith('/auth/')) {
      req.url = inside;
      return authRoutes(req, res, () => notFound(res));
    }
    const at = gameMount(inside);
    const game = at.kind === 'none' ? undefined : games.get(at.slug);
    if (!game) return notFound(res);
    if (at.kind === 'bare') {
      res.writeHead(308, { Location: `${basePath}/${at.slug}/${at.query}`, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      res.end();
      return;
    }
    if (at.kind !== 'game') return notFound(res);
    req.url = at.url;
    game.routes(req, res, () => {
      serveStatic(game.root, req, res).catch((err) => {
        log('error', { msg: `static: ${(err as Error)?.message ?? String(err)}` });
        if (!res.headersSent) notFound(res);
        else res.destroy();
      });
    });
  });

  return {
    listen(port, host = '0.0.0.0') {
      return new Promise((done, fail) => {
        server.once('error', fail);
        server.listen(port, host, () => {
          const actual = (server.address() as AddressInfo).port;
          log('listening', { port: actual, commit: opts.commit, games: [...games.keys()], ...(basePath ? { basePath } : {}) });
          ready = true;
          log('ready');
          done(actual);
        });
      });
    },
    shutdown() {
      shutdownPromise ??= new Promise((done) => {
        draining = true;
        log('draining', { drainMs, deadlineMs });
        const deadline = setTimeout(() => {
          log('shutdown-deadline');
          done('deadline');
        }, deadlineMs);
        deadline.unref();
        setTimeout(() => {
          log('listener-close');
          server.close(() => {
            clearTimeout(deadline);
            log('shutdown-complete');
            done('clean');
          });
          server.closeIdleConnections();
        }, drainMs);
      });
      return shutdownPromise;
    },
    close() {
      return new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
        if (!server.listening) done();
      });
    },
  };
}
