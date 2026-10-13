import { existsSync, readFileSync } from 'node:fs';
import { RECORDINGS } from '../src/recordings';
import { describe, expect, it } from 'vitest';
import { Recorder, Replay, type Recording } from '../src/replay';
import { createGame } from '../src/sim';
import { recordGreedy } from './support/greedy-recording';

describe('Replay', () => {
  it('replays a recording to the same final state', () => {
    const rec = recordGreedy(1500);
    expect(rec.decisions.length).toBeGreaterThan(20);
    const replay = new Replay(rec);
    while (!replay.done) replay.stepFrame();
    expect({ score: replay.state.score, lives: replay.state.lives, level: replay.state.level, frames: replay.frame }).toEqual(rec.final);
  });

  it('hands out recorded events at their frame', () => {
    const rec: Recording = { ...recordGreedy(10), events: [[2, { type: 'error', message: 'x' }]] };
    const replay = new Replay(rec);
    expect(replay.stepFrame()).toEqual([]);
    expect(replay.stepFrame()).toEqual([]);
    expect(replay.stepFrame()).toEqual([{ type: 'error', message: 'x' }]);
  });

  it('records call events without their trace id and replays them with traceId null', () => {
    const rec = new Recorder();
    const call = { type: 'call' as const, actors: ['blinky' as const], latencyMs: 120, usage: { input_tokens: 5, output_tokens: 2 }, costUsd: 0.00002, traceId: 'trace-secret' };
    rec.record(0, call);
    rec.record(0, { type: 'error', message: 'x' });
    rec.frames.push(0.016);
    const recording = rec.finish(createGame(), 'jev');
    expect(JSON.stringify(recording)).not.toContain('traceId');
    const { traceId: _omit, ...withoutTrace } = call;
    expect(recording.events).toEqual([[0, withoutTrace], [0, { type: 'error', message: 'x' }]]);
    expect(new Replay(recording).stepFrame()).toEqual([{ ...call, traceId: null }, { type: 'error', message: 'x' }]);
  });

  it('stays put and hands out nothing once the recording is done', () => {
    const rec: Recording = { ...recordGreedy(3), events: [[2, { type: 'error', message: 'x' }]] };
    const replay = new Replay(rec);
    while (!replay.done) replay.stepFrame();
    const before = JSON.stringify(replay.state);
    expect(replay.stepFrame()).toEqual([]);
    expect(replay.frame).toBe(3);
    expect(JSON.stringify(replay.state)).toBe(before);
  });

  // Watch plays these: each must exist, be the model it is listed under, and replay exactly.
  for (const [model, { path, score }] of Object.entries(RECORDINGS)) {
    const file = new URL(`../public${path}`, import.meta.url);
    it(`replays ${path} exactly (re-record if this fails after a sim change)`, () => {
      expect(existsSync(file), `public${path} is missing`).toBe(true);
      const rec = JSON.parse(readFileSync(file, 'utf8')) as Recording;
      expect(rec.model).toBe(model);
      const replay = new Replay(rec);
      while (!replay.done) replay.stepFrame();
      expect({ score: replay.state.score, lives: replay.state.lives, level: replay.state.level, frames: replay.frame }).toEqual(rec.final);
      expect(rec.final.score, 'the score listed in src/recordings.ts').toBe(score);
    });
  }
});
