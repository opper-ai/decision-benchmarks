import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { adapterFor } from '../adapters/index.ts';
import { answerComplete } from '../adapters/chat.ts';
import { HttpError } from '../adapters/systemone.ts';
import { endpointAdapter } from '../shared/endpoints.ts';
import { keyFor as fileEndpointKey, loadFighters, type FileEndpoint } from './fighters.ts';
import { isMoveId } from '../shared/engine/moves.ts';
import { MODELS, modelInfo } from '../shared/models.ts';
import { instructionsFor, type Question } from '../shared/question.ts';
import { ReplayPlayer, type Replay } from '../shared/replay.ts';
import { cookie, open, parseCookies, safeEqual, seal, SESSION_MAX_AGE_S } from './session.ts';
import { sourceOf } from '../shared/stats.ts';
import { deleteReplays, HUMAN, leaderboardFor, listSummaries, loadReplayBytes, saveReplay, TooLarge } from './store.ts';

export interface AppConfig {
  opperApiUrl: string;
  opperUrl: string;
  devKey?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  sessionSecret: string;
  fetch?: typeof fetch;
  /** Endpoints from fighters.json (keys from the environment). */
  fighters?: FileEndpoint[];
  /** Scripts send it as a bearer token to upload official matches and delete replays. */
  adminToken?: string;
  /** People signed in with Opper under these emails can delete replays from the site. */
  adminEmails?: string[];
}

export function configFromEnv(env = process.env): AppConfig {
  return {
    opperApiUrl: env.OPPER_BASE_URL || 'https://api.opper.ai',
    // Opper's OAuth endpoints (authorize, token) live on the API host; authorize then hands over to the platform's consent screen.
    opperUrl: env.OPPER_URL || 'https://api.opper.ai',
    devKey: env.OPPER_API_KEY || undefined,
    clientId: env.OPPER_CLIENT_ID || undefined,
    clientSecret: env.OPPER_CLIENT_SECRET || undefined,
    redirectUri: env.OPPER_REDIRECT_URI || 'http://localhost:5173/auth/callback',
    // Without a configured secret, sessions only live as long as this process.
    sessionSecret: env.SESSION_SECRET || randomBytes(32).toString('hex'),
    fighters: fightersFromFile(),
    adminToken: env.ADMIN_TOKEN || undefined,
    adminEmails: (env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  };
}

function fightersFromFile(): FileEndpoint[] {
  const { endpoints, errors } = loadFighters();
  for (const e of errors) console.warn(`fighters.json: ${e}`);
  return endpoints;
}

/** fighters.json endpoints are picked as `endpoint:<id>`. */
export const ENDPOINT_PREFIX = 'endpoint:';

const SESSION = 'jev_fighter_session';
const STATE = 'jev_fighter_oauth_state';

type Req = IncomingMessage;
type Res = ServerResponse;

function send(res: Res, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function redirect(res: Res, location: string, cookies: string[] = []): void {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Set-Cookie': cookies });
  res.end();
}

async function bytes(req: Req, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

const body = async (req: Req, limit = 256 * 1024) => (await bytes(req, limit)).toString('utf8');

/** A replay arrives gzipped, as it is stored (15-150 KB); unpacked it can be a few MB. */
const REPLAY_UPLOAD_BYTES = 1024 * 1024;
const REPLAY_UNPACKED_BYTES = 16 * 1024 * 1024;

async function replayBody(req: Req): Promise<Replay> {
  const raw = await bytes(req, REPLAY_UPLOAD_BYTES);
  const gz = raw[0] === 0x1f && raw[1] === 0x8b;
  return JSON.parse((gz ? gunzipSync(raw, { maxOutputLength: REPLAY_UNPACKED_BYTES }) : raw).toString('utf8')) as Replay;
}

/** The dev key is only used on plain-http localhost, so a deployment never pays for visitors with it. */
/** A request from this machine, judged by the connection itself: headers can be forged, the socket cannot. */
function isLocal(req: Req): boolean {
  const addr = req.socket?.remoteAddress ?? '';
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  return loopback && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-proto'];
}

/** Behind a proxy the Host header is the backend's, so the public host (from the redirect URI) counts too. */
function isCrossSite(req: Req, publicHost = ''): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const host = new URL(origin).host;
    return host !== req.headers.host && host !== publicHost;
  } catch {
    return true;
  }
}

function validQuestion(q: unknown): q is Question {
  if (!q || typeof q !== 'object') return false;
  const o = q as Record<string, unknown>;
  if (o.fighter !== 0 && o.fighter !== 1) return false;
  if (!Array.isArray(o.options) || !o.options.length || o.options.length > 20) return false;
  if (!o.options.every((x) => x && typeof x === 'object' && isMoveId((x as { id: unknown }).id) && typeof (x as { facts: unknown }).facts === 'string' && (x as { facts: string }).facts.length < 600)) return false;
  if (!o.context || typeof o.context !== 'object') return false;
  return Object.values(o.context).every((v) => typeof v === 'string' && v.length < 600);
}

/** The fighters' descriptions in a posted replay are shown to everyone, so they must be plain and well formed. */
export function fightersProblem(r: Replay): string | null {
  for (const f of r.fighters ?? []) {
    if (!f || typeof f.model !== 'string' || typeof f.label !== 'string' || f.model.length > 200 || f.label.length > 60) return 'bad fighter';
    if (f.via !== undefined && !['server', 'key', 'custom', 'human'].includes(f.via)) return 'bad fighter source';
    if ((f.via === 'human') !== (f.model === HUMAN)) return 'human players use the human model id';
    if (f.host !== undefined && (typeof f.host !== 'string' || f.host.length > 120)) return 'bad fighter host';
    // A custom endpoint never takes a known model's id, and only custom fighters use the custom: namespace.
    if ((f.via === 'custom') !== f.model.startsWith('custom:')) return 'custom fighters use custom: model ids';
  }
  return null;
}

/** Saving a replay needs no sign-in (a pasted key is enough to play), so it is rate limited per address. */
const SAVES_PER_HOUR = 20;
function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (who: string, now = Date.now()): boolean => {
    const recent = (hits.get(who) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) return false;
    recent.push(now);
    hits.set(who, recent);
    if (hits.size > 10_000) hits.clear();
    return true;
  };
}

