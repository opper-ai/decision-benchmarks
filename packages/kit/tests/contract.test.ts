import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pngSize, validateCommunity, validateGameInfo, validateHighScores, validateLeaderboard, validatePoster, type Community, type GameInfo, type Leaderboard } from '../shared/contract';

const metric = { name: 'Apples', unit: 'apples', higherIsBetter: true };
const info: GameInfo = { slug: 'snake', name: 'Snake', tagline: 'A decision model steers a snake.', category: 'Arcade', author: { github: 'opper-ai' }, license: 'MIT', metric, updatedAt: '2026-10-12T00:00:00.000Z' };
const entry = (model: string, mean: number) => ({ model, name: model, games: 100, metric: { mean, stdError: 1.5, best: mean + 10 }, meanLatencyMs: 300, fallbackRate: 0.01, costPerGame: 0.002, via: 'systemone' as const });
const board: Leaderboard = { generatedAt: '2026-10-12T00:00:00.000Z', game: 'snake', benchVersion: 1, metric, entries: [entry('sference/clef', 20), entry('opper/kev-4b', 12)], skipped: [{ model: 'greenpt/metis', reason: 'not warm' }] };
const community: Community = { ...board, entries: [{ ...entry('my-model', 15), by: 'acme', url: 'https://acme.example', selfReported: true }], skipped: [] };

/** A minimal PNG header of the given size (enough for the size check). */
function png(width: number, height: number, padTo = 0): Uint8Array {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'ascii');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, padTo - 24))]);
}

describe('the hub contract', () => {
  it('accepts well formed files', () => {
    expect(validateGameInfo(info, 'snake')).toEqual([]);
    expect(validateGameInfo({ ...info, author: { github: 'johnny', originalRepo: 'https://github.com/johnny/game' } })).toEqual([]);
    // A game to play, not a benchmark: the hub lists it, never ranks it.
    expect(validateGameInfo({ ...info, benchmark: false })).toEqual([]);
    expect(validateLeaderboard(board, 'snake')).toEqual([]);
    expect(validateCommunity(community, 'snake')).toEqual([]);
    expect(validateHighScores({ order: ['all'], boards: { all: [{ initials: 'ABC', score: 3, at: '2026-10-12T00:00:00.000Z' }] } })).toEqual([]);
  });

  it('names what is wrong in game.json', () => {
    expect(validateGameInfo({ ...info, category: 'Racing' })).toEqual([expect.stringMatching(/category/)]);
    expect(validateGameInfo({ ...info, slug: 'Snake!' })).toEqual([expect.stringMatching(/slug/)]);
    expect(validateGameInfo(info, 'fighter')).toEqual([expect.stringMatching(/folder is fighter/)]);
    expect(validateGameInfo({ ...info, author: { github: 'opper-ai', originalRepo: 'javascript:alert(1)' } })).toEqual([expect.stringMatching(/originalRepo/)]);
    expect(validateGameInfo({ ...info, metric: { name: 'x' } }).length).toBe(2);
    expect(validateGameInfo({ ...info, updatedAt: 'yesterday' })).toEqual([expect.stringMatching(/updatedAt/)]);
    expect(validateGameInfo({ ...info, benchmark: true })).toEqual([expect.stringMatching(/benchmark/)]);
    expect(validateGameInfo(null)).toEqual(['game.json must be an object']);
  });

  it('names what is wrong in the results files', () => {
    expect(validateLeaderboard({ ...board, entries: [...board.entries].reverse() })).toEqual([expect.stringMatching(/best first/)]);
    expect(validateLeaderboard({ ...board, metric: { ...metric, higherIsBetter: false }, entries: [...board.entries].reverse() })).toEqual([]);
    expect(validateLeaderboard({ ...board, entries: [{ ...entry('a', 1), via: 'carrier pigeon' }] })).toEqual([expect.stringMatching(/via/)]);
    expect(validateLeaderboard({ ...board, entries: [{ ...entry('a', 1), fallbackRate: 2 }] })).toEqual([expect.stringMatching(/fallbackRate/)]);
    expect(validateLeaderboard({ ...board, entries: [{ ...entry('a', 1), extra: { deaths: { a: 1 } } }] })).toEqual([expect.stringMatching(/extra/)]);
    expect(validateLeaderboard(board, 'fighter')).toEqual([expect.stringMatching(/expected fighter/)]);
    expect(validateCommunity({ ...community, entries: [{ ...community.entries[0], selfReported: false }] })).toEqual([expect.stringMatching(/selfReported/)]);
    expect(validateCommunity({ ...community, entries: [{ ...community.entries[0], by: 'not a handle!' }] })).toEqual([expect.stringMatching(/by/)]);
    // An official board is not a community one: rows need by and selfReported there.
    expect(validateCommunity(board).length).toBeGreaterThan(0);
  });

  it('names what is wrong in the high scores', () => {
    expect(validateHighScores({ order: ['all'], boards: {} })).toEqual([expect.stringMatching(/boards.all/)]);
    expect(validateHighScores({ boards: {} })).toEqual([expect.stringMatching(/order/)]);
  });

  it('checks the poster: a 16:9 PNG of at most 150 KB', () => {
    expect(pngSize(png(1600, 900))).toEqual({ width: 1600, height: 900 });
    expect(validatePoster(png(1600, 900))).toEqual([]);
    expect(validatePoster(png(1200, 630))).toEqual([expect.stringMatching(/not 16:9/)]);
    expect(validatePoster(png(1600, 900, 151 * 1024))).toEqual([expect.stringMatching(/at most 150 KB/)]);
    expect(validatePoster(deflateSync('not a png'))).toEqual(['poster.png is not a PNG']);
  });
});
