import type { Adapter, Answer } from '../../shared/adapter.ts';
import { InvalidAnswer } from '../../shared/adapter.ts';
import type { Clock } from '../../shared/match.ts';
import type { Question } from '../../shared/question.ts';

/** A virtual clock: sleep() advances time and fires timers in order. */
export class FakeClock implements Clock {
  t = 0;
  private timers: { at: number; fire: () => void }[] = [];
  now = () => this.t;
  delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = { at: this.t + ms, fire: resolve };
      this.timers.push(timer);
      signal?.addEventListener('abort', () => {
        this.timers = this.timers.filter((x) => x !== timer);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  }
  async sleep(ms: number): Promise<void> {
    const target = this.t + Math.max(0, ms);
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.t = next.at;
      next.fire();
      await new Promise((r) => setImmediate(r));
    }
    this.t = target;
    await new Promise((r) => setImmediate(r));
  }
}

/**
 * A fake model: picks by a simple deterministic rule from the options, after `latency(k)` virtual ms.
 * `bad(k)` makes the k-th answer invalid.
 */
export function fakeAdapter(id: string, clock: FakeClock, latency: (k: number) => number, bad: (k: number) => boolean = () => false): Adapter {
  let k = 0;
  return {
    id,
    kind: 'systemone',
    async warmUp() {},
    async decide(q: Question, signal: AbortSignal): Promise<Answer> {
      const n = k++;
      const lat = latency(n);
      await clock.delay(lat, signal);
      if (bad(n)) throw new InvalidAnswer('bad');
      const score = (facts: string, id: string) => {
        const m = /lands \((\d+)\)/.exec(facts);
        if (m) return Number(m[1]);
        return id === 'walk_forward' ? 0.5 : ((n + id.length) % 7) / 10;
      };
      const scored = q.options.map((o) => ({ id: o.id, s: score(o.facts, o.id) }));
      scored.sort((a, b) => b.s - a.s);
      const total = scored.reduce((a, x) => a + x.s + 0.1, 0);
      return {
        move: scored[0].id,
        probabilities: Object.fromEntries(scored.map((x) => [x.id, (x.s + 0.1) / total])),
        latencyMs: lat,
        costUsd: 0.00001,
        inputTokens: 100,
      };
    },
  };
}
