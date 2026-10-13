import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BOARD_SIZE, cleanInitials, fileStore, HighScores as KitHighScores, highScoresStore } from '../server/highscores';
import type { TextStore } from '../server/s3';

const entry = (initials: string, score: number) => ({ initials, score, at: '2026-10-08T00:00:00.000Z', who: 'x' });
/** A game's boards, as Pac-Man names its lineups. */
const BOARDS = ['mixed', 'opper/clef'];
class HighScores extends KitHighScores {
  constructor(store: TextStore | null, warn?: (msg: string) => void) {
    super(BOARDS, store, warn);
  }
}

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

describe('HighScores', () => {
  it('keeps the ten best per board, best first, and never shows who', () => {
    const h = new HighScores(null);
    for (let i = 1; i <= 12; i++) h.add('mixed', { ...entry('AAA', i * 100), who: `p${i}` });
    const board = h.view().mixed!;
    expect(board).toHaveLength(BOARD_SIZE);
    expect(board[0]!.score).toBe(1200);
    expect(board.at(-1)!.score).toBe(300);
    expect(board[0]).not.toHaveProperty('who');
    expect(h.placeFor('mixed', 250)).toBeNull();
    expect(h.placeFor('mixed', 1250)).toBe(1);
  });

  it('keeps one line per account per board: its best', () => {
    const h = new HighScores(null);
    expect(h.add('mixed', { ...entry('AAA', 500), who: 'same' })).toBe(1);
    expect(h.add('mixed', { ...entry('AAA', 300), who: 'same' })).toBe(1);
    expect(h.add('mixed', { ...entry('AAA', 900), who: 'same' })).toBe(1);
    expect(h.view().mixed).toEqual([{ initials: 'AAA', score: 900, at: '2026-10-08T00:00:00.000Z' }]);
  });

  it('survives a restart through its file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-hs-'));
    const file = join(dir, 'scores.json');
    const first = new HighScores(fileStore(file));
    await first.ready();
    first.add('opper/clef', entry('BOB', 4200));
    expect(await first.flush()).toBe(true);
    const second = new HighScores(fileStore(file));
    await second.ready();
    expect(second.view()['opper/clef']).toEqual([{ initials: 'BOB', score: 4200, at: '2026-10-08T00:00:00.000Z' }]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts empty when nothing is stored yet', async () => {
    const h = new HighScores(memoryStore(null));
    await h.ready();
    expect(h.view().mixed).toEqual([]);
  });

  it('never writes over boards it could not read', async () => {
    const store = { ...memoryStore('{"mixed":[]}'), load: vi.fn(async () => Promise.reject(new Error('HTTP 403 AccessDenied'))) };
    const warn = vi.fn();
    const h = new HighScores(store, warn);
    await expect(h.ready()).rejects.toThrow('AccessDenied');
    expect(() => h.add('mixed', entry('AAA', 100))).toThrow(/not been read/);
    expect(await h.flush()).toBe(true);
    expect(store.saved).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not read memory'));
  });

  it('reads the boards again after a failed read', async () => {
    vi.useFakeTimers();
    try {
      let fail = true;
      const store = { ...memoryStore(JSON.stringify({ mixed: [entry('BOB', 900)] })) };
      const load = store.load;
      store.load = async () => (fail ? Promise.reject(new Error('timeout')) : load());
      const h = new HighScores(store);
      await expect(h.ready()).rejects.toThrow('timeout');
      fail = false;
      await expect(h.ready()).rejects.toThrow(); // too soon: not asked again yet
      vi.advanceTimersByTime(6000);
      await h.ready();
      expect(h.view().mixed).toEqual([{ initials: 'BOB', score: 900, at: '2026-10-08T00:00:00.000Z' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes the latest boards, in order, and tries a failed write again', async () => {
    vi.useFakeTimers();
    try {
      const store = memoryStore(null);
      let down = true;
      const save = store.save;
      store.save = async (text, expected) => (down ? Promise.reject(new Error('HTTP 503')) : save(text, expected));
      const h = new HighScores(store, vi.fn());
      await h.ready();
      h.add('mixed', { ...entry('AAA', 100), who: 'a' });
      expect(await h.flush()).toBe(false);
      down = false;
      h.add('mixed', { ...entry('BBB', 200), who: 'b' });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(JSON.parse(store.saved.at(-1)!).mixed.map((e: { initials: string }) => e.initials)).toEqual(['BBB', 'AAA']);
    } finally {
      vi.useRealTimers();
    }
  });

  it("merges in another task's entries instead of writing over them (old and new tasks overlap in a deploy)", async () => {
    const store = memoryStore(null);
    const a = new HighScores(store);
    const b = new HighScores(store);
    await a.ready();
    await b.ready();
    a.add('mixed', { ...entry('AAA', 300), who: 'a' });
    expect(await a.flush()).toBe(true);
    b.add('mixed', { ...entry('BBB', 500), who: 'b' });
    b.add('mixed', { ...entry('AAA', 100), who: 'a' }); // the same account's worse game, from the other task
    expect(await b.flush()).toBe(true);
    expect(JSON.parse(store.current()!).mixed.map((e: { initials: string; score: number }) => `${e.initials} ${e.score}`)).toEqual(['BBB 500', 'AAA 300']);
    expect(b.view().mixed!.map((e) => e.score)).toEqual([500, 300]);
    expect(b.placeOf('mixed', 'a')).toBe(2);
    expect(b.placeOf('mixed', 'nobody')).toBeNull();
  });

  it('gives up on a write it keeps losing, and tries again later', async () => {
    const store = memoryStore(null);
    const h = new HighScores(store, vi.fn());
    await h.ready();
    const save = store.save;
    store.save = async (t, expected) => {
      store.write('{"mixed":[]}'); // someone else writes every time, just before us
      return save(t, expected);
    };
    h.add('mixed', { ...entry('AAA', 300), who: 'a' });
    expect(await h.flush()).toBe(false);
  });

  it("keeps each game's boards in S3 when HIGHSCORES_BUCKET is set, else in a file", () => {
    expect(highScoresStore({ HIGHSCORES_BUCKET: 'example-highscores-bucket', AWS_REGION: 'eu-north-1' }, 'snake').where).toBe('s3://example-highscores-bucket/snake/highscores.json');
    expect(highScoresStore({ HIGHSCORES_BUCKET: 'b', HIGHSCORES_PREFIX: '/boards/' }, 'snake').where).toBe('s3://b/boards/snake/highscores.json');
    expect(highScoresStore({ HIGHSCORES_DIR: '/tmp/x' }, 'snake').where).toBe('/tmp/x/snake-highscores.json');
    expect(highScoresStore({}, 'snake').where).not.toBe(highScoresStore({}, 'fighter').where);
  });

  it('lists the boards in the order the game gives them', () => {
    expect(new KitHighScores(['b', 'a'], null).order).toEqual(['b', 'a']);
    expect(Object.keys(new KitHighScores(['b', 'a'], null).view())).toEqual(['b', 'a']);
  });

  it('takes three letters only', () => {
    expect(cleanInitials('abc')).toBe('ABC');
    expect(cleanInitials('AB')).toBeNull();
    expect(cleanInitials('A1C')).toBeNull();
  });
});

