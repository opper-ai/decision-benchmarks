import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecideResponse, SystemOneRequest } from '../../../packages/kit/shared/systemone';
import { verifyGame } from '../bench/verify';
import game, { seedFor } from '../game';
import { baselineTransport } from '../shared/baselines';
import { turn } from '../shared/engine';
import { parseState } from '../shared/questions';
import { playSnake, STEP_MS } from '../shared/play';

const answer = (choice: unknown, extra: Partial<DecideResponse> = {}): DecideResponse => ({ answers: { snake: { type: 'choice', choice } }, usage: { input_tokens: 400, output_tokens: 2 }, latencyMs: 30, costUsd: 0.0001, traceId: null, ...extra });
/** Resolves with `v` after `ms`, unless `signal` cancels it first. */
const later = <T>(ms: number, v: T, signal?: AbortSignal) =>
  new Promise<T>((res, rej) => {
    const timer = setTimeout(() => res(v), ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), rej(new Error('cancelled'))));
  });

describe('playSnake', () => {
  afterEach(() => vi.useRealTimers());

  it('is real time on a 275 ms clock, the same for every model', () => {
    expect(game.mode).toBe('realtime');
    expect(STEP_MS).toBe(275);
    expect(game.timing).toEqual({ decisionTimeoutMs: 275, callTimeoutMs: 2000, maxInFlight: 1 });
  });

  it('asks one snake question per step, names the model on the page, and records the answers, costs and signatures', async () => {
    const bodies: SystemOneRequest[] = [];
    const { result, recording } = await playSnake({
      transport: async (body) => {
        bodies.push(body);
        // Straight on: the direction it is heading.
        return answer(parseState(body.state)!.heading, { signatures: { snake: 'sig' }, signedAs: 'sference/clef' });
      },
      seed: seedFor(2),
      model: 'sference/clef',
      requestModel: 'sference/clef',
      timeoutMs: 2000,
      stepMs: 2,
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

  it('steps on the clock whatever the model does: the tick cancels a late request and the fallback plays its step', async () => {
    vi.useFakeTimers();
    // Every third answer takes 700 ms, past even its extended window (asked a step early); the others take 50 ms.
    let n = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    let cancelled = 0;
    const transport = (body: SystemOneRequest, opts?: { signal?: AbortSignal }) => {
      const slow = n++ % 3 === 2;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      let done = false;
      const end = () => {
        if (!done) inFlight -= 1;
        done = true;
      };
      opts?.signal?.addEventListener('abort', () => (cancelled += 1, end()));
      return later(slow ? 700 : 50, answer(turn(parseState(body.state)!.heading, 'left'), { latencyMs: slow ? 700 : 50, costUsd: 0.0002 }), opts?.signal).finally(end);
    };
    const started = Date.now();
    const played = playSnake({ transport, seed: seedFor(7), model: 'm', timeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(1000 * STEP_MS);
    const { result, recording } = await played;
    // One step a tick: the game took its steps x 275 ms.
    expect(recording.steps.length).toBe(result.steps);
    expect(Math.round((Date.now() - started) / STEP_MS)).toBeGreaterThanOrEqual(result.steps);
    expect(maxInFlight).toBe(1);
    // Exactly every third step is late: lateness never carries over to the next step.
    expect(recording.steps.map((s) => s.source)).toEqual(recording.steps.map((_, i) => (i % 3 === 2 ? 'fallback' : 'model')));
    const late = recording.steps.filter((s) => s.source === 'fallback');
    expect(cancelled).toBe(late.length);
    expect(result.fallbacks).toBe(late.length);
    // A cancelled call had its step and the one before (it was asked early), and its unknown cost is the mean of the
    // game's answered calls.
    expect(new Set(late.map((s) => s.latencyMs))).toEqual(new Set([2 * STEP_MS]));
    for (const s of late) expect(s.costUsd).toBeCloseTo(0.0002, 10);
    expect(recording.steps.filter((s) => s.source === 'model').every((s) => s.latencyMs === 50)).toBe(true);
    expect(result.cost).toBeCloseTo(0.0002 * recording.steps.length);
    expect(verifyGame(JSON.parse(JSON.stringify(recording)), { seed: seedFor(7) }).ok).toBe(true);
  });

  it('uses the fallback for an invalid answer or an error', async () => {
    let n = 0;
    const { result, recording } = await playSnake({
      transport: async () => {
        n += 1;
        if (n % 2) return answer('backwards');
        throw new Error('boom');
      },
      seed: seedFor(3),
      model: 'm',
      timeoutMs: 2000,
      stepMs: 1,
    });
    expect(recording.steps.every((s) => s.source === 'fallback')).toBe(true);
    expect(result.fallbacks).toBe(recording.steps.length);
    expect(verifyGame(JSON.parse(JSON.stringify(recording)), { seed: seedFor(3) }).ok).toBe(true);
  });

  it('a baseline answers at once, so it never falls back at the benchmark speed', async () => {
    vi.useFakeTimers();
    const played = playSnake({ transport: baselineTransport('flood'), seed: seedFor(1), model: 'baseline/flood', timeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(1000 * STEP_MS);
    const { result } = await played;
    expect(result).toMatchObject({ fallbacks: 0 });
    expect(result.steps).toBeGreaterThan(20);
  });

  it('stops when asked, before or during a game', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(playSnake({ transport: async () => answer('straight'), seed: 1, model: 'm', timeoutMs: 100, signal: ctl.signal })).rejects.toThrow(/stopped/);
    const mid = new AbortController();
    const played = playSnake({ transport: async () => answer('straight'), seed: 1, model: 'm', timeoutMs: 100, stepMs: 5, signal: mid.signal });
    setTimeout(() => mid.abort(), 12);
    await expect(played).rejects.toThrow(/stopped/);
  });
});
