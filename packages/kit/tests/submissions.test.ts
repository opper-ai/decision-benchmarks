import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { checkSubmission, checkSubmissions } from '../bench/submissions';
import { validateCommunity } from '../shared/contract';
import { coinDefinition } from './support/test-game';

// The coin game, with a fingerprint of the calls only: the same calls are the same game, whatever the file says.
const game = coinDefinition({
  verify(rec, { seed }) {
    const r = rec as { seed?: unknown; calls?: unknown };
    if (r?.seed !== seed) return { ok: false, error: `played seed ${String(r?.seed)}, not ${seed}` };
    if (!Array.isArray(r.calls)) return { ok: false, error: 'no calls' };
    const heads = r.calls.filter((c) => c === 'heads').length;
    return { ok: true, result: { score: heads, heads, calls: r.calls.length, decisions: r.calls.length, fallbacks: 0, latencyMsSum: 100 * r.calls.length, cost: 0.001 }, fingerprint: r.calls.join(',') };
  },
});
const seedOf = (n: number) => game.rules.seedFor(n - 1);

/** A submission folder as bench --submit writes it: game n plays seed seedFor(n - 1). */
function folder(opts: { manifest?: Record<string, unknown>; files?: Record<string, unknown>; root?: string; id?: string } = {}): string {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), 'db-sub-'));
  const dir = join(root, opts.id ?? 'acme-coin');
  mkdirSync(dir);
  const files = opts.files ?? { 'game-01.json.gz': { seed: seedOf(1), calls: ['heads', 'tails'] }, 'game-02.json.gz': { seed: seedOf(2), calls: ['heads', 'heads'] } };
  for (const [name, rec] of Object.entries(files)) writeFileSync(join(dir, name), typeof rec === 'string' ? rec : gzipSync(JSON.stringify(rec)));
  writeFileSync(join(dir, 'submission.json'), JSON.stringify({ name: 'Acme Coin', by: 'acme', benchVersion: game.benchVersion, games: Object.keys(files).length, ...opts.manifest }));
  return dir;
}

