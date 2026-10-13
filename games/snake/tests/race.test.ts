import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecideResponse, SystemOneRequest, Transport } from '../../../packages/kit/shared/systemone';
import { seedFor } from '../game';
import { baselineTransport } from '../shared/baselines';
import { createGame, step, type Move } from '../shared/engine';
import { fallbackMove, allFacts, viewOf } from '../shared/questions';
import { RealtimeSnake, SPEED_STEP_MS, startClock } from '../shared/race';

const answer = (choice: unknown, extra: Partial<DecideResponse> = {}): DecideResponse => ({ answers: { snake: { type: 'choice', choice } }, usage: { input_tokens: 400, output_tokens: 2 }, latencyMs: 30, costUsd: 0.0001, traceId: null, ...extra });

/** A model that answers `choice` after `delay(n)` ms (n counts requests from 0), and counts what is in flight. */
function slowModel(delay: (n: number) => number, choice: (n: number) => Move = () => 'straight') {
  const t = { bodies: [] as SystemOneRequest[], inFlight: 0, maxInFlight: 0 };
  const transport: Transport = (body) => {
    const n = t.bodies.length;
    t.bodies.push(body);
    t.inFlight += 1;
    t.maxInFlight = Math.max(t.maxInFlight, t.inFlight);
    return new Promise((res) =>
      setTimeout(() => {
        t.inFlight -= 1;
        res(answer(choice(n), { signatures: { snake: `sig${n}` }, signedAs: 'm' }));
      }, delay(n)),
    );
  };
  return { t, transport };
}

const STEP = SPEED_STEP_MS.normal;

describe('RealtimeSnake', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('uses an answer that arrives before the tick, and asks about the next board as soon as a step is applied', async () => {
    const { t, transport } = slowModel(() => 200);
    const ai = new RealtimeSnake({ transport, seed: seedFor(2), requestModel: 'm', timeoutMs: 2000 });
    expect(t.bodies).toHaveLength(1);
    expect(t.bodies[0]).toMatchObject({ model: 'm', keys: { snake: 's0' } });
    await vi.advanceTimersByTimeAsync(STEP);
    expect(ai.tick()).toEqual({ choice: 'straight', source: 'model', latencyMs: 30, costUsd: 0.0001, sig: 'sig0' });
    // Asked again right away, about the board after the step.
    expect(t.bodies).toHaveLength(2);
    expect(t.bodies[1]).toMatchObject({ keys: { snake: 's1' } });
    await vi.advanceTimersByTimeAsync(STEP);
    expect(ai.tick()?.source).toBe('model');
    expect(ai.fallbacks).toBe(0);
    expect(t.maxInFlight).toBe(1);
  });

  it("falls back when the answer hasn't arrived by the tick, and never applies a stale answer", async () => {
    // The first answer (left) comes 300 ms after it was asked: after the first tick at 250 ms.
    const { t, transport } = slowModel(
      (n) => (n === 0 ? 300 : 50),
      (n) => (n === 0 ? 'left' : 'straight'),
    );
    const ai = new RealtimeSnake({ transport, seed: seedFor(2), timeoutMs: 2000 });
    const start = ai.state;
    await vi.advanceTimersByTimeAsync(STEP);
    const first = ai.tick()!;
    // The game's own fallback rule, as playSnake uses it.
    expect(first).toEqual({ choice: fallbackMove(allFacts(viewOf(start))), source: 'fallback' });
    // One request at a time: the next question waits for the late one to come back.
    expect(t.bodies).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(t.bodies).toHaveLength(2);
    expect(t.bodies[1]).toMatchObject({ keys: { snake: 's1' } });
    await vi.advanceTimersByTimeAsync(STEP - 50);
    // The late "left" was for step 0: it is not used now.
    expect(ai.tick()).toMatchObject({ choice: 'straight', source: 'model', sig: 'sig1' });
    expect(ai.state).toEqual(step(step(start, first.choice), 'straight'));
    expect(t.maxInFlight).toBe(1);
  });

  it('falls back on every step when the model is always slower than the clock, with one request in flight', async () => {
    const { t, transport } = slowModel(() => 300);
    const ai = new RealtimeSnake({ transport, seed: seedFor(3), timeoutMs: 2000 });
    for (let i = 0; i < 6 && !ai.over; i++) {
      await vi.advanceTimersByTimeAsync(STEP);
      expect(ai.tick()?.source).toBe('fallback');
    }
    expect(t.maxInFlight).toBe(1);
    // Every late call is still paid for.
    expect(ai.costUsd).toBeGreaterThan(0);
  });

  it('falls back on an error or an unusable answer', async () => {
    let n = 0;
    const ai = new RealtimeSnake({
      transport: async () => {
        n += 1;
        if (n === 1) throw new Error('boom');
        return answer('up');
      },
      seed: seedFor(4),
      timeoutMs: 2000,
    });
    await vi.advanceTimersByTimeAsync(STEP);
    expect(ai.tick()?.source).toBe('fallback');
    await vi.advanceTimersByTimeAsync(STEP);
    expect(ai.tick()?.source).toBe('fallback');
  });

  it('a baseline answers at once, so it never falls back, even at the fast speed', async () => {
    const ai = new RealtimeSnake({ transport: baselineTransport('flood'), seed: seedFor(5), timeoutMs: 2000 });
    while (!ai.over) {
      await vi.advanceTimersByTimeAsync(SPEED_STEP_MS.fast);
      ai.tick();
    }
    expect(ai.fallbacks).toBe(0);
    expect(ai.result()).toMatchObject({ fallbacks: 0, decisions: ai.steps.length });
    expect(ai.tick()).toBeNull();
  });

  it('asks nothing more once stopped', async () => {
    const { t, transport } = slowModel(() => 10);
    const ai = new RealtimeSnake({ transport, seed: seedFor(2), timeoutMs: 2000 });
    ai.stop();
    await vi.advanceTimersByTimeAsync(STEP);
    expect(ai.tick()).toBeNull();
    expect(t.bodies).toHaveLength(1);
    expect(ai.state).toEqual(createGame(seedFor(2)));
  });
});

describe('startClock', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ticks every stepMs until onTick returns false or it is stopped', () => {
    let n = 0;
    startClock(250, () => ++n < 4);
    vi.advanceTimersByTime(250 * 10);
    expect(n).toBe(4);
    let m = 0;
    const stop = startClock(400, () => (m++, true));
    vi.advanceTimersByTime(1000);
    stop();
    vi.advanceTimersByTime(1000);
    expect(m).toBe(2);
  });

  it('both boards step together: after ~5 s at each speed, the same number of steps on each', async () => {
    for (const ms of Object.values(SPEED_STEP_MS)) {
      const ai = new RealtimeSnake({ transport: baselineTransport('greedy'), seed: seedFor(6), timeoutMs: 2000 });
      let you = createGame(seedFor(6));
      const stop = startClock(ms, () => {
        you = step(you, 'straight');
        ai.tick();
        return true;
      });
      await vi.advanceTimersByTimeAsync(5000);
      stop();
      expect(you.steps).toBe(Math.min(Math.floor(5000 / ms), you.steps));
      // The player's board goes into a wall quickly going straight; the AI keeps step for as long as both are alive.
      expect(ai.steps.length).toBeGreaterThanOrEqual(you.steps);
      expect(ai.steps.length).toBeLessThanOrEqual(Math.floor(5000 / ms));
    }
  });
});
