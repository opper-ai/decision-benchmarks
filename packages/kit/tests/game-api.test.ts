import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../server/auth';
import { Pool, VisitorLimits } from '../server/pool';
import { createGameMiddleware } from '../server/routes';
import { purposeKey, sealSession, unseal } from '../server/session';
import type { GameApiCall, GameApiResponse, GameServer } from '../shared/game';
import { coinServer } from './support/test-game';

const SECRET = 's'.repeat(64);
const JSON_POST = { 'content-type': 'application/json' };
const newLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const session = (apiKey = 'op-player') => `${SESSION_COOKIE}=${encodeURIComponent(sealSession({ v: 1, apiKey, user: { name: 'Ada' }, issuedAt: Date.now() }, SECRET))}`;

/** The coin game with an API of its own: echo answers what it was given and who would pay. */
function coinWithApi(handler: (call: GameApiCall) => Promise<GameApiResponse>, maxBodyBytes?: number): GameServer {
  return { ...coinServer(), api: { routes: { '/api/coin/echo': handler }, ...(maxBodyBytes ? { maxBodyBytes } : {}) } };
}

function poolAccess(o: { open?: boolean; rate?: number } = {}) {
  const fetchMe = vi.fn(async () => new Response(JSON.stringify({ balance: { balance_cents: o.open === false ? 0 : 5000 } }), { status: 200 }));
  const pool = new Pool({ apiKey: 'op-pool', opperUrl: 'https://api.opper.ai', fetch: fetchMe, now: () => 0, refreshMs: Number.POSITIVE_INFINITY });
  if (o.open === false) pool.exhausted();
  return { pool, limits: new VisitorLimits({ ratePerSec: o.rate ?? 100, burst: o.rate ?? 100 }, () => 0), trustedProxies: 0 };
}

function fakeRes() {
  const headers: Record<string, string | string[]> = {};
  const events = new EventEmitter();
  const res = {
    statusCode: 200,
    headersSent: false,
    writableFinished: false,
    setHeader: (k: string, v: string | string[]) => (headers[k] = v),
    end: vi.fn((_chunk?: string) => {
      res.headersSent = true;
      res.writableFinished = true;
    }),
    on: (e: string, f: () => void) => events.on(e, f),
    emit: (e: string) => events.emit(e),
    headers,
  };
  return res;
}

function post(handler: ReturnType<typeof createGameMiddleware>, url: string, payload: unknown, headers: Record<string, string> = JSON_POST, method = 'POST') {
  const res = fakeRes();
  const next = vi.fn();
  const req = Object.assign(new EventEmitter(), { method, url, headers, socket: { remoteAddress: '203.0.113.9' } });
  handler(req as never, res as never, next);
  if (payload !== undefined) {
    req.emit('data', typeof payload === 'string' ? payload : JSON.stringify(payload));
    req.emit('end');
  }
  return { res, next };
}

const answered = async (res: ReturnType<typeof fakeRes>) => {
  await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
  return { status: res.statusCode, body: JSON.parse(res.end.mock.calls[0]![0] as string) as Record<string, unknown> };
};

function mount(game: GameServer, env: Record<string, string> = {}, access: ReturnType<typeof poolAccess> | null = null) {
  return createGameMiddleware(game, { SESSION_SECRET: SECRET, ...env }, newLogger(), { quiet: true, poolAccess: access });
}

