import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelWarming } from '../../../packages/kit/client/warming';
import { decisionModels, warmTable } from '../src/warm';

afterEach(() => vi.useRealTimers());

describe('waking the models before a table', () => {
  it("warms each decision model once, never a chat model, and says nothing when it's quick", async () => {
    const warmUp = vi.fn(async (_model: string) => true);
    const onSlow = vi.fn();
    const failed = await warmTable(['sference/clef', 'aws/claude-haiku-5-5-eu', 'sference/clef', 'typesafe/jev-1.13.0'], new ModelWarming({ warmUp, now: () => 0 }), { onSlow });
    expect(failed).toEqual([]);
    expect(warmUp.mock.calls.map((c) => c[0]).sort()).toEqual(['sference/clef', 'typesafe/jev-1.13.0']);
    expect(onSlow).not.toHaveBeenCalled();
    expect(decisionModels(['aws/claude-opus-5-5', 'azure:eu/gpt-6-luna'])).toEqual([]);
  });

  it('says it is waking the models after a second, and reports the ones that would not wake', async () => {
    vi.useFakeTimers();
    let wake: (ok: boolean) => void = () => {};
    const warmUp = vi.fn((m: string) => (m === 'sference/clef' ? new Promise<boolean>((r) => (wake = r)) : Promise.resolve(true)));
    const onSlow = vi.fn();
    const pending = warmTable(['sference/clef', 'typesafe/jev-1.13.0'], new ModelWarming({ warmUp, now: () => 0 }), { onSlow });
    await vi.advanceTimersByTimeAsync(999);
    expect(onSlow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onSlow).toHaveBeenCalledTimes(1);
    wake(false);
    await vi.advanceTimersByTimeAsync(0);
    wake(false);
    expect(await pending).toEqual(['sference/clef']);
  });

  it('warms nothing for a table of chat models', async () => {
    const warmUp = vi.fn(async () => true);
    expect(await warmTable(['aws/claude-opus-5-5'], new ModelWarming({ warmUp, now: () => 0 }), { onSlow: () => {} })).toEqual([]);
    expect(warmUp).not.toHaveBeenCalled();
  });
});
