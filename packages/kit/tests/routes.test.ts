import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, STATE_COOKIE } from '../server/auth';
import { HighScores } from '../server/highscores';
import { gamePlugin } from '../server/plugin';
import { authConfigFromEnv, createGameMiddleware, devKeyFromEnv, MAX_BODY_BYTES, redirectUriFromEnv } from '../server/routes';
import { sealSession } from '../server/session';
import { coinBody, coinServer } from './support/test-game';

const SECRET = 's'.repeat(64);
const decideBody = coinBody();
const JSON_POST = { 'content-type': 'application/json' };
type Req = EventEmitter & { method: string; url: string; headers: Record<string, string> };
const newLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function mount(env: Record<string, string>, logger = newLogger(), opts: { quiet?: boolean } = { quiet: true }) {
  const handler = createGameMiddleware(coinServer(), { SESSION_SECRET: SECRET, OPPER_BASE_URL: 'https://api.opper.ai', ...env }, logger, { ...opts, highScores: new HighScores(['all', 'jev'], null) });
  return { handler, logger };
}

function fakeRes(setHeader?: (k: string, v: string | string[]) => void) {
  const headers: Record<string, string | string[]> = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader: setHeader ?? ((k: string, v: string | string[]) => (headers[k] = v)),
    end: vi.fn((_chunk?: string) => (res.headersSent = true)),
    headers,
  };
  return res;
}

function call(handler: ReturnType<typeof mount>['handler'], method: string, url: string, headers: Record<string, string> = {}, payload?: unknown, res = fakeRes()) {
  const next = vi.fn();
  const req = Object.assign(new EventEmitter(), { method, url, headers }) as Req;
  handler(req as never, res as never, next);
  if (payload !== undefined) {
    req.emit('data', typeof payload === 'string' ? payload : JSON.stringify(payload));
    req.emit('end');
  }
  return { res, next, req };
}

const bodyOf = (res: ReturnType<typeof fakeRes>) => JSON.parse(res.end.mock.calls[0][0] as string);

afterEach(() => vi.unstubAllGlobals());

describe('gamePlugin', () => {
  it("mounts the game's routes at its path on both the dev server and the preview server, with clean URLs for its pages", () => {
    const plugin = gamePlugin({ SESSION_SECRET: SECRET }, coinServer(), { quiet: true, pages: ['leaderboard'] });
    for (const hook of [plugin.configureServer, plugin.configurePreviewServer]) {
      const use = vi.fn();
      (hook as (s: unknown) => void)({ config: { logger: newLogger() }, middlewares: { use } });
      expect(use).toHaveBeenCalledTimes(2);
      const rewritten = { url: '/coin/leaderboard?x=1' };
      (use.mock.calls[1][0] as (r: { url: string }, s: unknown, n: () => void) => void)(rewritten, null, () => {});
      expect(rewritten.url).toBe('/coin/leaderboard.html?x=1');
      const res = fakeRes();
      (use.mock.calls[0][0] as ReturnType<typeof mount>['handler'])(Object.assign(new EventEmitter(), { method: 'GET', url: '/coin/api/me', headers: {} }) as never, res as never, vi.fn());
      expect(bodyOf(res)).toMatchObject({ mode: 'none' });
    }
  });
});

describe('gamePlugin below APP_BASE_PATH', () => {
  it("serves the game's routes and clean URLs below the prefix and its slug only", () => {
    const plugin = gamePlugin({ SESSION_SECRET: SECRET, APP_BASE_PATH: '/decision-benchmarks' }, coinServer(), { quiet: true, pages: ['leaderboard'] });
    const use = vi.fn();
    (plugin.configureServer as (s: unknown) => void)({ config: { logger: newLogger() }, middlewares: { use } });
    const [routes, clean] = use.mock.calls.map((c) => c[0] as (r: unknown, s: unknown, n: () => void) => void);
    const res = fakeRes();
    routes(Object.assign(new EventEmitter(), { method: 'GET', url: '/decision-benchmarks/coin/api/me', headers: {} }), res, vi.fn());
    expect(bodyOf(res)).toMatchObject({ mode: 'none' });
    for (const url of ['/api/me', '/decision-benchmarks/api/me', '/decision-benchmarks/other/api/me']) {
      const outside = { method: 'GET', url, headers: {} };
      const next = vi.fn();
      routes(Object.assign(new EventEmitter(), outside), fakeRes(), next);
      expect(next).toHaveBeenCalled();
      expect(outside.url).toBe(url);
    }
    const page = { url: '/decision-benchmarks/coin/leaderboard?x=1' };
    clean(page, null, () => {});
    expect(page.url).toBe('/decision-benchmarks/coin/leaderboard.html?x=1');
    const rootPage = { url: '/leaderboard' };
    clean(rootPage, null, () => {});
    expect(rootPage.url).toBe('/leaderboard');
  });
});

