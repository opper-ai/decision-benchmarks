import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { crossSite, handleCallback, handleLogin, handleLogout, handleMe, json, loginConfigured, opperExchange, redirect, sessionFrom, type AuthConfig, type HttpRequest, type HttpResponse } from './auth.ts';
import { answerKey, answerVerifier } from './answers.ts';
import { handleDecideRequest, poolLimitRequest, rejectDecideRequest, resolveKey, type DecideContext, type PoolAccess } from './decide.ts';
import { accountHash, cleanInitials, HighScores, highScoresStore, visitorHash } from './highscores.ts';
import { clientIp, MAX_POOL_BODY_BYTES, poolFromEnv, trustedProxiesFromEnv, visitorKey, VisitorLimits } from './pool.ts';
import { issueSeed, seedKey, seedVerifier } from './seeds.ts';
import { devTargetFromEnv, type Target } from './systemone.ts';
import { normalizeBasePath } from '../shared/base-path.ts';
import type { GameServer } from '../shared/game.ts';

/** Largest /api/decide body read for a player or dev key; a game state plus five questions is a few KB. */
export const MAX_BODY_BYTES = 256 * 1024;
/** Largest high-score entry read: a long game's recording (the player's moves and the models' signed answers). */
export const MAX_SCORE_BODY_BYTES = 1536 * 1024;
/** Entries one account (or, signed out, one address) may send an hour, per game. */
const SCORE_ENTRIES_PER_HOUR = 20;
const MAX_LOG_CHARS = 300;

export interface RouteLogger {
  info(msg: string, opts?: { timestamp?: boolean }): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

/** PUBLIC_BASE_URL as a bare origin (`https://opper.ai`), or undefined when unset. */
function publicOriginFromEnv(env: Record<string, string | undefined>): string | undefined {
  const raw = env.PUBLIC_BASE_URL?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`[auth] PUBLIC_BASE_URL must be an origin like https://opper.ai, got ${JSON.stringify(raw)}`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.pathname.replace(/\/+$/, '') || url.search || url.hash) {
    throw new Error(`[auth] PUBLIC_BASE_URL must be an origin like https://opper.ai (the path goes in APP_BASE_PATH), got ${JSON.stringify(raw)}`);
  }
  return url.origin;
}

/** Where a game is mounted: APP_BASE_PATH plus its slug (`/decision-benchmarks/snake`), or the base path alone. */
export const gamePath = (env: Record<string, string | undefined>, slug?: string): string => `${normalizeBasePath(env.APP_BASE_PATH)}${slug ? `/${slug}` : ''}`;

/**
 * Login with Opper's redirect URI for a game: PUBLIC_BASE_URL plus the game's path (one URI per game, each added to
 * the OAuth app), else the Vite dev server's.
 */
export function redirectUriFromEnv(env: Record<string, string | undefined>, path: string): string {
  return `${publicOriginFromEnv(env) ?? 'http://localhost:5173'}${path}/auth/callback`;
}

/**
 * A game's auth settings from the environment. An https redirect URI means a deployment, which needs a real
 * SESSION_SECRET. Without a slug, the settings of the base path itself (the Vite dev server of one game passes it).
 */
export function authConfigFromEnv(env: Record<string, string | undefined>, warn: (msg: string) => void, slug?: string): AuthConfig {
  const clientId = env.OPPER_CLIENT_ID || undefined;
  const clientSecret = env.OPPER_CLIENT_SECRET || undefined;
  const basePath = gamePath(env, slug);
  const publicOrigin = publicOriginFromEnv(env);
  const redirectUri = redirectUriFromEnv(env, basePath);
  // A production image (NODE_ENV=production) is a deployment: without an https PUBLIC_BASE_URL it would run with a
  // localhost callback, insecure cookies and a server key that pays for every visitor, so refuse to start.
  // ALLOW_HTTP=1 opts out (a production build tried locally).
  if (env.NODE_ENV === 'production' && !redirectUri.startsWith('https:') && env.ALLOW_HTTP !== '1') {
    throw new Error('[auth] In production, set PUBLIC_BASE_URL to the https origin the games are served at; ALLOW_HTTP=1 opts out');
  }
  let sessionSecret = env.SESSION_SECRET ?? '';
  if (sessionSecret.length < 32) {
    if (redirectUri.startsWith('https:')) throw new Error('[auth] SESSION_SECRET must be set to at least 32 characters when the redirect URI is https');
    if (clientId && clientSecret) warn('[auth] SESSION_SECRET is missing or shorter than 32 characters, so a random one is used: sign-ins reset on restart');
    sessionSecret = randomBytes(32).toString('hex');
  }
  return {
    clientId,
    clientSecret,
    redirectUri,
    opperUrl: env.OPPER_BASE_URL || 'https://api.opper.ai',
    sessionSecret,
    basePath,
    ...(publicOrigin ? { publicOrigin } : {}),
  };
}

