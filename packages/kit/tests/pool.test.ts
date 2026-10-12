import { describe, expect, it, vi } from 'vitest';
import { handleMe, SESSION_COOKIE, type AuthConfig, type HttpRequest } from '../server/auth';
import { handleDecideRequest, poolLimitRequest, rejectDecideRequest, resolveKey, type PoolAccess } from '../server/decide';
import type { JevTarget } from '../server/jev';
import { clientIp, MAX_POOL_BODY_BYTES, Pool, poolAcceptsBody, statusFromMe, trustedProxiesFromEnv, visitorKey, VisitorLimits } from '../server/pool';
import { sealSession } from '../server/session';

const cfg: AuthConfig = { redirectUri: 'http://localhost:5173/auth/callback', opperUrl: 'https://api.opper.ai', sessionSecret: 's'.repeat(64) };
const DEV: JevTarget = { provider: 'opper', apiKey: 'op-dev', baseUrl: 'https://api.opper.ai' };
// A question the way the game words it (the pool pays only for the game's own questions).
const body = {
  state: { maze: ['#####', '#.P.#', '#####'], mode: 'chase', lives: 3 },
  questions: { blinky: { type: 'choice', instructions: 'You are Blinky, the red ghost. You are relentless: always close the distance to Pac-Man directly. You are approaching junction (1,1) heading left. Pick the direction to take there.', criteria: { left: 'Go left: Pac-Man 4 steps away via this route', up: 'Go up: Pac-Man 6 steps away via this route' } } },
};
const answers = { blinky: { type: 'choice', choice: 'up', confidence: 0.9, probabilities: { up: 0.9, left: 0.1 } } };
const post = (headers: HttpRequest['headers'] = {}, remoteAddress = '10.0.0.1'): HttpRequest => ({ method: 'POST', url: '/api/decide', headers: { 'content-type': 'application/json', ...headers }, remoteAddress });
const playerCookie = () => `${SESSION_COOKIE}=${encodeURIComponent(sealSession({ v: 1, apiKey: 'op-player', user: {}, issuedAt: Date.now() }, cfg.sessionSecret))}`;

const meResponse = (body: unknown, status = 200) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
const decideOk = (cost = '0.002') =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ answers, usage: { input_tokens: 5, output_tokens: 2 } }), { status: 200, headers: { 'x-opper-cost': cost } }));

/** A pool whose balance read returns `me` and never refreshes on its own during a test. */
async function poolWith(me: unknown): Promise<Pool> {
  const pool = new Pool({ apiKey: 'op-pool', opperUrl: 'https://api.opper.ai', fetch: meResponse(me), now: () => 0, refreshMs: Number.POSITIVE_INFINITY });
  await pool.refresh();
  return pool;
}

const access = (pool: Pool, limits = new VisitorLimits({ ratePerSec: 8, burst: 40 }, () => 0)): PoolAccess => ({ pool, limits, trustedProxies: 0 });

describe('statusFromMe', () => {
  it('is open while the organization balance is above zero and spending is not blocked', () => {
    expect(statusFromMe({ blocked: false, balance: { balance_cents: 8412 } })).toEqual({ open: true, remainingUsd: 84.12 });
    expect(statusFromMe({ blocked: false, balance: { balance_cents: 0 } })).toEqual({ open: false, remainingUsd: 0 });
    expect(statusFromMe({ blocked: true, block_reason: 'balance_exhausted', balance: { balance_cents: -3 } })).toEqual({ open: false, remainingUsd: 0 });
  });

  it('stays open without a balance it may not see (the key owner lacks billing:read), unless blocked', () => {
    expect(statusFromMe({ blocked: false })).toEqual({ open: true, remainingUsd: null });
    expect(statusFromMe({ blocked: true })).toEqual({ open: false, remainingUsd: null });
    expect(statusFromMe('nonsense')).toBeNull();
  });
});

