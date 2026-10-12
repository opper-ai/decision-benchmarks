import { mkdtempSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { beforeAll, describe, expect, it } from 'vitest';
import { baselineAdapter } from '../shared/baselines.ts';
import { Match, instantClock } from '../shared/match.ts';
import { encodeReplay, type Replay } from '../shared/replay.ts';

// The store reads its folder and the community cap when it loads.
process.env.JEV_FIGHTER_DATA_DIR = mkdtempSync(join(tmpdir(), 'jev-fighter-'));
process.env.JEV_FIGHTER_MAX_COMMUNITY = '3';
const store = await import('../server/store.ts');
const { createApp } = await import('../server/app.ts');
const { sourceOf } = await import('../shared/stats.ts');

let replay: Replay;
beforeAll(async () => {
  const m = new Match({
    seed: 7,
    mode: 'paused',
    deadlineMs: 1000,
    clock: instantClock,
    adapters: [baselineAdapter('baseline/greedy'), baselineAdapter('baseline/random')],
    fighters: [
      { model: 'baseline/greedy', label: 'Greedy', kind: 'baseline', color: '#000' },
      { model: 'baseline/random', label: 'Random', kind: 'baseline', color: '#111' },
    ],
  });
  replay = await m.run();
}, 60_000);

describe('the replay store', () => {
  it('tags matches official or community, and reads old summaries by their unverified flag', async () => {
    const off = await store.saveReplay(replay);
    const com = await store.saveReplay(replay, undefined, { source: 'community' });
    expect([off.source, com.source]).toEqual(['official', 'community']);
    expect(sourceOf({ unverified: true })).toBe('community');
    expect(sourceOf({})).toBe('official');
    const official = await store.leaderboardFor('paused', 'assisted');
    const all = await store.leaderboardFor('paused', 'assisted', true);
    expect(official.rows.reduce((a, r) => a + r.matches, 0)).toBeLessThan(all.rows.reduce((a, r) => a + r.matches, 0));
  });

  it('deletes a replay and its summary', async () => {
    const s = await store.saveReplay(replay);
    expect(await store.deleteReplays([s.id, 'not-a-replay-id'])).toEqual([s.id]);
    expect(await store.loadReplayBytes(s.id)).toBeNull();
    expect((await store.listSummaries()).some((x) => x.id === s.id)).toBe(false);
  });

  it('keeps only the newest community matches, and never prunes official ones', async () => {
    const before = (await store.listSummaries()).filter((s) => sourceOf(s) === 'official').length;
    for (let k = 0; k < 5; k++) await store.saveReplay({ ...replay, createdAt: new Date(2030, 0, 1, 0, k).toISOString() }, undefined, { source: 'community' });
    const after = await store.listSummaries();
    expect(after.filter((s) => sourceOf(s) === 'community').length).toBe(3);
    expect(after.filter((s) => sourceOf(s) === 'official').length).toBe(before);
  });

  it('refuses a replay that is too large', async () => {
    const huge = { ...replay, decisions: replay.decisions.map((d) => ({ ...d, padding: Math.random().toString(36).repeat(400) })) };
    // Unknown fields are dropped before saving, so padding alone cannot fill the disk...
    await expect(store.saveReplay(huge as Replay)).resolves.toBeTruthy();
    // ...but real content beyond the limit is refused.
    const long = { ...replay, decisions: Array.from({ length: 40 }, () => replay.decisions).flat().map((d, k) => ({ ...d, reasoning: `${k}-${Math.random()}`.repeat(30) })) };
    await expect(store.saveReplay(long as Replay)).rejects.toBeInstanceOf(store.TooLarge);
  });
});

/** Calls the app as the HTTP server would. */
async function call(app: ReturnType<typeof createApp>, method: string, path: string, opts: { body?: Uint8Array; headers?: Record<string, string>; from?: string } = {}) {
  const req = Readable.from(opts.body ? [Buffer.from(opts.body)] : []) as unknown as IncomingMessage;
  Object.assign(req, { method, url: path, headers: { host: 'jev-fighter.example', 'x-forwarded-proto': 'https', ...opts.headers }, socket: { remoteAddress: opts.from ?? '203.0.113.9' } });
  let status = 0;
  let text = '';
  const res = {
    writeHead(s: number) {
      status = s;
      return res;
    },
    end(b?: string | Buffer) {
      text = b ? b.toString() : '';
    },
  } as unknown as ServerResponse;
  await app(req, res);
  return { status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe('the replay API', () => {
  const app = createApp({ opperApiUrl: '', opperUrl: '', redirectUri: 'https://jev-fighter.example/auth/callback', sessionSecret: 'x'.repeat(32), adminToken: 'secret-token', adminEmails: [] });

  it('saves a gzipped replay from the site as community, and one with the admin token as official', async () => {
    const body = await encodeReplay(replay);
    const site = await call(app, 'POST', '/api/replays', { body, headers: { 'x-forwarded-for': '198.51.100.1' } });
    expect(site).toMatchObject({ status: 201, json: { source: 'community' } });
    const bench = await call(app, 'POST', '/api/replays', { body, headers: { authorization: 'Bearer secret-token' } });
    expect(bench).toMatchObject({ status: 201, json: { source: 'official' } });
    const wrong = await call(app, 'POST', '/api/replays', { body, headers: { authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
  });

  it('limits saves per address', async () => {
    const body = await encodeReplay(replay);
    const statuses: number[] = [];
    for (let k = 0; k < 21; k++) statuses.push((await call(app, 'POST', '/api/replays', { body, headers: { 'x-forwarded-for': '198.51.100.2' } })).status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(20);
    expect(statuses.at(-1)).toBe(429);
  }, 60_000);

  it('lets only an admin delete', async () => {
    const s = await store.saveReplay(replay);
    expect((await call(app, 'DELETE', `/api/replays/${s.id}`)).status).toBe(403);
    expect((await call(app, 'DELETE', `/api/replays/${s.id}`, { headers: { authorization: 'Bearer secret-token' } })).status).toBe(200);
    expect((await call(app, 'DELETE', `/api/replays/${s.id}`, { headers: { authorization: 'Bearer secret-token' } })).status).toBe(404);
  });

  it('signs out behind a proxy, where Host is the backend but Origin is the public site', async () => {
    const behindProxy = { host: 'backend.internal', origin: 'https://jev-fighter.example', 'sec-fetch-site': 'same-origin' };
    const out = await call(app, 'POST', '/auth/logout', { body: new TextEncoder().encode('{}'), headers: behindProxy });
    expect(out.status).toBe(200);
    const evil = await call(app, 'POST', '/auth/logout', { body: new TextEncoder().encode('{}'), headers: { ...behindProxy, origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
  });

  it('decides "local" by the connection, not by a Host header anyone can send', async () => {
    const s = await store.saveReplay(replay);
    const forged = await call(app, 'DELETE', `/api/replays/${s.id}`, { headers: { host: 'localhost', 'x-forwarded-proto': '' } });
    expect(forged.status).toBe(403);
    const local = await call(app, 'DELETE', `/api/replays/${s.id}`, { from: '127.0.0.1', headers: { host: 'localhost', 'x-forwarded-proto': '' } });
    expect(local.status).toBe(200);
  });

  it('filters the replay list by source', async () => {
    const r = await call(app, 'GET', '/api/replays?source=official');
    const list = r.json.replays as { source: string }[];
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((x) => x.source === 'official')).toBe(true);
    expect(r.json.counts).toMatchObject({ official: expect.any(Number), community: expect.any(Number) });
  });
});