describe('redirect URI and deployment settings', () => {
  it.each([
    [{}, '/coin', 'http://localhost:5173/coin/auth/callback'],
    [{ APP_BASE_PATH: '/decision-benchmarks' }, '/decision-benchmarks/coin', 'http://localhost:5173/decision-benchmarks/coin/auth/callback'],
    [{ PUBLIC_BASE_URL: 'https://opper.ai', APP_BASE_PATH: '/decision-benchmarks' }, '/decision-benchmarks/snake', 'https://opper.ai/decision-benchmarks/snake/auth/callback'],
    [{ PUBLIC_BASE_URL: 'https://opper.ai/' }, '/decision-benchmarks/snake', 'https://opper.ai/decision-benchmarks/snake/auth/callback'],
  ])('%j at %s -> %s', (env, path, expected) => {
    expect(redirectUriFromEnv(env, path)).toBe(expected);
  });

  it('gives every game its own redirect URI and cookie path', () => {
    const env = { SESSION_SECRET: SECRET, APP_BASE_PATH: '/decision-benchmarks/', PUBLIC_BASE_URL: 'https://opper.ai' };
    expect(authConfigFromEnv(env, vi.fn(), 'snake')).toMatchObject({ basePath: '/decision-benchmarks/snake', redirectUri: 'https://opper.ai/decision-benchmarks/snake/auth/callback' });
    expect(authConfigFromEnv(env, vi.fn(), 'fighter')).toMatchObject({ basePath: '/decision-benchmarks/fighter', redirectUri: 'https://opper.ai/decision-benchmarks/fighter/auth/callback' });
  });

  it('reads the base path, proxy hops and public origin', () => {
    const cfg = authConfigFromEnv({ SESSION_SECRET: SECRET, APP_BASE_PATH: '/decision-benchmarks/', PUBLIC_BASE_URL: 'https://opper.ai' }, vi.fn(), 'coin');
    expect(cfg).toMatchObject({ basePath: '/decision-benchmarks/coin', publicOrigin: 'https://opper.ai', redirectUri: 'https://opper.ai/decision-benchmarks/coin/auth/callback' });
    expect(authConfigFromEnv({ SESSION_SECRET: SECRET }, vi.fn())).toMatchObject({ basePath: '' });
    expect(authConfigFromEnv({ SESSION_SECRET: SECRET }, vi.fn()).publicOrigin).toBeUndefined();
  });

  it.each([
    [{ PUBLIC_BASE_URL: 'opper.ai' }, /PUBLIC_BASE_URL/],
    [{ PUBLIC_BASE_URL: 'https://opper.ai/decision-benchmarks' }, /PUBLIC_BASE_URL/],
    [{ PUBLIC_BASE_URL: 'ftp://opper.ai' }, /PUBLIC_BASE_URL/],
    [{ APP_BASE_PATH: '/a b' }, /APP_BASE_PATH/],
  ])('refuses %j', (env, message) => {
    expect(() => authConfigFromEnv({ SESSION_SECRET: SECRET, ...env }, vi.fn())).toThrow(message);
  });

  it('treats an https PUBLIC_BASE_URL as a deployment: real secret required, dev key ignored', () => {
    expect(() => authConfigFromEnv({ PUBLIC_BASE_URL: 'https://opper.ai' }, vi.fn())).toThrow(/SESSION_SECRET/);
    const env = { PUBLIC_BASE_URL: 'https://opper.ai', SESSION_SECRET: SECRET, OPPER_API_KEY: 'op-dev' };
    expect(devKeyFromEnv(env, authConfigFromEnv(env, vi.fn()), vi.fn())).toBeUndefined();
  });

  it('sends a failed callback back below the base path', async () => {
    const { handler } = mount({ APP_BASE_PATH: '/decision-benchmarks', OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh' });
    const { res } = call(handler, 'GET', '/auth/callback?code=c&state=x');
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toBe('/decision-benchmarks/coin/?auth_error=state');
  });
});

describe('createGameMiddleware routing', () => {
  it('passes other paths through', () => {
    const { handler } = mount({});
    expect(call(handler, 'GET', '/src/main.ts').next).toHaveBeenCalled();
  });

  it('redirects /auth/login to Opper when configured', () => {
    const { handler } = mount({ OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh' });
    const { res } = call(handler, 'GET', '/auth/login');
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.Location)).toMatch(/^https:\/\/api\.opper\.ai\/oauth\/authorize\?/);
  });

  it('answers /api/me without a session in dev mode', () => {
    const { handler } = mount({ OPPER_API_KEY: 'op-dev' });
    const { res } = call(handler, 'GET', '/api/me');
    expect(bodyOf(res)).toMatchObject({ mode: 'dev', loginAvailable: false });
  });

  it('asks the player to sign in when there is no session and no dev key, before reading the body', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { handler } = mount({});
    const { res } = call(handler, 'POST', '/api/decide', JSON_POST);
    expect(res.end).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(401);
    expect(bodyOf(res)).toEqual({ error: 'Sign in with Opper to let the AI play', signedOut: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses the player key from the session cookie and clears it when Opper rejects it', async () => {
    const auth: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      auth.push((init.headers as Record<string, string>).Authorization);
      return new Response('{"error":"invalid"}', { status: 401 });
    }));
    const { handler, logger } = mount({ OPPER_API_KEY: 'op-dev' });
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(sealSession({ v: 1, apiKey: 'op-player', user: {}, issuedAt: Date.now() }, SECRET))}`;
    const { res } = call(handler, 'POST', '/api/decide', { ...JSON_POST, cookie }, decideBody);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(auth).toEqual(['Bearer op-player']);
    expect(res.statusCode).toBe(401);
    expect(bodyOf(res)).toEqual({ error: 'Your Opper sign-in has expired. Sign in again to keep playing.', signedOut: true });
    expect(String(res.headers['Set-Cookie'])).toMatch(new RegExp(`^${SESSION_COOKIE}=; Max-Age=0`));
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('op-player');
  });

  it('answers 500 and ends the response when handling throws, instead of hanging', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('boom');
    });
    const logger = { info: vi.fn(() => { throw new Error('logger exploded with op-dev'); }), warn: vi.fn(), error: vi.fn() };
    const { handler } = mount({ OPPER_API_KEY: 'op-dev' }, logger);
    const { res } = call(handler, 'POST', '/api/decide', JSON_POST, decideBody);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(500);
    expect(bodyOf(res)).toEqual({ error: 'internal error in /api/decide' });
    expect(logger.error).toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('op-dev');
  });

  it('answers 413 without calling jev when the body is larger than 256 KB', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { handler } = mount({ OPPER_API_KEY: 'op-dev' });
    const { res, req } = call(handler, 'POST', '/api/decide', JSON_POST);
    req.emit('data', Buffer.alloc(MAX_BODY_BYTES, 0x20));
    req.emit('data', Buffer.from('{}'));
    req.emit('end');
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(MAX_BODY_BYTES).toBe(256 * 1024);
    expect(res.statusCode).toBe(413);
    expect(bodyOf(res)).toEqual({ error: 'Request body too large' });
    expect(res.end).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts a body of exactly 256 KB', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"answers":{},"usage":{"input_tokens":0,"output_tokens":0}}', { status: 200 })));
    const { handler } = mount({ OPPER_API_KEY: 'op-dev' });
    const json = JSON.stringify(decideBody);
    const { res, req } = call(handler, 'POST', '/api/decide', JSON_POST);
    req.emit('data', Buffer.from(json + ' '.repeat(MAX_BODY_BYTES - json.length)));
    req.emit('end');
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(200);
  });

  it('logs the redacted exchange failure reason and redirects to auth_error=exchange', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"bad secret shh"}', { status: 400 })));
    const { handler, logger } = mount({ OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh' });
    const { res } = call(handler, 'GET', '/auth/callback?code=c0de&state=st8', { cookie: `${STATE_COOKIE}=st8` });
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.Location)).toBe('/coin/?auth_error=exchange');
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('token exchange failed');
    expect(logged).not.toContain('shh');
    expect(logged).not.toContain('c0de');
  });

  it('caps the exchange-failure log line at about 300 characters', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: `shh ${'x'.repeat(5000)}` }), { status: 400 })));
    const { handler, logger } = mount({ OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh' });
    const { res } = call(handler, 'GET', '/auth/callback?code=c0de&state=st8', { cookie: `${STATE_COOKIE}=st8` });
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    const line = String(logger.warn.mock.calls.find((c) => String(c[0]).includes('token exchange failed'))![0]);
    expect(line.length).toBeLessThanOrEqual(340);
    expect(line).toContain('[redacted]');
    expect(line).not.toContain('shh');
  });

  it('still ends the callback response when writing it throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"api_key":"op-player"}', { status: 200 })));
    const { handler } = mount({ OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh' });
    const res = fakeRes(() => {
      throw new Error('socket gone');
    });
    call(handler, 'GET', '/auth/callback?code=c0de&state=st8', { cookie: `${STATE_COOKIE}=st8` }, undefined, res);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(500);
  });

  it('answers 405 to non-POST /api/decide', () => {
    const { handler } = mount({ OPPER_API_KEY: 'op-dev' });
    expect(call(handler, 'GET', '/api/decide').res.statusCode).toBe(405);
  });

  it.each([['text/plain'], [undefined]])('answers 415 without calling jev for Content-Type %s (CSRF guard)', (contentType) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { handler } = mount({ OPPER_API_KEY: 'op-dev' });
    const { res } = call(handler, 'POST', '/api/decide', contentType ? { 'content-type': contentType } : {});
    expect(res.statusCode).toBe(415);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/decide', { 'sec-fetch-site': 'cross-site' }],
    ['/api/decide', { origin: 'https://evil.example', host: 'localhost:5173' }],
    ['/auth/logout', { 'sec-fetch-site': 'same-site' }],
    ['/auth/logout', { origin: 'null', host: 'localhost:5173' }],
  ])('answers 403 to a cross-site POST %s %j', (path, headers) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { handler } = mount({ OPPER_API_KEY: 'op-dev' });
    const { res } = call(handler, 'POST', path, { ...JSON_POST, ...headers });
    expect(res.statusCode).toBe(403);
    expect(res.headers['Set-Cookie']).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('warns that no model can play unless quiet', () => {
    const loud = mount({}, newLogger(), {}).logger;
    expect(JSON.stringify(loud.warn.mock.calls)).toContain('no model can play');
    const quiet = mount({}, newLogger(), { quiet: true }).logger;
    expect(JSON.stringify(quiet.warn.mock.calls)).not.toContain('no model can play');
  });
});

describe('deploy safety', () => {
  const HTTPS = { PUBLIC_BASE_URL: 'https://games.example', OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh' };

  it.each([[undefined], ['short']])('refuses to start with an https redirect URI and SESSION_SECRET %s', (secret) => {
    const env: Record<string, string> = { ...HTTPS };
    if (secret) env.SESSION_SECRET = secret;
    expect(() => authConfigFromEnv(env, vi.fn())).toThrow(/SESSION_SECRET/);
    expect(() => createGameMiddleware(coinServer(), env, newLogger(), { quiet: true })).toThrow(/SESSION_SECRET/);
  });

  it('accepts a 32-character SESSION_SECRET with an https redirect URI', () => {
    const warn = vi.fn();
    expect(authConfigFromEnv({ ...HTTPS, SESSION_SECRET: 'k'.repeat(32) }, warn).sessionSecret).toBe('k'.repeat(32));
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once and uses a random secret over http when login is configured', () => {
    const warn = vi.fn();
    const cfg = authConfigFromEnv({ SESSION_SECRET: 'short', OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh' }, warn);
    expect(cfg.sessionSecret).toHaveLength(64);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('SESSION_SECRET'))).toHaveLength(1);
  });

  it('does not warn about SESSION_SECRET in dev when login is not configured', () => {
    const warn = vi.fn();
    expect(authConfigFromEnv({ OPPER_API_KEY: 'op-dev' }, warn).sessionSecret).toHaveLength(64);
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores the dev key with a warning when the redirect URI is https', () => {
    const env = { ...HTTPS, SESSION_SECRET: SECRET, OPPER_API_KEY: 'op-dev' };
    const warn = vi.fn();
    expect(devKeyFromEnv(env, authConfigFromEnv(env, vi.fn()), warn)).toBeUndefined();
    expect(String(warn.mock.calls[0][0])).toMatch(/OPPER_API_KEY.*ignored.*ALLOW_DEV_KEY=1/);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('op-dev');

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { handler } = mount(env);
    expect(bodyOf(call(handler, 'GET', '/api/me').res)).toMatchObject({ mode: 'none' });
    const { res } = call(handler, 'POST', '/api/decide', JSON_POST);
    expect(res.statusCode).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses the dev key over https only with ALLOW_DEV_KEY=1, still warning', () => {
    const env = { ...HTTPS, SESSION_SECRET: SECRET, OPPER_API_KEY: 'op-dev', ALLOW_DEV_KEY: '1' };
    const warn = vi.fn();
    expect(devKeyFromEnv(env, authConfigFromEnv(env, vi.fn()), warn)).toMatchObject({ provider: 'opper', apiKey: 'op-dev' });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('ignores a TypeSafe key over https too, unless ALLOW_DEV_KEY=1', () => {
    const env = { ...HTTPS, SESSION_SECRET: SECRET, TYPESAFE_API_KEY: 'ts-dev' };
    const warn = vi.fn();
    expect(devKeyFromEnv(env, authConfigFromEnv(env, vi.fn()), warn)).toBeUndefined();
    expect(String(warn.mock.calls[0][0])).toMatch(/TYPESAFE_API_KEY.*ignored/);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('ts-dev');
  });

  it('sends dev calls straight to TypeSafe when TYPESAFE_API_KEY is set', async () => {
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init: RequestInit) => {
      calls.push([u, init]);
      return new Response(JSON.stringify({ answers: {}, usage: { input_tokens: 100, output_tokens: 1 } }), { status: 200 });
    }));
    const { handler } = mount({ TYPESAFE_API_KEY: 'ts-dev', OPPER_API_KEY: 'op-dev' });
    expect(bodyOf(call(handler, 'GET', '/api/me').res)).toMatchObject({ mode: 'dev', devProvider: 'typesafe' });
    const { res } = call(handler, 'POST', '/api/decide', JSON_POST, decideBody);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(calls[0][0]).toBe('https://api.typesafe.ai/v1/systemone');
    expect((calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer ts-dev');
    expect(bodyOf(res)).toMatchObject({ costEstimated: true });
  });

  it('uses the dev key over http without a warning', () => {
    const env = { SESSION_SECRET: SECRET, OPPER_API_KEY: 'op-dev' };
    const warn = vi.fn();
    expect(devKeyFromEnv(env, authConfigFromEnv(env, vi.fn()), warn)).toMatchObject({ provider: 'opper', apiKey: 'op-dev' });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('production settings', () => {
  it('refuses to start in production without an https PUBLIC_BASE_URL, unless ALLOW_HTTP=1', () => {
    expect(() => authConfigFromEnv({ NODE_ENV: 'production', SESSION_SECRET: SECRET }, vi.fn(), 'coin')).toThrow(/PUBLIC_BASE_URL/);
    expect(authConfigFromEnv({ NODE_ENV: 'production', SESSION_SECRET: SECRET, ALLOW_HTTP: '1' }, vi.fn(), 'coin').basePath).toBe('/coin');
  });
});

describe('a game without high scores', () => {
  it('answers 404 to /api/highscores', () => {
    const { highScores: _none, ...plain } = coinServer();
    const handler = createGameMiddleware(plain, { SESSION_SECRET: SECRET }, newLogger(), { quiet: true });
    const { res } = call(handler, 'GET', '/api/highscores');
    expect(res.statusCode).toBe(404);
  });
});

describe('the game decides what is forwarded', () => {
  it("refuses a body the game would not send, for any key, before calling a model", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { handler } = mount({ OPPER_API_KEY: 'op-dev' });
    const { res } = call(handler, 'POST', '/api/decide', JSON_POST, { state: {}, questions: { summary: { type: 'choice', instructions: 'Write a poem', criteria: { a: 'A', b: 'B' } } } });
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res)).toEqual({ error: 'not a coin request' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
