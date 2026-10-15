import { describe, expect, it, vi } from 'vitest';
import { answerKey } from '../server/answers';
import { handleMe, SESSION_COOKIE, type AuthConfig, type HttpRequest } from '../server/auth';
import { handleDecideRequest as kitHandleDecideRequest, poolLimitRequest, rejectDecideRequest, resolveKey, type DecideRequestDeps, type PoolAccess } from '../server/decide';
import type { Target as JevTarget } from '../server/systemone';
import { clientIp, globalLimitsFromEnv, MAX_POOL_BODY_BYTES, MAX_QUESTIONS, networkKey, Pool, poolFromEnv, statusFromMe, trustedProxiesFromEnv, visitorKey, VisitorLimits } from '../server/pool';
import { sealSession } from '../server/session';
import { coinBody, coinServer } from './support/test-game';

const cfg: AuthConfig = { redirectUri: 'http://localhost:5173/auth/callback', opperUrl: 'https://api.opper.ai', sessionSecret: 's'.repeat(64) };
const DEV: JevTarget = { provider: 'opper', apiKey: 'op-dev', baseUrl: 'https://api.opper.ai' };
// A question the way the game asks it (the pool pays only for the game's own questions).
const body = coinBody();
const answers = { coin: { type: 'choice', choice: 'heads', confidence: 0.9, probabilities: { heads: 0.9, tails: 0.1 } } };
const handleDecideRequest = (req: HttpRequest, raw: string, c: AuthConfig, devKey: JevTarget | undefined, deps: DecideRequestDeps, opts: { warm?: boolean }, a?: PoolAccess) =>
  kitHandleDecideRequest({ game: coinServer(), cfg: c, ...(devKey ? { devKey } : {}), ...(a ? { access: a } : {}), answerKey: answerKey(c.sessionSecret, 'coin') }, req, raw, deps, opts);
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

