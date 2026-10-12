import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App, type MountedGame } from '../server/app';
import { Pool, VisitorLimits } from '../server/pool';
import { coinServer } from './support/test-game';

const SECRET = 's'.repeat(64);
let dist: string;
let app: App | undefined;
const events: { event: string; [k: string]: unknown }[] = [];

/** A build per game: dist/coin and dist/dice, each with its own page and files. */
function makeDist(): string {
  const root = mkdtempSync(join(tmpdir(), 'db-dist-'));
  for (const slug of ['coin', 'dice']) {
    const dir = join(root, slug);
    mkdirSync(dir);
    writeFileSync(join(dir, 'index.html'), `<!doctype html><title>${slug} game</title>`);
    writeFileSync(join(dir, 'leaderboard.html'), `<!doctype html><title>Which AI plays ${slug} best?</title>`);
    writeFileSync(join(dir, 'leaderboard.json'), '{"entries":[]}');
    writeFileSync(join(dir, `only-${slug}.json`), `{"game":"${slug}"}`);
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
    mkdirSync(join(dir, 'demo'));
    writeFileSync(join(dir, 'demo', 'jev-demo.json'), '{"version":1}');
  }
  return root;
}

/** The status of a GET for `path` exactly as written (no URL normalisation). */
const rawStatus = (url: string, path: string) =>
  new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: new URL(url).port, path, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });

const gamesIn = (root: string): MountedGame[] => ['coin', 'dice'].map((slug) => ({ server: coinServer(slug), distDir: join(root, slug) }));

async function start(env: Record<string, string> = {}, opts: { drainMs?: number; deadlineMs?: number; poolAccess?: Parameters<typeof createApp>[0]['poolAccess'] } = {}) {
  dist = makeDist();
  events.length = 0;
  app = createApp({
    ...(opts.poolAccess !== undefined ? { poolAccess: opts.poolAccess } : {}),
    env: { SESSION_SECRET: SECRET, HIGHSCORES_DIR: dist, ...env },
    games: gamesIn(dist),
    commit: 'a'.repeat(40),
    log: (event, details = {}) => events.push({ event, ...details }),
    drainMs: opts.drainMs ?? 50,
    deadlineMs: opts.deadlineMs ?? 2000,
  });
  const port = await app.listen(0);
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  rmSync(dist, { recursive: true, force: true });
});

