import { cpSync, mkdtempSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeSubmission } from '../../../packages/kit/bench/bench.ts';
import { checkSubmissions } from '../../../packages/kit/bench/submissions.ts';
import { validateCommunity } from '../../../packages/kit/shared/contract.ts';
import game from '../game.ts';
import { playGame } from './support/gauntlet.ts';

const quiet = () => {};

describe('a submission', () => {
  // The kit's submissions check on the fighter, with a throwaway submission made of two baseline games in a temporary
  // folder (a real one needs 24; two keep the test quick and check the same things).
  const quick = { ...game, rules: { ...game.rules, minGames: 2 } };

  it('of recorded games is replayed and scored by our code, and refused once a game is not the one its number plays', async () => {
    const games = await Promise.all([0, 1].map((i) => playGame(i, 'baseline/greedy')));
    const root = mkdtempSync(join(tmpdir(), 'fighter-submissions-'));
    writeSubmission(quick, join(root, 'greedy-bot'), games.map((g) => g.recording), quick.rules.seedFor, { name: 'Greedy bot', by: 'acme', via: 'systemone' }, quiet);
    const { community, refused } = checkSubmissions(quick, root, quiet);
    expect(refused).toEqual([]);
    expect(validateCommunity(community, 'fighter')).toEqual([]);
    const mean = (games[0]!.score + games[1]!.score) / 2;
    expect(community.entries).toMatchObject([{ model: 'greedy-bot', name: 'Greedy bot', by: 'acme', games: 2, selfReported: true, metric: { mean: Math.round(mean * 1000) / 1000 }, fallbackRate: 0 }]);
    expect(community.metric).toEqual(game.metric);
    expect(Object.keys(community.entries[0]!.extra ?? {}).sort()).toEqual(['matchWinShare', 'vsGreedy', 'vsPayoff']);

    // The same games with their numbers swapped: game 1 is not the match seed 0 plays.
    const swapped = join(root, 'swapped-bot');
    cpSync(join(root, 'greedy-bot'), swapped, { recursive: true });
    renameSync(join(swapped, 'game-01.json.gz'), join(swapped, 'tmp.json.gz'));
    renameSync(join(swapped, 'game-02.json.gz'), join(swapped, 'game-01.json.gz'));
    renameSync(join(swapped, 'tmp.json.gz'), join(swapped, 'game-02.json.gz'));
    const again = checkSubmissions(quick, root, quiet);
    expect(again.refused).toMatchObject([{ id: 'swapped-bot', error: expect.stringMatching(/game-01.json.gz: played bench seed 1, not 0/) }]);
    // Two matches played, then replayed twice: 16 s on a quiet CI runner, past 30 s on a busy one.
  }, 90_000);
});
