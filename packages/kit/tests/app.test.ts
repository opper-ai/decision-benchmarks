import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createApp, htmlCsp, inlineScriptHashes, SVG_CSP, type App, type MountedGame } from '../server/app';
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
    writeFileSync(join(dir, '.secret.txt'), 'hidden');
    writeFileSync(join(dir, '.env'), 'hidden');
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'config.json'), 'hidden');
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

async function start(
  env: Record<string, string> = {},
  opts: { drainMs?: number; deadlineMs?: number; poolAccess?: Parameters<typeof createApp>[0]['poolAccess']; moved?: Record<string, string> } = {},
) {
  dist = makeDist();
  events.length = 0;
  app = createApp({
    ...(opts.poolAccess !== undefined ? { poolAccess: opts.poolAccess } : {}),
    ...(opts.moved ? { moved: opts.moved } : {}),
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

  it("sends a page a Content-Security-Policy that allows its own inline scripts by hash, and an SVG one that runs nothing", async () => {
    const url = await start();
    const theme = 'document.documentElement.dataset.t = "1";';
    writeFileSync(join(dist, 'coin', 'index.html'), `<!doctype html><script>${theme}</script><script type="module" src="/x.js"></script><title>coin game</title>`);
    writeFileSync(join(dist, 'coin', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const page = await fetch(`${url}/coin/`);
    const csp = page.headers.get('content-security-policy')!;
    const hash = `'sha256-${createHash('sha256').update(theme).digest('base64')}'`;
    expect(csp).toContain(`script-src 'self' ${hash};`);
    for (const d of ["object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'", "worker-src 'self' blob:"]) expect(csp).toContain(d);
    expect(csp).not.toMatch(/script-src[^;]*unsafe/); // scripts never get unsafe-inline
    expect(Number(page.headers.get('content-length'))).toBe((await page.arrayBuffer()).byteLength);
    // An edited page gets the hashes of what it now holds.
    writeFileSync(join(dist, 'coin', 'index.html'), '<!doctype html><script>other()</script><title>coin game, longer</title>');
    expect((await fetch(`${url}/coin/`)).headers.get('content-security-policy')).not.toContain(hash);
    const svg = await fetch(`${url}/coin/logo.svg`);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('content-security-policy')).toBe(SVG_CSP);
    expect(SVG_CSP).toMatch(/^sandbox; default-src 'none'/);
    const json = await fetch(`${url}/coin/leaderboard.json`);
    expect(json.headers.get('content-security-policy')).toBeNull();
  });

  it('hashes inline scripts only, once each', () => {
    const html = '<script>a()</script><SCRIPT type="text/javascript">a()</SCRIPT><script src="/b.js"></script><script async src=/c.js>ignored</script><script>\n b()\n</script>';
    expect(inlineScriptHashes(html)).toHaveLength(2);
    expect(htmlCsp('<p>no scripts</p>')).toContain("script-src 'self';");
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
    // Hidden files, with or without an extension, and anything in a hidden folder.
    for (const path of ['/coin/.secret.txt', '/coin/.env', '/coin/.git/config.json', '/coin/%2esecret.txt']) expect([path, await rawStatus(url, path)]).toEqual([path, 404]);
    expect((await fetch(`${url}/coin/`, { method: 'POST' })).status).toBe(405);
  });

  it("mounts each game's decide and high-score routes, and one sign-in for all of them", async () => {
    const url = await start({ OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh' });
    expect(await (await fetch(`${url}/coin/api/me`)).json()).toMatchObject({ mode: 'none', loginAvailable: true });
    const decide = await fetch(`${url}/coin/api/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(decide.status).toBe(401);
    const login = await fetch(`${url}/auth/login?return=%2Fdice%2F`, { redirect: 'manual' });
    expect(login.status).toBe(302);
    expect(login.headers.get('set-cookie')).toContain('Path=/auth;');
    expect(new URL(login.headers.get('location')!).searchParams.get('redirect_uri')).toBe('http://localhost:5173/auth/callback');
    // A game's old sign-in address sends the player to the shared one.
    const old = await fetch(`${url}/dice/auth/login`, { redirect: 'manual' });
    expect([old.status, old.headers.get('location')]).toEqual([302, '/auth/login?return=%2Fdice%2F']);
    expect((await fetch(`${url}/auth/nothing`)).status).toBe(404);
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
    await fetch(`${url}/auth/callback?code=c&state=x`, { redirect: 'manual' });
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
  const startBelow = (env: Record<string, string> = {}, opts: { drainMs?: number; moved?: Record<string, string> } = {}) =>
    start({ APP_BASE_PATH: BASE, ...env }, opts);

  it('sends a game that moved elsewhere on the site there for good, with the rest of its path and query', async () => {
    const url = await startBelow({}, { moved: { jevman: '/jevman-benchmark/' } });
    for (const [path, to] of [
      [`${BASE}/jevman`, '/jevman-benchmark/'],
      [`${BASE}/jevman?ref=hn`, '/jevman-benchmark/?ref=hn'],
      [`${BASE}/jevman/`, '/jevman-benchmark/'],
      [`${BASE}/jevman/leaderboard?x=1`, '/jevman-benchmark/leaderboard?x=1'],
      [`${BASE}/jevman/demo/jev-demo.json`, '/jevman-benchmark/demo/jev-demo.json'],
    ]) {
      const res = await fetch(`${url}${path}`, { redirect: 'manual' });
      expect([path, res.status, res.headers.get('location')]).toEqual([path, 308, to]);
    }
    const api = await fetch(`${url}${BASE}/jevman/api/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', redirect: 'manual' });
    expect([api.status, api.headers.get('location')]).toEqual([308, '/jevman-benchmark/api/decide']);
    expect((await fetch(`${url}/jevman/`, { redirect: 'manual' })).status).toBe(404);
    expect((await fetch(`${url}${BASE}/coin/`)).status).toBe(200);
  });

  it('refuses a moved game that is also served here, and a move to anything but a path on this site', () => {
    dist = makeDist();
    const withMoved = (moved: Record<string, string>) => () => createApp({ env: { SESSION_SECRET: SECRET }, games: gamesIn(dist), moved, commit: 'x' });
    expect(withMoved({ coin: '/coin-elsewhere/' })).toThrow(/only be one/);
    for (const to of ['https://evil.example/', '//evil.example/', '/no-slash', 'relative/', '/a?b/', '/a\\b/']) {
      expect(withMoved({ jevman: to })).toThrow(/path from the root/);
    }
  });

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
    const login = await fetch(`${url}${BASE}/auth/login?return=${encodeURIComponent(`${BASE}/coin/`)}`, { redirect: 'manual' });
    expect(login.status).toBe(302);
    expect(login.headers.get('set-cookie')).toContain(`Path=${BASE}/auth;`);
    expect(new URL(login.headers.get('location')!).searchParams.get('redirect_uri')).toBe(`http://localhost:5173${BASE}/auth/callback`);
    expect((await fetch(`${url}${BASE}/coin/nothing-here`)).status).toBe(404);
  });

  it('sends the prefix with a slash to the hub at the bare prefix, which is not ours, and a bare slug to the slug with a slash', async () => {
    const url = await startBelow();
    expect((await fetch(`${url}${BASE}`, { redirect: 'manual' })).status).toBe(404);
    const slashed = await fetch(`${url}${BASE}/?ref=x`, { redirect: 'manual' });
    expect(slashed.status).toBe(308);
    expect(slashed.headers.get('location')).toBe(`${BASE}?ref=x`);
    const linked = await fetch(`${url}${BASE}/coin?model=sference%2Fclef`, { redirect: 'manual' });
    expect(linked.status).toBe(308);
    expect(linked.headers.get('location')).toBe(`${BASE}/coin/?model=sference%2Fclef`);
    expect((await fetch(`${url}${BASE}/snake`, { redirect: 'manual' })).status).toBe(404);
  });

  it('answers 404 outside the prefix, except /health', async () => {
    const url = await startBelow();
    for (const path of ['/', '/coin/', '/coin/leaderboard.json', '/coin/api/me', '/revision', '/coin/auth/login', '/auth/login', '/auth/callback', `${BASE}x/coin/`, '/media-studio/']) {
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

  it('builds the one redirect URI from PUBLIC_BASE_URL and the base path, which makes it a deployment', async () => {
    dist = makeDist();
    expect(() => createApp({ env: { APP_BASE_PATH: BASE, PUBLIC_BASE_URL: 'https://opper.ai' }, games: gamesIn(dist), commit: 'x' })).toThrow(/SESSION_SECRET/);
    const url = await startBelow({ PUBLIC_BASE_URL: 'https://opper.ai', OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh' });
    for (const slug of ['coin', 'dice']) {
      const login = await fetch(`${url}${BASE}/auth/login?return=${encodeURIComponent(`${BASE}/${slug}/`)}`, { redirect: 'manual' });
      expect(new URL(login.headers.get('location')!).searchParams.get('redirect_uri')).toBe('https://opper.ai/decision-benchmarks/auth/callback');
      expect(login.headers.get('set-cookie')).toMatch(new RegExp(`^db_oauth_state=${new URL(login.headers.get('location')!).searchParams.get('state')}\\.[^;]+; Max-Age=600; Path=/decision-benchmarks/auth; HttpOnly; Secure; SameSite=Lax$`));
    }
  });

  it('refuses no game called auth, which is where the sign-in lives', () => {
    dist = makeDist();
    expect(() => createApp({ env: { SESSION_SECRET: SECRET }, games: [{ server: coinServer('auth'), distDir: dist }], commit: 'x' })).toThrow(/auth/);
  });
});

describe('one sign-in for every game', () => {
  const BASE = '/decision-benchmarks';
  let opper: Server | undefined;
  const tokenRequests: URLSearchParams[] = [];

  /** A stand-in for Opper's token endpoint (OPPER_BASE_URL): any code buys one player key. */
  async function fakeOpper(): Promise<string> {
    tokenRequests.length = 0;
    opper = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url !== '/oauth/token') return void res.writeHead(404).end();
        tokenRequests.push(new URLSearchParams(body));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ api_key: 'op-player', user: { name: 'Ada', email: 'ada@example.com' } }));
      });
    });
    await new Promise<void>((done) => opper!.listen(0, '127.0.0.1', done));
    return `http://127.0.0.1:${(opper.address() as { port: number }).port}`;
  }

  afterEach(async () => {
    await new Promise<void>((done) => (opper ? opper.close(() => done()) : done()));
    opper = undefined;
  });

  it('signs in once from one game, at the one redirect URI, and every game sees the player', async () => {
    const opperUrl = await fakeOpper();
    const url = await start({ APP_BASE_PATH: BASE, PUBLIC_BASE_URL: 'https://opper.ai', OPPER_BASE_URL: opperUrl, OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh' });
    // The coin page's Login button.
    const login = await fetch(`${url}${BASE}/auth/login?return=${encodeURIComponent(`${BASE}/coin/?model=x`)}`, { redirect: 'manual' });
    expect(login.status).toBe(302);
    const authorize = new URL(login.headers.get('location')!);
    expect(authorize.origin + authorize.pathname).toBe(`${opperUrl}/oauth/authorize`);
    expect(authorize.searchParams.get('redirect_uri')).toBe('https://opper.ai/decision-benchmarks/auth/callback');
    // Opper sends the browser back to the redirect URI with a code and the state.
    const state = login.headers.get('set-cookie')!.split(';')[0];
    const callback = await fetch(`${url}${BASE}/auth/callback?code=c0de&state=${authorize.searchParams.get('state')}`, { headers: { cookie: state }, redirect: 'manual' });
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(`${BASE}/coin/?model=x`);
    expect(tokenRequests.map((r) => [r.get('code'), r.get('redirect_uri')])).toEqual([['c0de', 'https://opper.ai/decision-benchmarks/auth/callback']]);
    const sessions = callback.headers.getSetCookie().filter((c) => c.startsWith('db_session='));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatch(/; Max-Age=2592000; Path=\/decision-benchmarks\/; HttpOnly; Secure; SameSite=Lax$/);
    const session = sessions[0]!.split(';')[0]!;
    // Both games read the one session.
    for (const slug of ['coin', 'dice']) {
      expect(await (await fetch(`${url}${BASE}/${slug}/api/me`, { headers: { cookie: session } })).json()).toMatchObject({ mode: 'player', user: { name: 'Ada', email: 'ada@example.com' } });
    }
    // Signing out of one is signing out of all: the cookie is cleared at the same path.
    const out = await fetch(`${url}${BASE}/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: session }, body: '{}' });
    expect(out.headers.getSetCookie()).toEqual(['db_session=; Max-Age=0; Path=/decision-benchmarks/; HttpOnly; Secure; SameSite=Lax']);
  });

  it.each(['//evil.com', 'https://evil.com', 'https://evil.com/decision-benchmarks/coin/', '/other-app/', '/decision-benchmarks/../other-app/', '/decision-benchmarks'])(
    'refuses to return to %j after signing in',
    async (to) => {
      const url = await start({ APP_BASE_PATH: BASE, PUBLIC_BASE_URL: 'https://opper.ai', OPPER_CLIENT_ID: 'opper_app_x', OPPER_CLIENT_SECRET: 'shh' });
      const login = await fetch(`${url}${BASE}/auth/login?${new URLSearchParams({ return: to })}`, { redirect: 'manual' });
      expect(login.status).toBe(400);
      expect(login.headers.get('location')).toBeNull();
      expect(login.headers.get('set-cookie')).toBeNull();
    },
  );
});