/**
 * The server's own key (TYPESAFE_API_KEY, else OPPER_API_KEY), unless this is a deployment (https redirect URI),
 * where it would pay for every visitor.
 */
export function devKeyFromEnv(env: Record<string, string | undefined>, cfg: AuthConfig, warn: (msg: string) => void): Target | undefined {
  const target = devTargetFromEnv(env);
  if (!target || !cfg.redirectUri.startsWith('https:')) return target;
  const name = target.provider === 'typesafe' ? 'TYPESAFE_API_KEY' : 'OPPER_API_KEY';
  if (env.ALLOW_DEV_KEY !== '1') {
    warn(`[decide] ${name} is ignored because the redirect URI is https: a deployed site must not pay for visitors with a server key. Set ALLOW_DEV_KEY=1 to use it anyway.`);
    return undefined;
  }
  warn(`[decide] ALLOW_DEV_KEY=1: ${name} pays for every signed-out visitor of this https deployment`);
  return target;
}

const toHttp = (req: IncomingMessage): HttpRequest => ({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, remoteAddress: req.socket?.remoteAddress });

function send(res: ServerResponse, r: HttpResponse): void {
  res.statusCode = r.status;
  for (const [k, v] of Object.entries(r.headers)) if (!(Array.isArray(v) && v.length === 0)) res.setHeader(k, v);
  res.end(r.body);
}

/** Last resort when writing a response failed: end it so the request never hangs. */
function abort(res: ServerResponse): void {
  if (!res.headersSent) res.statusCode = 500;
  res.end();
}