describe('Pool', () => {
  it('reads the balance from GET /v3/me with the pool key', async () => {
    const fetchMock = meResponse({ blocked: false, balance: { balance_cents: 10000 } });
    const pool = new Pool({ apiKey: 'op-pool', opperUrl: 'https://api.opper.ai/', fetch: fetchMock, now: () => 0 });
    expect(await pool.refresh()).toEqual({ open: true, remainingUsd: 100 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.opper.ai/v3/me');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer op-pool');
  });

  it('counts calls down between reads and closes when Opper refuses for money', async () => {
    const pool = await poolWith({ blocked: false, balance: { balance_cents: 100 } });
    pool.spent(0.25);
    pool.spent(null);
    expect(pool.current()).toEqual({ open: true, remainingUsd: 0.75 });
    pool.exhausted();
    expect(pool.current()).toEqual({ open: false, remainingUsd: 0 });
  });

  it('asks Opper again as soon as the local count reaches zero', async () => {
    const fetchMock = meResponse({ blocked: false, balance: { balance_cents: 10 } });
    const pool = new Pool({ apiKey: 'op-pool', opperUrl: 'https://api.opper.ai', fetch: fetchMock, now: () => 0, refreshMs: Number.POSITIVE_INFINITY });
    await pool.refresh();
    pool.spent(0.1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the last status when the balance cannot be read, and closes for a rejected key', async () => {
    let status = 200;
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ blocked: false, balance: { balance_cents: 500 } }), { status }));
    const log = vi.fn();
    const pool = new Pool({ apiKey: 'op-pool', opperUrl: 'https://api.opper.ai', fetch: fetchMock, now: () => 0, log });
    await pool.refresh();
    status = 503;
    expect(await pool.refresh()).toEqual({ open: true, remainingUsd: 5 });
    status = 401;
    expect(await pool.refresh()).toEqual({ open: false, remainingUsd: 0 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('rejected'));
  });

  it('refreshes in the background once the last read is older than refreshMs', async () => {
    let now = 0;
    const fetchMock = meResponse({ blocked: false, balance: { balance_cents: 100 } });
    const pool = new Pool({ apiKey: 'op-pool', opperUrl: 'https://api.opper.ai', fetch: fetchMock, now: () => now, refreshMs: 30_000 });
    await pool.refresh();
    pool.current();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now = 30_000;
    pool.current();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('VisitorLimits', () => {
  it('allows a burst, then the sustained rate', () => {
    let now = 0;
    const limits = new VisitorLimits({ ratePerSec: 2, burst: 3 }, () => now);
    expect([1, 2, 3].map(() => limits.take('a'))).toEqual(['ok', 'ok', 'ok']);
    expect(limits.take('a')).toBe('rate');
    expect(limits.take('b')).toBe('ok'); // another visitor has their own allowance
    now += 500;
    expect(limits.take('a')).toBe('ok');
    expect(limits.take('a')).toBe('rate');
  });
});

describe('clientIp', () => {
  const req = (xff: string | undefined): HttpRequest => ({ method: 'POST', url: '/', headers: xff ? { 'x-forwarded-for': xff } : {}, remoteAddress: '10.0.0.9' });

  it('takes the address the first trusted proxy saw, not what the client wrote before it', () => {
    // client-written, viewer (added by CloudFront), CloudFront edge (added by the load balancer)
    expect(clientIp(req('1.1.1.1, 203.0.113.7, 130.176.0.1'), 2)).toBe('203.0.113.7');
    expect(clientIp(req('203.0.113.7, 130.176.0.1'), 2)).toBe('203.0.113.7');
  });

  it('uses the connection address without trusted proxies, or when the header is short', () => {
    expect(clientIp(req('1.1.1.1'), 0)).toBe('10.0.0.9');
    expect(clientIp(req('203.0.113.7'), 2)).toBe('10.0.0.9');
    expect(clientIp(req(undefined), 2)).toBe('10.0.0.9');
  });

  it('defaults to two trusted proxies in production (CloudFront and the load balancer)', () => {
    expect(trustedProxiesFromEnv({ NODE_ENV: 'production' })).toBe(2);
    expect(trustedProxiesFromEnv({})).toBe(0);
    expect(trustedProxiesFromEnv({ NODE_ENV: 'production', JEV_TRUSTED_PROXIES: '1' })).toBe(1);
  });
});

describe('poolAcceptsBody', () => {
  it('accepts what a game sends and refuses oversized or odd requests', () => {
    expect(poolAcceptsBody(JSON.stringify(body))).toBe(true);
    expect(poolAcceptsBody(JSON.stringify({ ...body, state: 'x'.repeat(MAX_POOL_BODY_BYTES) }))).toBe(false);
    const six = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((k) => [k, body.questions.blinky]));
    expect(poolAcceptsBody(JSON.stringify({ ...body, questions: six }))).toBe(false);
    expect(poolAcceptsBody('not json')).toBe(false);
  });
});

describe('the free credits in /api/decide', () => {
  it('pays for signed-out visitors while open; a signed-in player always uses their own key', async () => {
    const pool = await poolWith({ blocked: false, balance: { balance_cents: 1000 } });
    expect(resolveKey(null, DEV, cfg.opperUrl, pool)?.mode).toBe('pool');
    expect(resolveKey({ v: 1, apiKey: 'op-player', user: {}, issuedAt: 0 }, DEV, cfg.opperUrl, pool)?.mode).toBe('player');
    pool.exhausted();
    expect(resolveKey(null, DEV, cfg.opperUrl, pool)?.mode).toBe('dev');
    expect(resolveKey(null, undefined, cfg.opperUrl, pool)).toBeNull();
  });

  it('answers 402 poolEmpty once the pool is empty, so the page asks the visitor to sign in', async () => {
    const pool = await poolWith({ blocked: true, block_reason: 'balance_exhausted', balance: { balance_cents: 0 } });
    const r = rejectDecideRequest(post(), cfg, undefined, access(pool));
    expect(r?.status).toBe(402);
    expect(JSON.parse(r!.body)).toMatchObject({ poolEmpty: true, signedOut: true });
    expect(rejectDecideRequest(post({ cookie: playerCookie() }), cfg, undefined, access(pool))).toBeNull();
  });

  it('calls the model with the pool key, then counts the cost against the pool', async () => {
    const pool = await poolWith({ blocked: false, balance: { balance_cents: 100 } });
    const fetchMock = decideOk('0.002');
    const r = await handleDecideRequest(post(), JSON.stringify(body), cfg, undefined, { fetch: fetchMock, now: () => 0 }, {}, access(pool));
    expect(r.status).toBe(200);
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer op-pool');
    expect(pool.current().remainingUsd).toBeCloseTo(0.998);
  });

  it('closes the pool when Opper refuses a call for money', async () => {
    const pool = await poolWith({ blocked: false, balance: { balance_cents: 1 } });
    const broke = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: 'insufficient balance' }), { status: 402 }));
    const r = await handleDecideRequest(post(), JSON.stringify(body), cfg, undefined, { fetch: broke, now: () => 0 }, {}, access(pool));
    expect(r.status).toBe(402);
    expect(JSON.parse(r.body)).toMatchObject({ poolEmpty: true });
    expect(pool.current().open).toBe(false);
  });

  it('refuses a request bigger than a game sends, without calling the model', async () => {
    const pool = await poolWith({ blocked: false, balance: { balance_cents: 1000 } });
    const fetchMock = decideOk();
    const big = JSON.stringify({ ...body, state: 'x'.repeat(MAX_POOL_BODY_BYTES) });
    const r = await handleDecideRequest(post(), big, cfg, undefined, { fetch: fetchMock, now: () => 0 }, {}, access(pool));
    expect(r.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('slows down a visitor who sends faster than a game does', async () => {
    const pool = await poolWith({ blocked: false, balance: { balance_cents: 1000 } });
    const a = access(pool, new VisitorLimits({ ratePerSec: 1, burst: 2 }, () => 0));
    expect(poolLimitRequest(post(), cfg, undefined, a)).toBeNull();
    expect(poolLimitRequest(post(), cfg, undefined, a)).toBeNull();
    expect(poolLimitRequest(post(), cfg, undefined, a)?.status).toBe(429);
    // Signed-in players are not limited: they pay themselves.
    expect(poolLimitRequest(post({ cookie: playerCookie() }), cfg, undefined, a)).toBeNull();
  });
});

describe('/api/me with the free credits', () => {
  const me = (pool: { open: boolean; remainingUsd: number | null }) => JSON.parse(handleMe(post({}, '10.0.0.1'), cfg, undefined, {}, pool).body);

  it('plays on the pool while it is open and shows its balance', () => {
    expect(me({ open: true, remainingUsd: 84.12 })).toMatchObject({ mode: 'pool', pool: { open: true, remainingUsd: 84.12 }, models: expect.arrayContaining(['typesafe/jev-1.13.0']) });
  });

  it('is signed out (sign in to play) once it is empty', () => {
    expect(me({ open: false, remainingUsd: 0 })).toMatchObject({ mode: 'none', pool: { open: false, remainingUsd: 0 } });
  });
});

describe('visitorKey', () => {
  it('counts IPv4 addresses one by one and IPv6 by /64', () => {
    expect(visitorKey('203.0.113.7')).toBe('203.0.113.7');
    expect(visitorKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(visitorKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(visitorKey('2001:db8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64');
    expect(visitorKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
  });

  it('one /64 shares one allowance', () => {
    const limits = new VisitorLimits({ ratePerSec: 1, burst: 2 }, () => 0);
    expect(limits.take('2001:db8:1:2::1')).toBe('ok');
    expect(limits.take('2001:db8:1:2::2')).toBe('ok');
    expect(limits.take('2001:db8:1:2::3')).toBe('rate');
  });
});