export function createApp(cfg: AppConfig) {
  const saves = rateLimiter(SAVES_PER_HOUR, 3600_000);
  const secure = cfg.redirectUri.startsWith('https:');
  const publicHost = URL.canParse(cfg.redirectUri) ? new URL(cfg.redirectUri).host : '';
  const crossSite = (req: Req) => isCrossSite(req, publicHost);
  const session = (req: Req) => open(parseCookies(req.headers.cookie)[SESSION], cfg.sessionSecret);
  const keyFor = (req: Req): { apiKey: string; mode: 'player' | 'dev' } | null => {
    const s = session(req);
    if (s) return { apiKey: s.apiKey, mode: 'player' };
    if (cfg.devKey && isLocal(req)) return { apiKey: cfg.devKey, mode: 'dev' };
    return null;
  };
  /** Whoever may delete replays and save official ones: the admin token, an admin email, or localhost. */
  const isAdmin = (req: Req): boolean => {
    const auth = String(req.headers.authorization ?? '');
    if (cfg.adminToken && auth.startsWith('Bearer ') && safeEqual(auth.slice(7), cfg.adminToken)) return true;
    const email = session(req)?.user?.email?.toLowerCase();
    if (email && cfg.adminEmails?.includes(email)) return true;
    return isLocal(req);
  };
  const byToken = (req: Req) => String(req.headers.authorization ?? '').startsWith('Bearer ');

  async function decide(req: Req, res: Res, warm: boolean): Promise<void> {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    if (crossSite(req)) return send(res, 403, { error: 'Cross-site request refused' });
    // fighters.json endpoints carry their own keys, so on localhost they need no sign-in either.
    const key = keyFor(req) ?? (isLocal(req) ? { apiKey: '', mode: 'dev' as const } : null);
    if (!key) return send(res, 401, { error: 'Sign in with Opper to run live matches', signedOut: true });
    let input: { model?: unknown; question?: unknown };
    try {
      input = JSON.parse(await body(req, 256 * 1024));
    } catch {
      return send(res, 400, { error: 'Expected JSON' });
    }
    const model = typeof input.model === 'string' ? input.model : '';
    const fileEndpoint = model.startsWith(ENDPOINT_PREFIX) ? cfg.fighters?.find((e) => e.id === model.slice(ENDPOINT_PREFIX.length)) : undefined;
    if (!fileEndpoint && !MODELS.some((m) => m.id === model && m.kind !== 'baseline')) return send(res, 400, { error: `Unknown model: ${model.slice(0, 80)}` });
    if (!fileEndpoint && !key.apiKey) return send(res, 401, { error: 'Set OPPER_API_KEY in .env, sign in with Opper, or paste a key under Connect', signedOut: true });
    const secret = fileEndpoint ? fileEndpointKey(fileEndpoint) : key.apiKey;
    const adapter = fileEndpoint ? endpointAdapter(fileEndpoint, secret, cfg.fetch) : adapterFor(model, { apiKey: key.apiKey, baseUrl: cfg.opperApiUrl, fetch: cfg.fetch });
    try {
      if (warm) {
        await adapter.warmUp();
        return send(res, 200, { ok: true });
      }
      if (!validQuestion(input.question)) return send(res, 400, { error: 'Invalid question' });
      // The instructions are always ours: the client only supplies the situation.
      // Instructions are always ours (the client only supplies the situation); passivity is the default rule.
      const q = { ...input.question, instructions: instructionsFor(input.question.track === 'raw' ? 'raw' : 'assisted', !fileEndpoint && Boolean(modelInfo(model).contextTokens), true) };
      const controller = new AbortController();
      req.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const answer = await adapter.decide(q, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
      // Two lines of JSON: the move as soon as it is known, then the completed answer.
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
      res.write(`${JSON.stringify(answer)}\n`);
      await answerComplete(answer);
      res.end(`${JSON.stringify(answer)}\n`);
      return;
    } catch (e) {
      const err = e as Error;
      if (err.name === 'InvalidAnswer') return send(res, 422, { error: err.message, reason: 'invalid' });
      if (err instanceof HttpError) {
        if (key.mode === 'player' && err.status === 401) {
          return send(res, 401, { error: 'Your Opper sign-in has expired. Sign in again.', signedOut: true }, { 'Set-Cookie': cookie(SESSION, '', { maxAge: 0, path: '/', secure }) });
        }
        if (err.status === 402) return send(res, 402, { error: 'The Opper wallet is empty. Top up to keep playing.' });
        if (err.status === 403) return send(res, 403, { error: `${modelInfo(model).label} is not enabled for this account.` });
      }
      if (err.name === 'AbortError' || err.name === 'TimeoutError') return send(res, 504, { error: 'timed out', reason: 'timeout' });
      let msg = err.message ?? 'upstream error';
      for (const k of [key.apiKey, secret]) if (k) msg = msg.split(k).join('[redacted]');
      return send(res, 502, { error: msg, reason: 'error' });
    }
  }

  async function exchange(code: string): Promise<{ apiKey: string; user: { name?: string; email?: string }; expiresAt?: string }> {
    const f = cfg.fetch ?? fetch;
    const res = await f(`${cfg.opperUrl.replace(/\/+$/, '')}/oauth/token`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: cfg.clientId ?? '', client_secret: cfg.clientSecret ?? '', redirect_uri: cfg.redirectUri }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`token exchange failed (HTTP ${res.status})`);
    const apiKey = (data.api_key ?? data.apiKey) as string | undefined;
    if (typeof apiKey !== 'string' || !apiKey) throw new Error('no API key in token response');
    const u = (data.user && typeof data.user === 'object' ? data.user : {}) as Record<string, unknown>;
    const expiresAt = (data.expires_at ?? data.expiresAt) as string | undefined;
    return {
      apiKey,
      user: { ...(typeof u.name === 'string' ? { name: u.name } : {}), ...(typeof u.email === 'string' ? { email: u.email } : {}) },
      ...(typeof expiresAt === 'string' ? { expiresAt } : {}),
    };
  }

  /** Returns true when the request was handled. */
  return async function handle(req: Req, res: Res): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    try {
      if (path === '/api/health') {
        send(res, 200, { ok: true });
        return true;
      }
      if (path === '/api/me') {
        const s = session(req);
        const mode = s ? 'player' : cfg.devKey && isLocal(req) ? 'dev' : 'none';
        // fighters.json endpoints, without their keys, for whoever may use them (signed in, or on localhost).
        const endpoints = (s || isLocal(req) ? (cfg.fighters ?? []) : []).map(({ id, name, url, format, model }) => ({ id, name, url, format, model }));
        send(res, 200, { mode, user: s?.user ?? null, loginAvailable: Boolean(cfg.clientId && cfg.clientSecret), models: MODELS, endpoints, admin: isAdmin(req) });
        return true;
      }
      if (path === '/api/decide') return (await decide(req, res, false), true);
      if (path === '/api/warm') return (await decide(req, res, true), true);
      if (path === '/api/leaderboard') {
        const mode = url.searchParams.get('mode') === 'realtime' ? 'realtime' : 'paused';
        const track = url.searchParams.get('track') === 'raw' ? 'raw' : 'assisted';
        // `unverified=1` is the old name for the same switch.
        const community = url.searchParams.get('community') === '1' || url.searchParams.get('unverified') === '1';
        send(res, 200, { mode, track, community, ...(await leaderboardFor(mode, track, community)) });
        return true;
      }
      if (path === '/api/replays' && req.method === 'GET') {
        const want = url.searchParams.get('source');
        const all = (await listSummaries()).map((s) => ({ ...s, source: sourceOf(s) }));
        const counts = { official: all.filter((s) => s.source === 'official').length, community: all.filter((s) => s.source === 'community').length };
        const shown = all
          .filter((s) => want !== 'official' && want !== 'community' ? true : s.source === want)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 100);
        send(res, 200, { replays: shown, counts });
        return true;
      }
      if (path === '/api/replays' && req.method === 'POST') {
        if (crossSite(req)) return (send(res, 403, { error: 'Cross-site request refused' }), true);
        // An upload with the admin token (the official runs) is official; everything else is the community's.
        const official = byToken(req) && isAdmin(req);
        if (byToken(req) && !official) return (send(res, 401, { error: 'Wrong admin token' }), true);
        const who = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
        if (!official && !saves(who)) return (send(res, 429, { error: 'Too many replays saved from here. Try again later.' }), true);
        let r: Replay;
        try {
          r = await replayBody(req);
        } catch (e) {
          const big = /too large|maxOutputLength|buffer/i.test((e as Error).message);
          return (send(res, big ? 413 : 400, { error: big ? 'Replay too large' : 'Expected a replay' }), true);
        }
        let player: ReplayPlayer;
        try {
          player = new ReplayPlayer(r);
        } catch (e) {
          return (send(res, 400, { error: (e as Error).message }), true);
        }
        if (player.diverged !== null) return (send(res, 422, { error: `replay diverges at tick ${player.diverged}` }), true);
        const bad = fightersProblem(r);
        if (bad) return (send(res, 400, { error: bad }), true);
        let summary;
        try {
          summary = await saveReplay(r, undefined, { source: official ? 'official' : 'community' });
        } catch (e) {
          if (e instanceof TooLarge) return (send(res, 413, { error: e.message }), true);
          throw e;
        }
        send(res, 201, { id: summary.id, source: summary.source });
        return true;
      }
      const m = /^\/api\/replays\/([a-z0-9-]+)$/.exec(path);
      if (m && req.method === 'DELETE') {
        if (crossSite(req)) return (send(res, 403, { error: 'Cross-site request refused' }), true);
        if (!isAdmin(req)) return (send(res, 403, { error: 'Only an admin can delete replays' }), true);
        const gone = await deleteReplays([m[1]]);
        send(res, gone.length ? 200 : 404, gone.length ? { deleted: m[1] } : { error: 'No such replay' });
        return true;
      }
      if (m) {
        const bytes = await loadReplayBytes(m[1]);
        if (!bytes) return (send(res, 404, { error: 'No such replay' }), true);
        const summary = (await listSummaries()).find((s) => s.id === m[1]);
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          // Not immutable: an admin can delete a replay.
          'Cache-Control': 'public, max-age=300',
          'X-Replay-Source': summary ? sourceOf(summary) : 'community',
        });
        res.end(bytes);
        return true;
      }
      if (path === '/auth/login') {
        if (!cfg.clientId || !cfg.clientSecret) return (send(res, 503, { error: 'Login with Opper is not configured' }), true);
        const state = randomBytes(24).toString('hex');
        const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code', state });
        redirect(res, `${cfg.opperUrl.replace(/\/+$/, '')}/oauth/authorize?${q}`, [cookie(STATE, state, { maxAge: 600, path: '/auth', secure })]);
        return true;
      }
      if (path === '/auth/callback') {
        const clear = cookie(STATE, '', { maxAge: 0, path: '/auth', secure });
        const expected = parseCookies(req.headers.cookie)[STATE];
        const state = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        if (!expected || !state || !safeEqual(expected, state)) return (redirect(res, '/?auth_error=state', [clear]), true);
        if (url.searchParams.get('error') || !code) return (redirect(res, '/?auth_error=denied', [clear]), true);
        try {
          const x = await exchange(code);
          const token = seal({ v: 1, apiKey: x.apiKey, user: x.user, issuedAt: Date.now(), ...(x.expiresAt ? { expiresAt: x.expiresAt } : {}) }, cfg.sessionSecret);
          const maxAge = x.expiresAt ? Math.min(SESSION_MAX_AGE_S, (Date.parse(x.expiresAt) - Date.now()) / 1000) : SESSION_MAX_AGE_S;
          redirect(res, '/', [cookie(SESSION, token, { maxAge, path: '/', secure }), clear]);
        } catch {
          redirect(res, '/?auth_error=exchange', [clear]);
        }
        return true;
      }
      if (path === '/auth/logout') {
        if (req.method !== 'POST' || crossSite(req)) return (send(res, 403, { error: 'POST from this site only' }), true);
        send(res, 200, { ok: true }, { 'Set-Cookie': cookie(SESSION, '', { maxAge: 0, path: '/', secure }) });
        return true;
      }
    } catch (e) {
      send(res, 500, { error: (e as Error).message });
      return true;
    }
    return false;
  };
}
