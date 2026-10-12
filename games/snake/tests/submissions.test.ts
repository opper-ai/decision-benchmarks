import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { writeSubmission } from '../../../packages/kit/bench/bench';
import { validateCommunity } from '../../../packages/kit/shared/contract';
import game from '../game';
import { playBaseline } from './support';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'snake-sub-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('a submission of baseline games', () => {
  it('passes `npm run submissions -- --game snake`, as CI runs it', async () => {
    const root = join(tmp, 'submissions');
    const recordings = [];
    for (let i = 0; i < game.rules.minGames; i++) recordings.push((await playBaseline('greedy', game.rules.seedFor(i))).recording);
    writeSubmission(game as never, join(root, 'greedy-bot'), recordings, game.rules.seedFor, { name: 'Greedy Bot', by: 'opper-ai', via: 'systemone' }, () => {});
    const out = join(tmp, 'community.json');
    const log = execFileSync(process.execPath, ['scripts/submissions.ts', '--game', 'snake', '--dir', root, '--out', out], { cwd: ROOT, encoding: 'utf8' });
    expect(log).toMatch(/greedy-bot: ok, 24 games/);
    const community = JSON.parse(readFileSync(out, 'utf8'));
    expect(validateCommunity(community, 'snake')).toEqual([]);
    expect(community.entries).toMatchObject([{ model: 'greedy-bot', name: 'Greedy Bot', by: 'opper-ai', games: 24, selfReported: true }]);
    expect(community.entries[0].metric.mean).toBeGreaterThan(10);
  });
});