/** The request body as UTF-8, or null once it grows past `limit` bytes. */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer | string) => {
      if (over) return;
      const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += b.length;
      if (size > limit) {
        over = true;
        resolve(null);
      } else chunks.push(b);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/**
 * The free credits, when OPPER_POOL_API_KEY is set: signed-out visitors play on it until its balance runs out. The
 * service makes one of these for all its games (one pool, one visitor limiter).
 */
export function poolAccessFromEnv(env: Record<string, string | undefined>, log: (msg: string) => void): PoolAccess | undefined {
  const pool = poolFromEnv(env, env.OPPER_BASE_URL || 'https://api.opper.ai', log);
  return pool ? { pool, limits: new VisitorLimits(), trustedProxies: trustedProxiesFromEnv(env) } : undefined;
}

export interface GameRouteOptions {
  quiet?: boolean;
  /** The service's shared free credits (null: none). Undefined reads them from the environment (one game alone). */
  poolAccess?: PoolAccess | null;
  highScores?: HighScores;
}

/**
 * Connect-style middleware for one game's routes, with URLs relative to the game's path: Login with Opper, /api/me,
 * /api/decide, /api/warm, /api/highscores and, for a game whose high scores play on issued seeds, /api/seed. Used by the service (packages/kit/server/app.ts) and the Vite dev and
 * preview servers. The player, pool and dev keys never leave the server.
 */
export function createGameMiddleware(game: GameServer, env: Record<string, string | undefined>, logger: RouteLogger, opts: GameRouteOptions = {}): Middleware {
  const cfg = authConfigFromEnv(env, (m) => logger.warn(m), game.slug);
  const devKey = devKeyFromEnv(env, cfg, (m) => logger.warn(m));
  const access = opts.poolAccess === undefined ? poolAccessFromEnv(env, (m) => logger.warn(m)) : (opts.poolAccess ?? undefined);
  if (opts.poolAccess === undefined && access && !opts.quiet) logger.info('[pool] free credits on: signed-out visitors play on OPPER_POOL_API_KEY until its balance runs out');
  if (!devKey && !access && !loginConfigured(cfg) && !opts.quiet) logger.warn(`[${game.slug}] none of TYPESAFE_API_KEY, OPPER_API_KEY, OPPER_POOL_API_KEY or OPPER_CLIENT_ID/SECRET is set: no model can play`);
  const redactSecrets = (s: string) => [cfg.clientSecret, devKey?.apiKey, access?.pool.apiKey].reduce<string>((acc, k) => (k ? acc.split(k).join('[redacted]') : acc), s);
  const baseExchange = opperExchange(cfg);
  // handleCallback maps any failure to ?auth_error=exchange; log why (message only, redacted, capped) so a misconfigured app is diagnosable.
  const exchange: typeof baseExchange = async (code) => {
    try {
      return await baseExchange(code);
    } catch (err) {
      logger.warn(`[auth] token exchange failed: ${redactSecrets((err as Error)?.message ?? String(err)).slice(0, MAX_LOG_CHARS)}`);
      throw err;
    }
  };
  const key = answerKey(cfg.sessionSecret, game.slug);
  const ctx: DecideContext = { game, cfg, ...(devKey ? { devKey } : {}), ...(access ? { access } : {}), answerKey: key };

  const boardIds = game.highScores?.boards.map((b) => b.id) ?? [];
  const scores = game.highScores ? (opts.highScores ?? new HighScores(boardIds, highScoresStore(env, game.slug), (m) => logger.warn(m))) : null;
  // Read the boards now, so the first visitor doesn't wait for it (a failure is logged and tried again on use).
  scores?.ready().catch(() => {});
  const unavailable = () => json(503, { error: 'The high scores are not available right now. Try again in a moment.' }, [], { 'Retry-After': '5' });
  const entriesBy = new Map<string, number[]>();
  /** Accounts and addresses with a check running: one at a time each, so nobody can keep the server busy replaying. */
  const checking = new Set<string>();
  const verifyAnswer = answerVerifier(key);
  const seeds = seedKey(cfg.sessionSecret, game.slug);
  const verifySeed = seedVerifier(seeds, () => Date.now());
  const trustedProxies = access?.trustedProxies ?? trustedProxiesFromEnv(env);

  /**
   * POST /api/highscores: a player's initials and their game's recording; the server replays it for the score. Signed
   * in or not: the replay checks the game, and a signed-out player is counted by their address.
   */
  const enterScore = (req: IncomingMessage, res: ServerResponse, http: HttpRequest, boards: HighScores, check: NonNullable<GameServer['highScores']>['check']) => {
    if (crossSite(http, cfg)) return send(res, json(403, { error: 'Cross-site request refused' }));
    if (!String(http.headers['content-type'] ?? '').includes('application/json')) return send(res, json(415, { error: 'Send JSON' }));
    const session = sessionFrom(http, cfg);
    const visitor = visitorKey(clientIp(http, trustedProxies));
    // Who the rate limit counts: the account, else the address.
    const sender = session ? accountHash(session.user, cfg.sessionSecret) : `visitor:${visitor}`;
    const now = Date.now();
    const recent = (entriesBy.get(sender) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= SCORE_ENTRIES_PER_HOUR || checking.has(sender)) return send(res, json(429, { error: 'Too many entries for now. Try again later.' }));
    // Every attempt counts (refused ones too), before the body is read.
    entriesBy.set(sender, [...recent, now]);
    checking.add(sender);
    readBody(req, MAX_SCORE_BODY_BYTES)
      .then(async (raw) => {
        if (raw === null) return send(res, json(413, { error: 'Request body too large' }, [], { Connection: 'close' }));
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return send(res, json(400, { error: 'Bad JSON' }));
        }
        const board = typeof body?.board === 'string' && boardIds.includes(body.board) ? body.board : null;
        const initials = cleanInitials(body?.initials);
        if (!board || !initials) return send(res, json(400, { error: 'Pick a board and three letters' }));
        // One line per board each: per account, or per address and initials.
        const who = session ? sender : visitorHash(visitor, initials, cfg.sessionSecret);
        // Never put an entry on boards that weren't read: saving them would replace the stored ones.
        if (!(await boards.ready().then(() => true, () => false))) return send(res, unavailable());
        const result = check(body.recording, verifyAnswer, verifySeed);
        if (!result.ok || result.board !== board) {
          logger.warn(`[${game.slug} highscores] refused an entry from ${who}: ${result.ok ? 'played for another board' : result.error}`);
          return send(res, json(422, { error: 'That game did not check out' }));
        }
        let place = boards.add(board, { initials, score: result.score, at: new Date(now).toISOString(), who });
        // Saved before the answer, so the entry is stored once the player sees it (a failed save is retried). The
        // save may merge in another server's entries, so the place is read again after it.
        if (place !== null) {
          // Not stored: say so, so the player tries again (the same game again is the same line, so that's safe).
          if (!(await boards.flush())) return send(res, json(503, { error: 'Your score could not be saved. Try again in a moment.' }, [], { 'Retry-After': '5' }));
          place = boards.placeOf(board, who);
        }
        logger.info(`[${game.slug} highscores] ${initials} ${result.score} on ${board}: ${place === null ? 'not in the top ten' : `#${place}`} (${who})`);
        send(res, json(200, { place, score: result.score, order: boards.order, boards: boards.view() }));
      })
      .catch((err) => {
        logger.error(`[${game.slug} highscores] entry failed: ${String((err as Error)?.message ?? err).slice(0, MAX_LOG_CHARS)}`);
        if (!res.headersSent) send(res, json(500, { error: 'internal error' }));
        else abort(res);
      })
      .finally(() => checking.delete(sender));
  };

  return (req, res, next) => {
    const path = (req.url ?? '').split('?')[0];
    const http = toHttp(req);
    if (path === '/api/highscores') {
      if (!scores || !game.highScores) return send(res, json(404, { error: 'This game has no high scores' }));
      if (http.method === 'GET') {
        void scores.ready().then(
          () => send(res, json(200, { order: scores.order, boards: scores.view() }, [], { 'Cache-Control': 'no-store' })),
          () => send(res, unavailable()),
        );
        return;
      }
      if (http.method === 'POST') return enterScore(req, res, http, scores, game.highScores.check);
      return send(res, json(405, { error: 'Method not allowed' }, [], { Allow: 'GET, POST' }));
    }
    if (path === '/api/seed') {
      // A seed for a player's game, signed so its high-score entry can show it was dealt, not picked. Stateless and cheap.
      if (!game.highScores?.seeded) return send(res, json(404, { error: 'This game issues no seeds' }));
      if (http.method !== 'GET') return send(res, json(405, { error: 'GET only' }, [], { Allow: 'GET' }));
      return send(res, json(200, issueSeed(seeds, Date.now())));
    }
    if (path === '/auth/login') return send(res, handleLogin(http, cfg));
    if (path === '/auth/callback') {
      void handleCallback(http, cfg, exchange)
        .then((r) => send(res, r), () => send(res, redirect(`${cfg.basePath ?? ''}/?auth_error=exchange`)))
        .catch(() => abort(res));
      return;
    }
    if (path === '/auth/logout') return send(res, handleLogout(http, cfg));
    if (path === '/api/me') return send(res, handleMe(http, cfg, devKey?.provider, access?.pool.current()));
    if (path !== '/api/decide' && path !== '/api/warm') return next();

    // Refuse what needs no body (wrong method, cross-site, not JSON, signed out, over a free-credits limit) before reading any of it.
    const refused = rejectDecideRequest(http, cfg, devKey, access) ?? poolLimitRequest(http, cfg, devKey, access);
    if (refused) return send(res, refused);
    const pooled = resolveKey(sessionFrom(http, cfg), devKey, cfg.opperUrl, access?.pool)?.mode === 'pool';
    readBody(req, pooled ? MAX_POOL_BODY_BYTES : MAX_BODY_BYTES)
      .then(async (raw) => {
        if (raw === null) return send(res, json(413, { error: 'Request body too large' }, [], { Connection: 'close' }));
        const r = await handleDecideRequest(
          ctx,
          http,
          raw,
          {
            fetch,
            now: () => performance.now(),
            log: (line) => logger.info(`[${game.slug}] ${line}`, { timestamp: true }),
            logError: (line) => logger.error(line),
          },
          { warm: path === '/api/warm' },
        );
        send(res, r);
      })
      .catch((err) => {
        try {
          logger.error(`[${game.slug}] /api/decide request failed: ${redactSecrets((err as Error)?.message ?? String(err)).slice(0, MAX_LOG_CHARS)}`);
          if (!res.headersSent) return send(res, json(500, { error: 'internal error in /api/decide' }));
        } catch {
          // fall through to abort
        }
        abort(res);
      });
  };
}