describe("the kit's submissions check", () => {
  it("replays every game with the game's own verify and builds a self-reported entry in the contract shape", () => {
    const checked = checkSubmission(game, folder({ manifest: { url: 'https://acme.example', via: 'chat-adapter' } }), 'acme-coin');
    expect(checked).toEqual({
      entry: {
        model: 'acme-coin',
        name: 'Acme Coin',
        games: 2,
        metric: { mean: 1.5, stdError: 0.5, best: 2 },
        meanLatencyMs: 100,
        fallbackRate: 0,
        costPerGame: 0.001,
        via: 'chat-adapter',
        extra: { meanHeads: 1.5 },
        by: 'acme',
        url: 'https://acme.example',
        selfReported: true,
      },
    });
  });

  it('plays the fixed seeds: game n must be the game on seedFor(n - 1)', () => {
    const swapped = folder({ files: { 'game-01.json.gz': { seed: seedOf(2), calls: ['heads'] }, 'game-02.json.gz': { seed: seedOf(1), calls: ['tails'] } } });
    expect(checkSubmission(game, swapped, 'acme-coin')).toEqual({ error: `game-01.json.gz: played seed ${seedOf(2)}, not ${seedOf(1)}` });
    const picked = folder({ files: { 'game-01.json.gz': { seed: seedOf(1), calls: ['heads'] }, 'game-03.json.gz': { seed: seedOf(3), calls: ['tails'] } } });
    expect(checkSubmission(game, picked, 'acme-coin')).toMatchObject({ error: expect.stringMatching(/game-01 to game-02, each once/) });
  });

  it('refuses the same game sent twice (the same fingerprint)', () => {
    const twice = folder({ files: { 'game-01.json.gz': { seed: seedOf(1), calls: ['heads'] }, 'game-02.json.gz': { seed: seedOf(2), calls: ['heads'] } } });
    expect(checkSubmission(game, twice, 'acme-coin')).toEqual({ error: 'game-02.json.gz is the same game as game-01.json.gz' });
  });

  it("enforces the game's rules: enough games, the count claimed, the size cap", () => {
    expect(checkSubmission(game, folder({ files: { 'game-01.json.gz': { seed: seedOf(1), calls: [] } } }), 'acme-coin')).toMatchObject({ error: expect.stringMatching(/needs at least 2/) });
    expect(checkSubmission(game, folder({ manifest: { games: 3 } }), 'acme-coin')).toMatchObject({ error: expect.stringMatching(/says 3 games/) });
    const huge = folder({ files: { 'game-01.json.gz': { seed: seedOf(1), calls: ['x'.repeat(10)] }, 'game-02.json.gz': gzipSync('x'.repeat(10)).toString('latin1').padEnd(game.rules.maxRecordingBytes + 1, 'x') } });
    expect(checkSubmission(game, huge, 'acme-coin')).toMatchObject({ error: 'game-02.json.gz is larger than a recorded game' });
    expect(checkSubmission(game, folder({ files: { 'game-01.json.gz': 'not gzip', 'game-02.json.gz': { seed: seedOf(2), calls: [] } } }), 'acme-coin')).toMatchObject({ error: expect.stringMatching(/^game-01\.json\.gz: /) });
  });

  it('leaves an older bench version out, and refuses any other version or a broken manifest', () => {
    expect(checkSubmission(game, folder({ manifest: { benchVersion: 1 } }), 'acme-coin')).toMatchObject({ outdated: true });
    for (const benchVersion of [0, 3, '2', null]) expect(checkSubmission(game, folder({ manifest: { benchVersion } }), 'acme-coin')).toMatchObject({ error: 'benchVersion must be 2' });
    expect(checkSubmission(game, folder({ manifest: { name: 'Jev 1.13' } }), 'acme-coin')).toMatchObject({ error: expect.stringMatching(/official leaderboard/) });
    expect(checkSubmission(game, folder({ manifest: { by: 'not a handle!' } }), 'acme-coin')).toMatchObject({ error: expect.stringMatching(/GitHub handle/) });
    expect(checkSubmission(game, folder({ manifest: { url: 'http://x.example' } }), 'acme-coin')).toMatchObject({ error: expect.stringMatching(/https/) });
    expect(checkSubmission(game, folder({ manifest: { via: 'smoke' } }), 'acme-coin')).toMatchObject({ error: expect.stringMatching(/via/) });
    expect(checkSubmission(game, folder({ id: 'Acme_Coin' }), 'Acme_Coin')).toMatchObject({ error: expect.stringMatching(/folder name/) });
  });

  it("writes community.json in the hub's contract shape, best first, with left-out and refused submissions apart", () => {
    const root = mkdtempSync(join(tmpdir(), 'db-subs-'));
    folder({ root, id: 'acme-coin' });
    folder({ root, id: 'better-coin', manifest: { name: 'Better Coin' }, files: { 'game-01.json.gz': { seed: seedOf(1), calls: ['heads', 'heads', 'heads'] }, 'game-02.json.gz': { seed: seedOf(2), calls: ['heads', 'heads', 'heads', 'tails'] } } });
    folder({ root, id: 'old-coin', manifest: { name: 'Old Coin', benchVersion: 1 } });
    folder({ root, id: 'same-name', manifest: { name: 'acme coin' } });
    const lines: string[] = [];
    const { community, refused } = checkSubmissions(game, root, (l) => lines.push(l));
    expect(community.entries.map((e) => e.model)).toEqual(['better-coin', 'acme-coin']);
    expect(community).toMatchObject({ game: 'coin', benchVersion: 2, metric: game.metric, skipped: [{ model: 'old-coin' }] });
    expect(refused).toEqual([{ id: 'same-name', error: 'another submission is called acme coin' }]);
    expect(validateCommunity(JSON.parse(JSON.stringify(community)), 'coin')).toEqual([]);
    expect(lines.join('\n')).toMatch(/same-name: REFUSED/);
    expect(readFileSync(join(root, 'acme-coin', 'submission.json'), 'utf8')).toContain('Acme Coin');
  });
});
