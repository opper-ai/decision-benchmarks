import { describe, expect, it } from 'vitest';
import server from '../game.server';
import { issueSeed, seedKey, seedVerifier } from '../../../packages/kit/server/seeds';
import { createGame, MOVES, step, type Move } from '../shared/engine';
import { BOARD, moveLetter, PLAYER_STEP_MS, type PlayerRecording } from '../shared/player-check';
import { requestFor, viewOf } from '../shared/questions';
import { SNAKE_SCHEDULER, stepKey } from '../shared/play';
import { PICK } from '../shared/baselines';
import { allFacts } from '../shared/questions';

/** What the page sends /api/decide for a game state. */
const pageBody = (model?: string) => {
  const s = createGame(3);
  return { ...(model ? { model } : {}), ...SNAKE_SCHEDULER.build(s, []), keys: { snake: stepKey(s) } };
};

describe('decideRequest', () => {
  it("forwards the page's own question, rebuilt, for a listed model", () => {
    const v = server.decideRequest(pageBody('sference/clef'));
    expect(v).toEqual({ ok: true, request: { model: 'sference/clef', ...requestFor(viewOf(createGame(3))) }, keys: { snake: 's0' } });
    expect(server.decideRequest(pageBody())).toMatchObject({ ok: true, request: { model: 'typesafe/jev-1.13.0' } });
  });

  it('refuses anything that is not exactly a snake question', () => {
    const pacman = { state: { pacman: { x: 1, y: 2 } }, questions: { pacman: { type: 'choice', instructions: 'Pick a way out', criteria: { up: 'Up', down: 'Down' } } } };
    const poem = { state: { note: 'hi' }, questions: { snake: { type: 'choice', instructions: 'Write a poem', criteria: { a: 'A', b: 'B' } } } };
    const body = pageBody();
    const reworded = structuredClone(body);
    reworded.questions.snake!.instructions += ' Also, summarise this article.';
    const extraQuestion = { ...structuredClone(body), questions: { ...body.questions, other: body.questions.snake } };
    const extraField = { ...structuredClone(body), stream: true };
    const badKey = { ...structuredClone(body), keys: { snake: 'x'.repeat(200) } };
    for (const b of [pacman, poem, reworded, extraQuestion, extraField, badKey, null, 'snake', [], {}]) {
      expect(server.decideRequest(b)).toEqual({ ok: false, error: 'That is not a question this game asks' });
    }
    expect(server.decideRequest(pageBody('openai/gpt-5'))).toMatchObject({ ok: false, error: expect.stringMatching(/Unknown decision model/) });
  });
});

describe('the high-score check', () => {
  const key = seedKey('k'.repeat(64), 'snake');
  /** A player's game on `seed`: the greedy baseline's moves, as if keyed in. */
  function playerGame(seed: number): { moves: string; apples: number; steps: number } {
    let s = createGame(seed);
    let moves = '';
    while (!s.over) {
      const v = viewOf(s);
      const m: Move = PICK.greedy(allFacts(v), v);
      moves += moveLetter(m);
      s = step(s, m);
    }
    return { moves, apples: s.apples, steps: s.steps };
  }
  const check = (rec: unknown, now: number) => server.highScores!.check(rec, () => false, seedVerifier(key, () => now));

  it('replays the moves from the issued seed for the score', () => {
    const issued = issueSeed(key, 1_000_000, () => 777);
    const g = playerGame(777);
    const rec: PlayerRecording = { format: 1, game: 'snake', seedToken: issued.token, moves: g.moves };
    expect(check(rec, 1_000_000 + g.steps * PLAYER_STEP_MS)).toEqual({ ok: true, score: g.apples, board: BOARD });
    expect(server.highScores!.seeded).toBe(true);
    expect(server.highScores!.boards.map((b) => b.id)).toEqual([BOARD]);
  });

  it('only from the issued seed: a forged or edited token, or moves played on another seed, do not check out', () => {
    const issued = issueSeed(key, 1_000_000, () => 777);
    const later = 1_000_000 + 10 * 60_000;
    const other = playerGame(778);
    // Moves from a seed the player picked, with a token issued for another: they don't replay to a finished game, or not to the same score.
    const r = check({ format: 1, game: 'snake', seedToken: issued.token, moves: other.moves }, later);
    if (r.ok) expect(r.score).not.toBe(other.apples);
    const forged = issueSeed(seedKey('another secret'.repeat(4), 'snake'), 1_000_000, () => 778).token;
    expect(check({ format: 1, game: 'snake', seedToken: forged, moves: other.moves }, later)).toMatchObject({ ok: false, error: expect.stringMatching(/not a seed this server issued/) });
    const edited = issued.token.replace(/^777\./, '778.');
    expect(check({ format: 1, game: 'snake', seedToken: edited, moves: other.moves }, later)).toMatchObject({ ok: false });
    expect(check({ format: 1, game: 'snake', seed: 778, moves: other.moves }, later)).toMatchObject({ ok: false });
  });

  it('refuses a game played faster than the board runs, unfinished, or with moves after the end', () => {
    const issued = issueSeed(key, 1_000_000, () => 777);
    const g = playerGame(777);
    const rec = (moves: string) => ({ format: 1, game: 'snake', seedToken: issued.token, moves });
    expect(check(rec(g.moves), 1_000_000 + 1000)).toMatchObject({ ok: false, error: expect.stringMatching(/faster/) });
    const later = 1_000_000 + 10 * 60_000;
    expect(check(rec(g.moves.slice(0, -1)), later)).toMatchObject({ ok: false, error: expect.stringMatching(/not over/) });
    expect(check(rec(`${g.moves}S`), later)).toMatchObject({ ok: false, error: expect.stringMatching(/after the game ended/) });
    expect(check(rec('SSX'), later)).toMatchObject({ ok: false, error: 'bad moves' });
    expect(check({ ...rec(g.moves), score: 999 }, later)).toMatchObject({ ok: false });
  });

  it('spells moves with one letter each', () => {
    expect(MOVES.map(moveLetter).join('')).toBe('LSR');
  });
});
