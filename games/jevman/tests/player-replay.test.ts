import { describe, expect, it } from 'vitest';
import { Replay } from '../src/replay';
import type { Dir } from '../src/types';
import { playAndRecord } from './support/player-game';

describe("a player's game", () => {
  it('replays to the same score, lives and level from its steering and the ghosts answers', () => {
    for (const seed of [1, 7, 42]) {
      const { state, recording } = playAndRecord(seed);
      expect(recording.keys!.length).toBeGreaterThan(5);
      const replay = new Replay(recording);
      while (!replay.done) replay.stepFrame();
      expect({ score: replay.state.score, lives: replay.state.lives, level: replay.state.level }).toEqual({ score: state.score, lives: state.lives, level: state.level });
      expect({ score: replay.state.score, lives: replay.state.lives, level: replay.state.level, frames: replay.frame }).toEqual(recording.final);
    }
  });

  it('does not replay to the same score if the steering is changed', () => {
    const { recording } = playAndRecord(7);
    const tampered = { ...recording, keys: recording.keys!.map(([f, d], i) => [f, i % 2 ? d : null] as [number, Dir | null]) };
    const replay = new Replay(tampered);
    while (!replay.done) replay.stepFrame();
    expect(replay.state.score).not.toBe(recording.final.score);
  });
});