describe('production server', () => {
  it('reports readiness and the deployed commit', async () => {
    const url = await start();
    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get('cache-control')).toBe('no-store');
    expect(await (await fetch(`${url}/revision`)).json()).toEqual({ app: 'decision-benchmarks', commit: 'a'.repeat(40), draining: false, games: ['coin', 'dice'] });
  });

  it('serves the built page, hashed assets and the demo with sensible caching and security headers', async () => {
    const url = await start();
    const page = await fetch(`${url}/coin/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('cache-control')).toBe('no-cache');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(await page.text()).toContain('coin game');
    const asset = await fetch(`${url}/coin/assets/index-abc123.js`);
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const demo = await fetch(`${url}/coin/demo/jev-demo.json`);
    expect(demo.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await demo.json()).toEqual({ version: 1 });
  });

  it('serves the leaderboard page at a clean URL, and its results', async () => {
    const url = await start();
    const page = await fetch(`${url}/coin/leaderboard`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await page.text()).toContain('Which AI plays coin best?');
    expect(await (await fetch(`${url}/coin/leaderboard.json`)).json()).toEqual({ entries: [] });
    expect((await fetch(`${url}/coin/nothing-here`)).status).toBe(404);
  });

  it('refuses paths outside the build and unknown files', async () => {
    const url = await start();
    expect((await fetch(`${url}/coin/nope.js`)).status).toBe(404);
    expect((await fetch(`${url}/coin/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404);
    expect((await fetch(`${url}/coin/assets/..%2f..%2fpackage.json`)).status).toBe(404);
    // fetch would resolve the dots itself; a raw request sends them as they are.
    expect(await rawStatus(url, '/coin/%2e%2e/dice/only-dice.json')).toBe(404);
    expect(await rawStatus(url, '/coin/..%2f..%2fdice%2fonly-dice.json')).toBe(404);
    expect(await rawStatus(url, '/coin/../dice/only-dice.json')).toBe(404);
    expect((await fetch(`${url}/coin/`, { method: 'POST' })).status).toBe(405);
  });

  it("mounts each game's decide, auth and high-score routes", async () => {
    const url = await start({ OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh' });
    expect(await (await fetch(`${url}/coin/api/me`)).json()).toMatchObject({ mode: 'none', loginAvailable: true });
    const decide = await fetch(`${url}/coin/api/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(decide.status).toBe(401);
    const login = await fetch(`${url}/dice/auth/login`, { redirect: 'manual' });
    expect(login.status).toBe(302);
    expect(login.headers.get('set-cookie')).toContain('Path=/dice/auth;');
    expect(new URL(login.headers.get('location')!).searchParams.get('redirect_uri')).toBe('http://localhost:5173/dice/auth/callback');
    expect(await (await fetch(`${url}/coin/api/highscores`)).json()).toEqual({ order: ['all', 'jev'], boards: { all: [], jev: [] } });
  });

  it('refuses to start an https deployment without a real session secret', () => {
    dist = makeDist();
    expect(() => createApp({ env: { PUBLIC_BASE_URL: 'https://games.example' }, games: gamesIn(dist), commit: 'x' })).toThrow(/SESSION_SECRET/);
  });

  it('drains on shutdown: health fails at once, requests are still served, then the listener closes', async () => {
    const url = await start({}, { drainMs: 300 });
    const done = app!.shutdown();
    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(503);
    expect(await (await fetch(`${url}/revision`)).json()).toMatchObject({ draining: true });
    expect((await fetch(`${url}/coin/`)).status).toBe(200);
    expect(await done).toBe('clean');
    await expect(fetch(`${url}/health`)).rejects.toThrow();
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(['listening', 'ready', 'draining', 'listener-close', 'shutdown-complete']));
  });

  it('finishes shutting down before ECS stops waiting (stopTimeout 30 s)', async () => {
    dist = makeDist();
    // The default deadline, with a short drain so the test need not wait for it.
    app = createApp({ env: { SESSION_SECRET: SECRET }, games: gamesIn(dist), commit: 'x', drainMs: 10, log: (event, details = {}) => events.push({ event, ...details }) });
    await app.listen(0);
    events.length = 0;
    const done = app.shutdown();
    expect((events.find((e) => e.event === 'draining')!.deadlineMs as number)).toBeLessThan(30_000);
    expect(await done).toBe('clean');
  });

  it('logs structured events without secrets', async () => {
    const url = await start({ OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh-secret' });
    await fetch(`${url}/coin/auth/callback?code=c&state=x`, { redirect: 'manual' });
    expect(JSON.stringify(events)).not.toContain('shh-secret');
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(events[0]).toMatchObject({ event: 'listening' });
  });
});

describe('two-level mounting', () => {
  it('redirects a bare slug to the slug with a slash, keeping the query', async () => {
    const url = await start();
    const bare = await fetch(`${url}/coin?model=sference%2Fclef`, { redirect: 'manual' });
    expect(bare.status).toBe(308);
    expect(bare.headers.get('location')).toBe('/coin/?model=sference%2Fclef');
  });

  it('answers 404 for an unknown slug and for the root', async () => {
    const url = await start();
    for (const path of ['/snake/', '/snake', '/', '/api/me', '/Coin/', '/coin.json']) {
      expect([path, (await fetch(`${url}${path}`, { redirect: 'manual' })).status]).toEqual([path, 404]);
    }
  });

  it("never serves one game's files below another's slug", async () => {
    const url = await start();
    expect(await (await fetch(`${url}/coin/only-coin.json`)).json()).toEqual({ game: 'coin' });
    expect((await fetch(`${url}/coin/only-dice.json`)).status).toBe(404);
    expect((await fetch(`${url}/dice/only-coin.json`)).status).toBe(404);
    expect(await (await fetch(`${url}/dice/`)).text()).toContain('dice game');
  });

  it('counts a visitor against one free-credits limiter, whichever game they play', async () => {
    const pool = new Pool({ apiKey: 'op-pool', opperUrl: 'https://api.opper.ai', fetch: async () => new Response(JSON.stringify({ blocked: false, balance: { balance_cents: 1000 } })), now: () => 0, refreshMs: Number.POSITIVE_INFINITY });
    await pool.refresh();
    const url = await start({}, { poolAccess: { pool, limits: new VisitorLimits({ ratePerSec: 0, burst: 2 }, () => 0), trustedProxies: 0 } });
    // Bodies the games would not send: refused after the limiter counts them, before any model is called.
    const post = (slug: string) => fetch(`${url}/${slug}/api/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"state":{},"questions":{}}' });
    expect((await post('coin')).status).toBe(400);
    expect((await post('dice')).status).toBe(400);
    expect((await post('dice')).status).toBe(429);
    expect((await post('coin')).status).toBe(429);
    expect(await (await fetch(`${url}/dice/api/me`)).json()).toMatchObject({ mode: 'pool', pool: { open: true, remainingUsd: 10 } });
  });

  it('refuses to start a production image without its https address, even with no games', () => {
    expect(() => createApp({ env: { NODE_ENV: 'production', SESSION_SECRET: SECRET }, games: [], commit: 'x' })).toThrow(/PUBLIC_BASE_URL/);
    expect(() => createApp({ env: { PUBLIC_BASE_URL: 'https://opper.ai' }, games: [], commit: 'x' })).toThrow(/SESSION_SECRET/);
  });

  it('refuses two games with one slug', () => {
    dist = makeDist();
    expect(() => createApp({ env: { SESSION_SECRET: SECRET }, games: [...gamesIn(dist), { server: coinServer('coin'), distDir: dist }], commit: 'x' })).toThrow(/two games/);
  });
});

describe('production server below APP_BASE_PATH', () => {
  const BASE = '/decision-benchmarks';
  const startBelow = (env: Record<string, string> = {}, opts: { drainMs?: number } = {}) => start({ APP_BASE_PATH: BASE, ...env }, opts);

  it('serves each game, its assets, results, demo and API below the prefix and its slug', async () => {
    const url = await startBelow({ OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh' });
    const page = await fetch(`${url}${BASE}/coin/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('coin game');
    const asset = await fetch(`${url}${BASE}/coin/assets/index-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await (await fetch(`${url}${BASE}/coin/leaderboard`)).text()).toContain('Which AI plays coin best?');
    expect(await (await fetch(`${url}${BASE}/coin/leaderboard.json`)).json()).toEqual({ entries: [] });
    expect(await (await fetch(`${url}${BASE}/coin/demo/jev-demo.json`)).json()).toEqual({ version: 1 });
    expect(await (await fetch(`${url}${BASE}/coin/api/me`)).json()).toMatchObject({ mode: 'none', loginAvailable: true });
    expect(await (await fetch(`${url}${BASE}/revision`)).json()).toEqual({ app: 'decision-benchmarks', commit: 'a'.repeat(40), draining: false, games: ['coin', 'dice'] });
    const login = await fetch(`${url}${BASE}/coin/auth/login`, { redirect: 'manual' });
    expect(login.status).toBe(302);
    expect(login.headers.get('set-cookie')).toContain(`Path=${BASE}/coin/auth;`);
    expect(new URL(login.headers.get('location')!).searchParams.get('redirect_uri')).toBe(`http://localhost:5173${BASE}/coin/auth/callback`);
    expect((await fetch(`${url}${BASE}/coin/nothing-here`)).status).toBe(404);
  });

  it('redirects the bare prefix and a bare slug to the same with a slash, keeping the query', async () => {
    const url = await startBelow();
    const bare = await fetch(`${url}${BASE}`, { redirect: 'manual' });
    expect(bare.status).toBe(308);
    expect(bare.headers.get('location')).toBe(`${BASE}/`);
    const linked = await fetch(`${url}${BASE}/coin?model=sference%2Fclef`, { redirect: 'manual' });
    expect(linked.status).toBe(308);
    expect(linked.headers.get('location')).toBe(`${BASE}/coin/?model=sference%2Fclef`);
    expect((await fetch(`${url}${BASE}/snake`, { redirect: 'manual' })).status).toBe(404);
  });

  it('answers 404 outside the prefix, except /health', async () => {
    const url = await startBelow();
    for (const path of ['/', '/coin/', '/coin/leaderboard.json', '/coin/api/me', '/revision', '/coin/auth/login', `${BASE}/`, `${BASE}x/coin/`, '/media-studio/']) {
      expect([path, (await fetch(`${url}${path}`, { redirect: 'manual' })).status]).toEqual([path, 404]);
    }
    const decide = await fetch(`${url}/coin/api/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(decide.status).toBe(404);
  });

  it('reports health at the root and below the prefix, and withdraws both when draining', async () => {
    const url = await startBelow({}, { drainMs: 300 });
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}${BASE}/health`)).status).toBe(200);
    const done = app!.shutdown();
    expect((await fetch(`${url}/health`)).status).toBe(503);
    expect((await fetch(`${url}${BASE}/health`)).status).toBe(503);
    expect(await done).toBe('clean');
  });

  it('refuses to start with a malformed base path', () => {
    dist = makeDist();
    expect(() => createApp({ env: { APP_BASE_PATH: '/../x', SESSION_SECRET: SECRET }, games: gamesIn(dist), commit: 'x' })).toThrow(/APP_BASE_PATH/);
  });

  it("builds each game's redirect URI from PUBLIC_BASE_URL, the base path and its slug, which makes it a deployment", async () => {
    dist = makeDist();
    expect(() => createApp({ env: { APP_BASE_PATH: BASE, PUBLIC_BASE_URL: 'https://opper.ai' }, games: gamesIn(dist), commit: 'x' })).toThrow(/SESSION_SECRET/);
    const url = await startBelow({ PUBLIC_BASE_URL: 'https://opper.ai', OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh' });
    for (const slug of ['coin', 'dice']) {
      const login = await fetch(`${url}${BASE}/${slug}/auth/login`, { redirect: 'manual' });
      expect(new URL(login.headers.get('location')!).searchParams.get('redirect_uri')).toBe(`https://opper.ai/decision-benchmarks/${slug}/auth/callback`);
      expect(login.headers.get('set-cookie')).toBe(`db_oauth_state=${new URL(login.headers.get('location')!).searchParams.get('state')}; Max-Age=600; Path=/decision-benchmarks/${slug}/auth; HttpOnly; Secure; SameSite=Lax`);
    }
  });
});