describe("a game's own API routes", () => {
  it('hands the parsed JSON body to the route and sends its answer', async () => {
    const handler = vi.fn(async (call: GameApiCall) => ({ status: 201, body: { got: call.body } }));
    const r = await answered(post(mount(coinWithApi(handler)), '/api/coin/echo', { a: 1 }).res);
    expect(r).toEqual({ status: 201, body: { got: { a: 1 } } });
  });

  it('refuses what needs no body first: not POST, cross-site, not JSON; passes unknown paths on', async () => {
    const handler = vi.fn(async () => ({ status: 200, body: {} }));
    const routes = mount(coinWithApi(handler));
    expect((await answered(post(routes, '/api/coin/echo', undefined, {}, 'GET').res)).status).toBe(405);
    expect((await answered(post(routes, '/api/coin/echo', undefined, { ...JSON_POST, 'sec-fetch-site': 'cross-site' }).res)).status).toBe(403);
    expect((await answered(post(routes, '/api/coin/echo', undefined, { 'content-type': 'text/plain' }).res)).status).toBe(415);
    expect(post(routes, '/api/coin/other', {}).next).toHaveBeenCalled();
    expect(post(routes, '/api/coin/toString', {}).next).toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('caps the body (413) and refuses bad JSON (400)', async () => {
    const handler = vi.fn(async () => ({ status: 200, body: {} }));
    const routes = mount(coinWithApi(handler, 100));
    expect((await answered(post(routes, '/api/coin/echo', JSON.stringify({ pad: 'x'.repeat(200) })).res)).status).toBe(413);
    expect((await answered(post(routes, '/api/coin/echo', '{nope').res)).status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers 500 when the route throws', async () => {
    const r = await answered(post(mount(coinWithApi(async () => Promise.reject(new Error('boom')))), '/api/coin/echo', {}).res);
    expect(r.status).toBe(500);
  });

  it("refuses a route on the kit's own paths, or outside /api/", () => {
    for (const path of ['/api/decide', '/api/me', '/api/warm', '/api/highscores', '/api/seed', '/table/start']) {
      const game = { ...coinServer(), api: { routes: { [path]: async () => ({ status: 200, body: {} }) } } };
      expect(() => mount(game)).toThrow(/api/);
    }
  });

  it('says who pays: the signed-in player, else the free credits, else the local key; the free credits only when allowed', async () => {
    const seen: unknown[] = [];
    const handler = async (call: GameApiCall) => {
      seen.push([call.payer()?.mode ?? null, call.payer({ pool: false })?.mode ?? null]);
      return { status: 200, body: {} };
    };
    await answered(post(mount(coinWithApi(handler), {}, poolAccess()), '/api/coin/echo', {}, { ...JSON_POST, cookie: session() }).res);
    await answered(post(mount(coinWithApi(handler), {}, poolAccess()), '/api/coin/echo', {}).res);
    await answered(post(mount(coinWithApi(handler), { OPPER_API_KEY: 'op-dev', OPPER_PROJECT: 'p1' }, poolAccess()), '/api/coin/echo', {}).res);
    await answered(post(mount(coinWithApi(handler), { OPPER_API_KEY: 'op-dev' }, poolAccess({ open: false })), '/api/coin/echo', {}).res);
    await answered(post(mount(coinWithApi(handler)), '/api/coin/echo', {}).res);
    expect(seen).toEqual([
      ['player', 'player'],
      ['pool', null],
      ['pool', 'dev'],
      ['dev', 'dev'],
      [null, null],
    ]);
    let payer: unknown;
    await answered(post(mount(coinWithApi(async (call) => ((payer = call.payer()), { status: 200, body: {} })), { OPPER_API_KEY: 'op-dev', OPPER_PROJECT: 'p1' }), '/api/coin/echo', {}).res);
    expect(payer).toEqual({ mode: 'dev', provider: 'opper', apiKey: 'op-dev', baseUrl: 'https://api.opper.ai', project: 'p1' });
    await answered(post(mount(coinWithApi(async (call) => ((payer = call.payer()), { status: 200, body: {} }))), '/api/coin/echo', {}, { ...JSON_POST, cookie: session('op-ada') }).res);
    expect(payer).toEqual({ mode: 'player', provider: 'opper', apiKey: 'op-ada', baseUrl: 'https://api.opper.ai' });
  });

  it("says who is asking, as the free credits' limits count them: the connection's address, or the TRUSTED_PROXIES hop of X-Forwarded-For", async () => {
    const seen: string[] = [];
    const handler = async (call: GameApiCall) => (seen.push(call.visitor), { status: 200, body: {} });
    const forwarded = { ...JSON_POST, 'x-forwarded-for': '192.0.2.66, 198.51.100.7' };
    await answered(post(mount(coinWithApi(handler)), '/api/coin/echo', {}, forwarded).res);
    await answered(post(mount(coinWithApi(handler), { TRUSTED_PROXIES: '1' }), '/api/coin/echo', {}, forwarded).res);
    await answered(post(mount(coinWithApi(handler), {}, { ...poolAccess(), trustedProxies: 1 }), '/api/coin/echo', {}, forwarded).res);
    expect(seen).toEqual(['203.0.113.9', '198.51.100.7', '198.51.100.7']);
  });

  it('answers for an unpaid call: 402 when the free credits could have paid, else 401 sign in', async () => {
    const handler = async (call: GameApiCall) => call.unpaid({ pool: (call.body as { pool: boolean }).pool, error: 'Sign in to play the chat models' });
    expect(await answered(post(mount(coinWithApi(handler), {}, poolAccess({ open: false })), '/api/coin/echo', { pool: true }).res)).toMatchObject({ status: 402, body: { poolEmpty: true, signedOut: true } });
    expect(await answered(post(mount(coinWithApi(handler), {}, poolAccess()), '/api/coin/echo', { pool: false }).res)).toEqual({ status: 401, body: { error: 'Sign in to play the chat models', signedOut: true } });
    expect(await answered(post(mount(coinWithApi(handler)), '/api/coin/echo', { pool: true }).res)).toMatchObject({ status: 401, body: { signedOut: true } });
  });

  it("counts a free-credits call against the visitor's allowance (429 past it) and its cost against the pool", async () => {
    const access = poolAccess({ rate: 1 });
    const spent = vi.spyOn(access.pool, 'spent');
    const exhausted = vi.spyOn(access.pool, 'exhausted');
    const handler = async (call: GameApiCall) => {
      const refused = call.takePool();
      if (refused) return refused;
      call.poolSpent(0.002, (call.body as { empty?: boolean }).empty);
      return { status: 200, body: { ok: true } };
    };
    const routes = mount(coinWithApi(handler), {}, access);
    expect((await answered(post(routes, '/api/coin/echo', {}).res)).status).toBe(200);
    const second = post(routes, '/api/coin/echo', {}).res;
    expect((await answered(second)).status).toBe(429);
    expect(second.headers['Retry-After']).toBe('1');
    expect(spent).toHaveBeenCalledWith(0.002);
    expect(exhausted).not.toHaveBeenCalled();
    const access2 = poolAccess();
    const ex2 = vi.spyOn(access2.pool, 'exhausted');
    await answered(post(mount(coinWithApi(handler), {}, access2), '/api/coin/echo', { empty: true }).res);
    expect(ex2).toHaveBeenCalled();
  });

  it("seals values with the game's key for a purpose, HMAC(secret, 'decision-benchmarks:<slug>-<purpose>')", async () => {
    let token = '';
    const routes = mount(coinWithApi(async (call) => {
      const b = call.body as { token?: string };
      if (b.token) return { status: 200, body: { opened: call.open('table', b.token), other: call.open('other', b.token) } };
      token = call.seal('table', { seed: 7 });
      return { status: 200, body: { token } };
    }));
    await answered(post(routes, '/api/coin/echo', {}).res);
    expect(unseal(token, purposeKey(SECRET, 'coin-table'))).toEqual({ seed: 7 });
    expect((await answered(post(routes, '/api/coin/echo', { token }).res)).body).toEqual({ opened: { seed: 7 }, other: null });
  });

  it("clears the session when the route says the player's sign-in was refused", async () => {
    const { res } = post(mount(coinWithApi(async () => ({ status: 401, body: { signedOut: true }, clearSession: true }))), '/api/coin/echo', {}, { ...JSON_POST, cookie: session() });
    await answered(res);
    expect(String(res.headers['Set-Cookie'])).toMatch(new RegExp(`^${SESSION_COOKIE}=; Max-Age=0`));
  });

  it('aborts the call when the client goes away before the answer', async () => {
    let signal: AbortSignal | undefined;
    let finish: () => void = () => {};
    const { res } = post(mount(coinWithApi((call) => new Promise((resolve) => {
      signal = call.signal;
      finish = () => resolve({ status: 200, body: {} });
    }))), '/api/coin/echo', {});
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(signal!.aborted).toBe(false);
    res.emit('close');
    expect(signal!.aborted).toBe(true);
    finish();
  });
});
