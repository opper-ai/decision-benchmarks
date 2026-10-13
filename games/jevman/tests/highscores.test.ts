import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../../../packages/kit/server/auth';
import { HighScores as KitHighScores } from '../../../packages/kit/server/highscores';
import type { TextStore } from '../../../packages/kit/server/s3';
import { createGameMiddleware } from '../../../packages/kit/server/routes';
import { sealSession } from '../../../packages/kit/server/session';
import server from '../game.server';
import { BOARD_KEYS, boardOf, MIXED_LINEUP } from '../shared/lineups';
import { playAndRecord, TEST_SECRET } from './support/player-game';

const SECRET = TEST_SECRET;
class HighScores extends KitHighScores {
  constructor(store: TextStore | null, warn?: (msg: string) => void) {
    super(BOARD_KEYS, store, warn);
  }
}

describe('lineup boards', () => {
  it('puts the presets on boards and leaves custom mixes off', () => {
    expect(boardOf(MIXED_LINEUP)).toBe('mixed');
    expect(boardOf({ blinky: 'opper/clef', pinky: 'opper/clef', inky: 'opper/clef', clyde: 'opper/clef' })).toBe('opper/clef');
    expect(boardOf({ blinky: 'opper/clef', pinky: 'opper/clef', inky: 'opper/kev-4b', clyde: 'opper/clef' })).toBeNull();
  });
});

/** A store in memory, versioned like S3: what it holds, and every text written to it. `write` is another writer. */
function memoryStore(initial: string | null): TextStore & { saved: string[]; write(t: string): void; current(): string | null } {
  let text = initial;
  let version = 0;
  const saved: string[] = [];
  return {
    where: 'memory',
    saved,
    write: (t) => {
      text = t;
      version += 1;
    },
    current: () => text,
    load: async () => (text === null ? null : { text, version: String(version) }),
    save: async (t, expected) => {
      if ((text === null ? null : String(version)) !== expected) return null;
      text = t;
      version += 1;
      saved.push(t);
      return String(version);
    },
  };
}

