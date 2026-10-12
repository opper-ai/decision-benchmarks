import { describe, expect, it } from 'vitest';
import { answerVerifier } from '../server/answers';
import { checkPlayerGame } from '../src/player-check';
import { playAndRecord, TEST_SECRET } from './support/player-game';

const verify = answerVerifier(TEST_SECRET);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('checkPlayerGame (the high-score check)', () => {
  const { state, recording } = playAndRecord(42, 20000);

  it('accepts a finished game with signed ghost moves, and returns the replay score and the lineup board', () => {
    expect(state.status).toBe('gameover');
    expect(checkPlayerGame(clone(recording), verify)).toEqual({ ok: true, score: state.score, board: 'mixed' });
  });

  it('refuses a claimed score the game did not reach', () => {
    expect(checkPlayerGame({ ...recording, final: { ...recording.final, score: recording.final.score + 10_000 } }, verify).ok).toBe(false);
  });

  it('refuses frozen ghosts: a recording with no ghost moves', () => {
    expect(checkPlayerGame({ ...recording, decisions: [] }, verify)).toMatchObject({ ok: false });
  });

  it('refuses ghost moves no server signed, signed by another server, or claimed for another model', () => {
    const forged = clone(recording);
    forged.decisions[3]![3] = `${forged.decisions[3]![3]!.split('~')[0]}~AAAAAAAAAAAAAAAAAAAAAA`;
    expect(checkPlayerGame(forged, verify).ok).toBe(false);
    expect(checkPlayerGame(clone(recording), answerVerifier('another secret, another server'.repeat(3))).ok).toBe(false);
    expect(checkPlayerGame({ ...clone(recording), setup: { ...recording.setup!, lineup: { blinky: 'opper/clef', pinky: 'opper/clef', inky: 'opper/clef', clyde: 'opper/clef' } } }, verify).ok).toBe(false);
  });

  it('refuses a game made mostly of backup-rule moves', () => {
    const lazy = clone(recording);
    for (const d of lazy.decisions) d[3] = 'f';
    expect(checkPlayerGame(lazy, verify)).toMatchObject({ ok: false, error: 'too many backup moves' });
  });

  it('refuses a game that is not over, odd steps, and anything that is not a game against AI ghosts', () => {
    expect(checkPlayerGame({ ...recording, steps: 50, final: { ...recording.final, frames: 50 } }, verify).ok).toBe(false);
    expect(checkPlayerGame({ ...recording, fixedStep: 1 }, verify).ok).toBe(false);
    expect(checkPlayerGame({ ...recording, setup: { pacmanControl: 'jev', ghostsByAI: false } }, verify).ok).toBe(false);
    expect(checkPlayerGame(null, verify).ok).toBe(false);
  });
});
