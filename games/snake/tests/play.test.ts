import { describe, expect, it } from 'vitest';
import type { DecideResponse, SystemOneRequest } from '../../../packages/kit/shared/systemone';
import { verifyGame } from '../bench/verify';
import { seedFor } from '../game';
import { playSnake } from '../shared/play';

const answer = (choice: unknown, extra: Partial<DecideResponse> = {}): DecideResponse => ({ answers: { snake: { type: 'choice', choice } }, usage: { input_tokens: 400, output_tokens: 2 }, latencyMs: 30, costUsd: 0.0001, traceId: null, ...extra });

describe('playSnake', () => {
  it('asks one snake question per step, names the model on the page, and records the answers, costs and signatures', async () => {
    const bodies: SystemOneRequest[] = [];
    const { result, recording } = await playSnake({
      transport: async (body) => {
        bodies.push(body);
        return answer('straight', { signatures: { snake: 'sig' }, signedAs: 'sference/clef' });
      },
      seed: seedFor(2),
      model: 'sference/clef',
      requestModel: 'sference/clef',
      timeoutMs: 2000,
    });
    // Straight on from the middle: into the wall after 8 steps, unless an apple was in the way.
    expect(result.end).toBe('wall');
    expect(bodies).toHaveLength(recording.steps.length);
    expect(bodies[0]).toMatchObject({ model: 'sference/clef', keys: { snake: 's0' } });
    expect(Object.keys(bodies[0]!.questions)).toEqual(['snake']);
    expect(recording.steps[0]).toEqual({ choice: 'straight', source: 'model', latencyMs: 30, costUsd: 0.0001, sig: 'sig' });
    expect(result).toMatchObject({ calls: recording.steps.length, decisions: recording.steps.length, fallbacks: 0 });
    expect(result.cost).toBeCloseTo(0.0001 * recording.steps.length);
    expect(verifyGame(JSON.parse(JSON.stringify(recording)), { seed: seedFor(2) }).ok).toBe(true);
  });

  it("uses the fallback for an invalid answer, an error or a timeout, and still counts a late call's cost", async () => {
    let n = 0;
    const { result, recording } = await playSnake({
      transport: async () => {
        n += 1;
        if (n === 1) return answer('up');
        if (n === 2) throw new Error('boom');
        if (n === 3) return new Promise((res) => setTimeout(() => res(answer('left')), 80));
        return answer('nonsense');
      },
      seed: seedFor(3),
      model: 'm',
      timeoutMs: 20,
    });
    expect(recording.steps.every((s) => s.source === 'fallback')).toBe(true);
    // The late answer's call came back after its step: its cost still counts.
    expect(recording.steps[2]).toMatchObject({ source: 'fallback', latencyMs: 30, costUsd: 0.0001 });
    expect(result.fallbacks).toBe(recording.steps.length);
    expect(verifyGame(JSON.parse(JSON.stringify(recording)), { seed: seedFor(3) }).ok).toBe(true);
  });

  it('stops when asked', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(playSnake({ transport: async () => answer('straight'), seed: 1, model: 'm', timeoutMs: 100, signal: ctl.signal })).rejects.toThrow(/stopped/);
  });
});