describe('/api/highscores', () => {
  const mount = (highScores = new HighScores(null)) => {
    const handler = createGameMiddleware(server, { SESSION_SECRET: SECRET, OPPER_BASE_URL: 'https://api.opper.ai' }, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, { quiet: true, highScores, poolAccess: null });
    return { handler, highScores };
  };
  const call = async (handler: ReturnType<typeof mount>['handler'], method: string, headers: Record<string, string>, payload?: unknown, ip = '203.0.113.7') => {
    const res = { statusCode: 200, headersSent: false, headers: {} as Record<string, unknown>, setHeader(k: string, v: unknown) { this.headers[k] = v; }, end: vi.fn() };
    const req = Object.assign(new EventEmitter(), { method, url: '/api/highscores', headers, socket: { remoteAddress: ip } });
    handler(req as never, res as never, vi.fn());
    if (payload !== undefined) {
      req.emit('data', JSON.stringify(payload));
      req.emit('end');
    }
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    return { status: res.statusCode, body: JSON.parse(res.end.mock.calls[0]![0] as string) };
  };
  const signedIn = { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${sealSession({ v: 1, apiKey: 'k', user: { email: 'player@example.com' }, issuedAt: Date.now() }, SECRET)}` };
  const { state, recording } = playAndRecord(42, 20000);

  it('lists the boards to anyone', async () => {
    const { handler } = mount();
    const r = await call(handler, 'GET', {});
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.boards)).toContain('mixed');
    expect(r.body.order).toEqual(BOARD_KEYS);
  });

  const signedOut = { 'content-type': 'application/json' };

  it("puts a signed-out player's checked game on the board: one line per address and initials", async () => {
    const { handler, highScores } = mount();
    const r = await call(handler, 'POST', signedOut, { board: 'mixed', initials: 'ann', recording });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ place: 1, score: state.score });
    // Someone else at the same address (a phone network, an office) gets a line of their own; the same player doesn't.
    expect((await call(handler, 'POST', signedOut, { board: 'mixed', initials: 'bob', recording })).body).toMatchObject({ place: 2 });
    expect((await call(handler, 'POST', signedOut, { board: 'mixed', initials: 'ann', recording })).body).toMatchObject({ place: 1 });
    expect(highScores.view().mixed!.map((e) => e.initials)).toEqual(['ANN', 'BOB']);
  });

  it('counts signed-out entries per address', async () => {
    const { handler } = mount();
    const bad = { board: 'mixed', initials: '!', recording: null };
    for (let i = 0; i < 20; i++) expect((await call(handler, 'POST', signedOut, bad)).status).toBe(400);
    expect((await call(handler, 'POST', signedOut, bad)).status).toBe(429);
    expect((await call(handler, 'POST', signedOut, bad, '198.51.100.9')).status).toBe(400);
  });

  it("puts a signed-in player's checked game on the board, with the replay's score", async () => {
    const { handler, highScores } = mount();
    const r = await call(handler, 'POST', signedIn, { board: 'mixed', initials: 'jev', recording });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ place: 1, score: state.score });
    expect(highScores.view().mixed![0]).toMatchObject({ initials: 'JEV', score: state.score });
  });

  it('refuses a game that does not check out, and bad initials or boards', async () => {
    const { handler, highScores } = mount();
    expect((await call(handler, 'POST', signedIn, { board: 'mixed', initials: 'ABC', recording: { ...recording, final: { ...recording.final, score: 99_999 } } })).status).toBe(422);
    expect((await call(handler, 'POST', signedIn, { board: 'mixed', initials: 'A!', recording })).status).toBe(400);
    expect((await call(handler, 'POST', signedIn, { board: 'nope', initials: 'ABC', recording })).status).toBe(400);
    // played against Mixed, entered for All Clef
    expect((await call(handler, 'POST', signedIn, { board: 'opper/clef', initials: 'ABC', recording })).status).toBe(422);
    expect(highScores.view().mixed).toEqual([]);
  });

  it('saves an entry before answering, so a restart keeps it', async () => {
    const store = memoryStore(null);
    const { handler } = mount(new HighScores(store));
    expect((await call(handler, 'POST', signedIn, { board: 'mixed', initials: 'jev', recording })).status).toBe(200);
    expect(JSON.parse(store.saved.at(-1)!).mixed[0]).toMatchObject({ initials: 'JEV', score: state.score });
    const restarted = mount(new HighScores(store));
    expect((await call(restarted.handler, 'GET', {})).body.boards.mixed[0]).toMatchObject({ initials: 'JEV', score: state.score });
  });

  it("doesn't say an entry was taken while it isn't stored, and stores it when the player tries again", async () => {
    const store = memoryStore(null);
    const save = store.save;
    let down = true;
    store.save = async (t, expected) => (down ? Promise.reject(new Error('HTTP 403 AccessDenied')) : save(t, expected));
    const { handler } = mount(new HighScores(store, vi.fn()));
    const failed = await call(handler, 'POST', signedIn, { board: 'mixed', initials: 'jev', recording });
    expect(failed.status).toBe(503);
    expect(failed.body.error).toMatch(/could not be saved/);
    down = false;
    const retried = await call(handler, 'POST', signedIn, { board: 'mixed', initials: 'jev', recording });
    expect(retried.status).toBe(200);
    expect(JSON.parse(store.current()!).mixed[0]).toMatchObject({ initials: 'JEV', score: state.score });
  });

  it('says the boards are unavailable while they cannot be read, and takes no entries', async () => {
    const store = { ...memoryStore(null), load: async () => Promise.reject(new Error('HTTP 403 AccessDenied')) };
    const { handler } = mount(new HighScores(store, vi.fn()));
    expect((await call(handler, 'GET', {})).status).toBe(503);
    expect((await call(handler, 'POST', signedIn, { board: 'mixed', initials: 'ABC', recording })).status).toBe(503);
    expect(store.saved).toEqual([]);
  });
});