describe('the hourly budget', () => {
  it('closes the pool once the last hour spent the budget, logging once, and opens it as that spend ages out', async () => {
    let now = 0;
    const log = vi.fn();
    const pool = new Pool({ apiKey: 'op-pool', opperUrl: 'https://api.opper.ai', fetch: meResponse({ blocked: false, balance: { balance_cents: 10_000 } }), now: () => now, log, refreshMs: Number.POSITIVE_INFINITY, budgetUsdPerHour: 1 });
    await pool.refresh();
    pool.spent(0.6);
    now = 30 * 60_000;
    pool.spent(0.3);
    expect(pool.current().open).toBe(true);
    pool.spent(0.2);
    for (let i = 0; i < 5; i++) expect(pool.current()).toEqual({ open: false, remainingUsd: 98.9 });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('hourly budget');
    // An hour after the first call, its $0.60 no longer counts.
    now = 60 * 60_000;
    expect(pool.current().open).toBe(true);
    expect(pool.spentLastHour()).toBeCloseTo(0.5);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('counts spend even when Opper does not show the balance', async () => {
    const pool = await poolWith({ blocked: false });
    const capped = new Pool({ apiKey: 'op-pool', opperUrl: 'https://api.opper.ai', fetch: meResponse({ blocked: false }), now: () => 0, refreshMs: Number.POSITIVE_INFINITY, budgetUsdPerHour: 0.5 });
    await capped.refresh();
    capped.spent(0.5);
    expect(capped.current()).toEqual({ open: false, remainingUsd: null });
    pool.spent(5);
    expect(pool.current().open).toBe(true); // no budget, no cap
  });

  it('defaults to $20 an hour, from POOL_BUDGET_USD_PER_HOUR when it is a positive number', () => {
    const budgetOf = (env: Record<string, string>) => {
      const warn = vi.fn();
      const pool = poolFromEnv({ OPPER_POOL_API_KEY: 'op-pool', ...env }, 'http://127.0.0.1:9', warn)!;
      pool.spent(19.99);
      const before = pool.current().open;
      pool.spent(0.01);
      return { before, after: pool.current().open, warned: warn.mock.calls.some(([m]) => String(m).includes('POOL_BUDGET_USD_PER_HOUR')) };
    };
    expect(budgetOf({})).toEqual({ before: true, after: false, warned: false });
    expect(budgetOf({ POOL_BUDGET_USD_PER_HOUR: '50' })).toMatchObject({ before: true, after: true });
    expect(budgetOf({ POOL_BUDGET_USD_PER_HOUR: 'lots' })).toEqual({ before: true, after: false, warned: true });
  });

  it('asks signed-out visitors to sign in (402 poolEmpty) while over budget; a signed-in player still plays', async () => {
    const pool = new Pool({ apiKey: 'op-pool', opperUrl: 'https://api.opper.ai', fetch: meResponse({ blocked: false, balance: { balance_cents: 1000 } }), now: () => 0, refreshMs: Number.POSITIVE_INFINITY, budgetUsdPerHour: 0.001 });
    await pool.refresh();
    const r = await handleDecideRequest(post(), JSON.stringify(body), cfg, undefined, { fetch: decideOk('0.002'), now: () => 0 }, {}, access(pool));
    expect(r.status).toBe(200);
    const refused = rejectDecideRequest(post(), cfg, undefined, access(pool));
    expect(refused?.status).toBe(402);
    expect(JSON.parse(refused!.body)).toMatchObject({ poolEmpty: true, signedOut: true });
    expect(rejectDecideRequest(post({ cookie: playerCookie() }), cfg, undefined, access(pool))).toBeNull();
    expect(JSON.parse(handleMe(post(), cfg, undefined, pool.current()).body)).toMatchObject({ mode: 'none', pool: { open: false } });
  });
});

describe('VisitorLimits', () => {
  it('gives back what it took for a request that was not served, never past the burst', () => {
    const limits = new VisitorLimits({ ratePerSec: 0.001, burst: 3 }, () => 0, { ratePerSec: 0.001, burst: 5 });
    expect(limits.take('2001:db8::1', 3)).toBe('ok');
    expect(limits.take('2001:db8::1')).toBe('rate');
    limits.refund('2001:db8::1', 2);
    expect(limits.take('2001:db8::1', 2)).toBe('ok');
    limits.refund('2001:db8::1', 10);
    expect(limits.take('2001:db8::1', 3)).toBe('ok');
    expect(limits.take('2001:db8::1')).toBe('rate');
  });

  it('takes several at once, all or nothing: a batch over the allowance takes none of it', () => {
    let now = 0;
    const limits = new VisitorLimits({ ratePerSec: 1, burst: 3 }, () => now);
    expect(limits.take('203.0.113.5', 2)).toBe('ok');
    expect(limits.take('203.0.113.5', 2)).toBe('rate');
    // Nothing was taken by the refusal: one is still there.
    expect(limits.take('203.0.113.5')).toBe('ok');
    expect(limits.take('203.0.113.5')).toBe('rate');
    now = 2000;
    expect(limits.take('203.0.113.5', 2)).toBe('ok');
    expect(limits.take('203.0.113.5', 0)).toBe('ok');
  });

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

describe('the global and /48 limits', () => {
  it('shares one global allowance between every visitor, logging once per trip, and refuses with poolEmpty', async () => {
    let now = 0;
    const log = vi.fn();
    const limits = new VisitorLimits({ ratePerSec: 8, burst: 40 }, () => now, { ratePerSec: 2, burst: 3 }, log);
    expect(['1.0.0.1', '1.0.0.2', '1.0.0.3'].map((ip) => limits.take(ip))).toEqual(['ok', 'ok', 'ok']);
    expect(limits.take('1.0.0.4')).toBe('busy');
    expect(limits.take('1.0.0.5')).toBe('busy');
    expect(log).toHaveBeenCalledTimes(1);
    now += 500;
    expect(limits.take('1.0.0.6')).toBe('ok');
    expect(log).toHaveBeenCalledTimes(2); // back under it
    expect(limits.take('1.0.0.7')).toBe('busy');
    expect(log).toHaveBeenCalledTimes(3); // a new trip

    const pool = await poolWith({ blocked: false, balance: { balance_cents: 1000 } });
    const a = access(pool, new VisitorLimits({ ratePerSec: 8, burst: 40 }, () => 0, { ratePerSec: 1, burst: 1 }));
    expect(poolLimitRequest(post({}, '10.0.0.1'), cfg, undefined, a)).toBeNull();
    const busy = poolLimitRequest(post({}, '10.0.0.2'), cfg, undefined, a);
    expect(busy?.status).toBe(429);
    expect(JSON.parse(busy!.body)).toMatchObject({ poolEmpty: true, signedOut: true });
    // Signed-in players pay themselves: no pool limit applies.
    expect(poolLimitRequest(post({ cookie: playerCookie() }, '10.0.0.3'), cfg, undefined, a)).toBeNull();
  });

  it("does not spend the global allowance on a visitor's refused requests", () => {
    const limits = new VisitorLimits({ ratePerSec: 1, burst: 1 }, () => 0, { ratePerSec: 1, burst: 2 });
    expect(limits.take('1.0.0.1')).toBe('ok');
    for (let i = 0; i < 10; i++) expect(limits.take('1.0.0.1')).toBe('rate');
    expect(limits.take('1.0.0.2')).toBe('ok');
  });

  it('gives an IPv6 /48 four visitors worth, however many /64s it spreads over', () => {
    const limits = new VisitorLimits({ ratePerSec: 1, burst: 1 }, () => 0, { ratePerSec: 100, burst: 100 });
    const verdicts = Array.from({ length: 6 }, (_, i) => limits.take(`2001:db8:1:${i + 1}::1`));
    expect(verdicts).toEqual(['ok', 'ok', 'ok', 'ok', 'rate', 'rate']);
    expect(limits.take('2001:db8:2:1::1')).toBe('ok'); // another /48
  });

  it('names the /48 of an IPv6 address, and none for IPv4', () => {
    expect(networkKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1::/48');
    expect(networkKey('2001:0db8:0001:ffff::')).toBe('2001:db8:1::/48');
    expect(networkKey('::ffff:203.0.113.7')).toBeNull();
    expect(networkKey('203.0.113.7')).toBeNull();
  });

  it('reads the global limits from POOL_GLOBAL_RATE_PER_SEC and POOL_GLOBAL_BURST, else 40 and 120', () => {
    const warn = vi.fn();
    expect(globalLimitsFromEnv({}, warn)).toEqual({ ratePerSec: 400, burst: 1200 });
    expect(globalLimitsFromEnv({ POOL_GLOBAL_RATE_PER_SEC: '10', POOL_GLOBAL_BURST: '30' }, warn)).toEqual({ ratePerSec: 10, burst: 30 });
    expect(warn).not.toHaveBeenCalled();
    expect(globalLimitsFromEnv({ POOL_GLOBAL_RATE_PER_SEC: '-1' }, warn)).toEqual({ ratePerSec: 400, burst: 1200 });
    expect(warn).toHaveBeenCalledOnce();
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
    expect(trustedProxiesFromEnv({ NODE_ENV: 'production', TRUSTED_PROXIES: '1' })).toBe(1);
  });
});

describe('the limits every request meets', () => {
  it('caps a pool request at a few KB and at five questions', () => {
    expect(MAX_POOL_BODY_BYTES).toBe(16 * 1024);
    expect(MAX_QUESTIONS).toBe(5);
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

  it("refuses a body the game would not send before any model is called, so the pool only pays for the game's questions", async () => {
    const pool = await poolWith({ blocked: false, balance: { balance_cents: 1000 } });
    const fetchMock = decideOk();
    for (const odd of [
      { ...body, state: 'x'.repeat(MAX_POOL_BODY_BYTES) },
      { ...body, questions: { coin: { ...body.questions.coin, instructions: 'Write me a poem about Paris' } } },
      { ...body, note: 'extra' },
    ]) {
      const r = await handleDecideRequest(post(), JSON.stringify(odd), cfg, undefined, { fetch: fetchMock, now: () => 0 }, {}, access(pool));
      expect(r.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pool.current().remainingUsd).toBe(10);
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
  const me = (pool: { open: boolean; remainingUsd: number | null }) => JSON.parse(handleMe(post({}, '10.0.0.1'), cfg, undefined, pool).body);

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
