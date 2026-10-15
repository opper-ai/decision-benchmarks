// A table service to test against: the kit's game middleware with AI Hold'em's table API on a local port, and a fake
// Opper (System One and chat completions) behind it, so the page's driver and the API tests run the real HTTP path.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach } from 'vitest';
import { SESSION_COOKIE } from '../../../packages/kit/server/auth';
import { Pool, VisitorLimits } from '../../../packages/kit/server/pool';
import { createGameMiddleware } from '../../../packages/kit/server/routes';
import { sealSession } from '../../../packages/kit/server/session';
import type { GameServer } from '../../../packages/kit/shared/game';
import { tableApi, type TableDeps, type TableLimits } from '../server/table';
import game from '../game.server';

export const SECRET = 'h'.repeat(64);
/** The table key the tests deal from (a real table's comes from randomBytes): easy to spot in any response. */
export const KEY = 'c0ffee'.repeat(10) + 'beef';
export const DECISION = 'sference/clef';
export const DECISION2 = 'typesafe/jev-1.13.0';
export const CHAT = 'aws/claude-haiku-5-5-eu';
export const SECRET_REASONING = 'PRIVATE-REASONING';

type Reply = { status: number; body: unknown; headers?: Record<string, string>; delayMs?: number };
type Upstream = { calls: { path: string; body: Record<string, unknown>; headers: IncomingMessage['headers'] }[]; decide?: (body: Record<string, unknown>, n: number) => Reply; chat?: (body: Record<string, unknown>, n: number) => Reply };

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((done) => (s.closeAllConnections(), s.close(() => done())));
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((done) => s.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

/** A small deterministic coin from the request, so the fake models' choices vary but replay. */
const coin = (n: number, salt: number) => ((n * 2654435761 + salt * 40503) >>> 0) % 100;

/**
 * The fake models: mostly check or call, fold to big bets more often than not, now and then bet half the pot or shove,
 * so a Sit & Go lasts a few dozen hands, as real ones do.
 */
function pick(criteria: Record<string, string>, n: number): string {
  const keys = Object.keys(criteria);
  if (keys.includes('allin') && coin(n, 1) < 3) return 'allin';
  if (keys.includes('half') && coin(n, 2) < 10) return 'half';
  if (keys.includes('check')) return 'check';
  const bb = Number(/\(([\d.]+) big blinds\)/.exec(criteria.call ?? '')?.[1] ?? 0);
  if (keys.includes('fold') && bb > 6 && coin(n, 3) < 70) return 'fold';
  return keys.includes('call') ? 'call' : keys[0]!;
}

async function fakeOpper(up: Upstream): Promise<string> {
  let n = 0;
  return listen((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const send = (r: Reply) => {
        const go = () => {
          if (res.destroyed) return;
          res.writeHead(r.status, { 'Content-Type': 'application/json', ...r.headers });
          res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
        };
        if (r.delayMs) setTimeout(go, r.delayMs);
        else go();
      };
      if (req.url === '/v3/me') return send({ status: 200, body: { balance: { balance_cents: 5000 } } });
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      up.calls.push({ path: req.url ?? '', body, headers: req.headers });
      n++;
      if (req.url === '/v3/compat/v1/systemone') {
        if (up.decide) return send(up.decide(body, n));
        const criteria = (body.questions as { action: { criteria: Record<string, string> } }).action.criteria;
        const choice = pick(criteria, n);
        return send({ status: 200, body: { answers: { action: { type: 'choice', choice, probabilities: { [choice]: 0.8 } } }, usage: { input_tokens: 800, output_tokens: 1 } }, headers: { 'x-opper-cost': '0.00001' } });
      }
      if (req.url === '/v3/compat/chat/completions') {
        if (up.chat) return send(up.chat(body, n));
        const keys = ((body.response_format as { json_schema: { schema: { properties: { action: { enum: string[] } } } } }).json_schema.schema.properties.action.enum);
        const action = pick(Object.fromEntries(keys.map((k) => [k, k])), n);
        const content = JSON.stringify({ action, say: `Talk ${n}`, mood: 'confident', reasoning: `${SECRET_REASONING} ${n}`, turn_complete: true });
        return send({ status: 200, body: { choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 1500, completion_tokens: 80 } }, headers: { 'x-opper-cost': '0.0012' } });
      }
      send({ status: 404, body: {} });
    });
  });
}

export interface Setup {
  /** Signed in as a player (their key pays). */
  signedIn?: boolean;
  /** The free credits: open, spent, or none. */
  pool?: 'open' | 'spent' | 'none';
  /** The server's local key. */
  devKey?: boolean;
  up?: Partial<Upstream>;
  now?: () => number;
  poolRate?: number;
  /** Deal from fresh random keys, as the service does, instead of KEY. */
  randomKey?: boolean;
  /** The table's per-visitor limits; by default none to speak of, as the tests play far faster than anyone (see LOOSE). */
  limits?: Partial<TableLimits>;
}

/** Limits a test's instant play never meets; the defaults are tested on their own, at a person's pace. */
export const LOOSE: Partial<TableLimits> = { starts: { ratePerSec: 1e6, burst: 1e6 }, moves: { ratePerSec: 1e6, burst: 1e6 }, steps: { ratePerSec: 1e6, burst: 1e6 } };

export async function setup(o: Setup = {}) {
  const up: Upstream = { calls: [], ...o.up };
  const opper = await fakeOpper(up);
  const env: Record<string, string> = { SESSION_SECRET: SECRET, OPPER_BASE_URL: opper, ...(o.devKey ? { OPPER_API_KEY: 'op-dev', OPPER_PROJECT: 'proj-1' } : {}) };
  const deps: TableDeps = { now: o.now ?? (() => Date.now()), key: o.randomKey ? () => randomBytes(32).toString('hex') : () => KEY, clock: () => performance.now() };
  const server: GameServer = { ...game, api: tableApi(deps, o.limits ?? LOOSE) };
  let access = null;
  const pool = o.pool ?? 'open';
  if (pool !== 'none') {
    const p = new Pool({ apiKey: 'op-pool', opperUrl: opper, fetch, now: () => Date.now(), refreshMs: Number.POSITIVE_INFINITY });
    if (pool === 'spent') p.exhausted();
    access = { pool: p, limits: new VisitorLimits({ ratePerSec: o.poolRate ?? 1000, burst: o.poolRate ?? 1000 }), trustedProxies: 0 };
  }
  const logs: string[] = [];
  const logger = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
  const routes = createGameMiddleware(server, env, logger, { quiet: true, poolAccess: access });
  const url = await listen((req, res) => routes(req, res, () => res.writeHead(404).end()));
  const cookie = o.signedIn ? `${SESSION_COOKIE}=${encodeURIComponent(sealSession({ v: 1, apiKey: 'op-player', user: { name: 'Ada' }, issuedAt: Date.now() }, SECRET))}` : '';
  const responses: { path: string; status: number; text: string }[] = [];
  const call = async (path: string, body: unknown) => {
    const res = await fetch(`${url}/api/table/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    responses.push({ path, status: res.status, text });
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, headers: res.headers };
  };
  return { call, up, logs, responses, access, url, cookie };
}

