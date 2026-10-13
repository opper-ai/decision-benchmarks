import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecideResponse, SystemOneRequest, Transport } from '../../../packages/kit/shared/systemone';
import { seedFor } from '../game';
import { baselineTransport } from '../shared/baselines';
import { createGame, step, turn, type Move } from '../shared/engine';
import { fallbackMove, allFacts, parseState, viewOf } from '../shared/questions';
import { RealtimeSnake, SPEED_STEP_MS, startClock } from '../shared/race';

const answer = (choice: unknown, extra: Partial<DecideResponse> = {}): DecideResponse => ({ answers: { snake: { type: 'choice', choice } }, usage: { input_tokens: 400, output_tokens: 2 }, latencyMs: 30, costUsd: 0.0001, traceId: null, ...extra });

/**
 * A model that answers `choice` after `delay(n)` ms (n counts requests from 0), and counts what is in flight. A
 * request it is told to cancel stops at once.
 */
function slowModel(delay: (n: number) => number, choice: (n: number) => Move = () => 'straight') {
  const t = { bodies: [] as SystemOneRequest[], sentAt: [] as number[], answeredAt: [] as number[], inFlight: 0, maxInFlight: 0, cancelled: 0 };
  const transport: Transport = (body, opts) => {
    const n = t.bodies.length;
    t.bodies.push(body);
    t.sentAt.push(Date.now());
    t.inFlight += 1;
    t.maxInFlight = Math.max(t.maxInFlight, t.inFlight);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        t.inFlight -= 1;
        t.answeredAt[n] = Date.now();
        res(answer(turn(parseState(body.state)!.heading, choice(n)), { signatures: { snake: `sig${n}` }, signedAs: 'm', latencyMs: delay(n) }));
      }, delay(n));
      opts?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        t.inFlight -= 1;
        t.cancelled += 1;
        rej(new Error('cancelled'));
      });
    });
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
    expect(ai.tick()).toEqual({ choice: 'straight', source: 'model', latencyMs: 200, costUsd: 0.0001, sig: 'sig0' });
    // Asked again right away, about the board after the step.
    expect(t.bodies).toHaveLength(2);
    expect(t.bodies[1]).toMatchObject({ keys: { snake: 's1' } });
    await vi.advanceTimersByTimeAsync(STEP);
    expect(ai.tick()?.source).toBe('model');
    expect(ai.fallbacks).toBe(0);
    expect(t.maxInFlight).toBe(1);
  });

  it("cancels a request the tick beat, plays the fallback, and asks about the next board at once", async () => {
    // The first answer (left) would come 300 ms after it was asked: after the first tick at 275 ms.
    const { t, transport } = slowModel(
      (n) => (n === 0 ? 300 : 50),
      (n) => (n === 0 ? 'left' : 'straight'),
    );
    const ai = new RealtimeSnake({ transport, seed: seedFor(2), timeoutMs: 2000 });
    const start = ai.state;
    await vi.advanceTimersByTimeAsync(STEP);
    const first = ai.tick()!;
    // The game's own fallback rule, as the benchmark uses it; the cancelled call took the whole step.
    expect(first).toEqual({ choice: fallbackMove(allFacts(viewOf(start))), source: 'fallback', latencyMs: STEP });
    expect(t.cancelled).toBe(1);
    expect(ai.cancelled).toBe(1);
    // The next question went out at once, with no wait for the cancelled one.
    expect(t.bodies).toHaveLength(2);
    expect(t.bodies[1]).toMatchObject({ keys: { snake: 's1' } });
    await vi.advanceTimersByTimeAsync(STEP);
    // The cancelled "left" never arrives, and the fresh answer is in time.
    expect(ai.tick()).toMatchObject({ choice: 'straight', source: 'model', sig: 'sig1' });
    expect(ai.state).toEqual(step(step(start, first.choice), 'straight'));
    expect(t.maxInFlight).toBe(1);
  });

  const playFor = async (delay: (n: number) => number, ticks: number) => {
    const { t, transport } = slowModel(delay);
    const started = Date.now();
    const ai = new RealtimeSnake({ transport, seed: seedFor(2), timeoutMs: 2000 });
    for (let i = 0; i < ticks && !ai.over; i++) {
      await vi.advanceTimersByTimeAsync(STEP);
      ai.tick();
    }
    ai.stop();
    return { t, ai, sent: t.sentAt.map((x) => x - started), answered: t.answeredAt.map((x) => x - started) };
  };

  it('asks early: a model at 150 ms gets each question right after its previous answer, and is never late', async () => {
    const { t, ai, sent, answered } = await playFor(() => 150, 8);
    expect(ai.steps.length).toBe(8);
    expect(ai.fallbacks).toBe(0);
    // One step ahead at most: question n+1 goes out when answer n is in, unless step n-1 is still to be played.
    for (let n = 1; n < sent.length; n++) expect(sent[n]).toBe(Math.max(answered[n - 1]!, (n - 1) * STEP));
    expect(sent.slice(0, 3)).toEqual([0, 150, 300]);
    expect(t.maxInFlight).toBe(1);
  });

  it('gives a step the time left from the one before: 150 ms then 300 ms is on time for both', async () => {
    // Step 0 answered at 150; step 1 asked then, answered at 450, before its tick at 550.
    const { ai, sent } = await playFor((n) => (n === 1 ? 300 : 150), 3);
    expect(sent.slice(0, 2)).toEqual([0, 150]);
    expect(ai.steps.slice(0, 2).map((s) => [s.source, s.latencyMs])).toEqual([
      ['model', 150],
      ['model', 300],
    ]);
  });

  it('a late step restarts the next question at the tick: a model always over the step is always late', async () => {
    const { t, ai, sent } = await playFor(() => STEP + 10, 6);
    expect(ai.steps.every((s) => s.source === 'fallback' && s.latencyMs === STEP)).toBe(true);
    expect(sent).toEqual(ai.steps.map((_, i) => i * STEP).concat(ai.over ? [] : [ai.steps.length * STEP]));
    expect(t.maxInFlight).toBe(1);
    const fast = await playFor(() => STEP - 10, 6);
    expect(fast.ai.fallbacks).toBe(0);
    expect(fast.ai.cancelled).toBe(0);
  });

  it('falls back on an error or an unusable answer', async () => {
    let n = 0;
    const ai = new RealtimeSnake({
      transport: async () => {
        n += 1;
        if (n === 1) throw new Error('boom');
        return answer('backwards');
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
    // The request still out is cancelled.
    expect(t.cancelled).toBe(1);
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
