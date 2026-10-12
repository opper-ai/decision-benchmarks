import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { configFromEnv, createApp } from './app.ts';
import { safeEqual } from './session.ts';
import { seedSamples } from './store.ts';

const DIST = join(process.cwd(), 'dist');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const seeded = await seedSamples();
if (seeded) console.log(`added ${seeded} sample replays`);
const cfg = configFromEnv();
const handle = createApp(cfg);
// Behind a proxy (the apps.sabater.io Worker), only requests carrying its secret are served, so the
// backend's own address cannot be used to skip the proxy. The health check stays open for the host.
const proxySecret = process.env.PROXY_SECRET ?? '';
const publicOrigin = URL.canParse(cfg.redirectUri) ? new URL(cfg.redirectUri).origin : '';
const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (proxySecret && path !== '/api/health' && !safeEqual(String(req.headers['x-proxy-secret'] ?? ''), proxySecret)) {
    if (req.method === 'GET' && publicOrigin) return void res.writeHead(301, { Location: publicOrigin + (req.url ?? '/') }).end();
    return void res.writeHead(403, { 'Content-Type': 'application/json' }).end('{"error":"Use the public site"}');
  }
  if (await handle(req, res)) return;
  let file = normalize(join(DIST, path));
  if (!file.startsWith(DIST)) return void res.writeHead(400).end();
  const s = await stat(file).catch(() => null);
  // Client-side routes (/replay/:id, /leaderboard) fall back to the page.
  if (!s || s.isDirectory()) file = join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`jev-fighter on http://localhost:${port}`));
