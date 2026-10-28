// The table's speaker queue (src/speaker.ts): in order, one at a time, never far behind the table, silent when voice is
// off or hushed, cleared on the way out.
import { describe, expect, it } from 'vitest';
import { Speaker, voiceRate, type Playing } from '../src/speaker';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A speaker over fake loads and a fake player: each load resolves when told, each line plays until ended. */
function rig(o: { maxLagMs?: number; speed?: number } = {}) {
  let on = true;
  let now = 0;
  const loads: { line: string; resolve: (a: string | null) => void; signal: AbortSignal }[] = [];
  const played: { audio: string; rate: number; end: () => void; stopped: boolean }[] = [];
  const s = new Speaker<string, string>({
    now: () => now,
    enabled: () => on,
    speed: () => o.speed ?? 1,
    maxLagMs: o.maxLagMs ?? 1000,
    load: (line, signal) => new Promise((resolve) => loads.push({ line, resolve, signal })),
    play: (audio, rate): Playing => {
      let end!: () => void;
      const done = new Promise<void>((r) => (end = r));
      const p = { audio, rate, end, stopped: false };
      played.push(p);
      return { done, stop: () => ((p.stopped = true), end()) };
    },
  });
  return { s, loads, played, setOn: (v: boolean) => (on = v), advance: (ms: number) => (now += ms) };
}

describe('the speaker', () => {
  it('plays lines in the order said, one at a time, loading the next while one plays', async () => {
    const r = rig();
    r.s.say('a');
    r.s.say('b');
    // Both start loading at once.
    expect(r.loads.map((l) => l.line)).toEqual(['a', 'b']);
    r.loads[1]!.resolve('B');
    await tick();
    expect(r.played).toHaveLength(0);
    r.loads[0]!.resolve('A');
    await tick();
    expect(r.played.map((p) => p.audio)).toEqual(['A']);
    expect(r.s.speaking).toBe(true);
    r.played[0]!.end();
    await tick();
    expect(r.played.map((p) => p.audio)).toEqual(['A', 'B']);
    r.played[1]!.end();
    await tick();
    expect(r.s.speaking).toBe(false);
    expect(r.s.waiting).toBe(0);
  });

  it('drops a line that would start too long after it was said, and skips a line that could not be loaded', async () => {
    const r = rig();
    r.s.say('a');
    r.s.say('b');
    r.s.say('c');
    r.loads[0]!.resolve('A');
    r.loads[1]!.resolve(null);
    r.loads[2]!.resolve('C');
    await tick();
    expect(r.played.map((p) => p.audio)).toEqual(['A']);
    // A plays for longer than the lag: C, waiting all that time, is dropped.
    r.advance(1500);
    r.played[0]!.end();
    await tick();
    expect(r.played.map((p) => p.audio)).toEqual(['A']);
    expect(r.loads[2]!.signal.aborted).toBe(true);
    // A line said now still plays.
    r.s.say('d');
    r.loads[3]!.resolve('D');
    await tick();
    expect(r.played.map((p) => p.audio)).toEqual(['A', 'D']);
  });

  it('gives up on a load that hangs past the lag, and moves on', async () => {
    const r = rig({ maxLagMs: 30 });
    r.s.say('a');
    r.s.say('b');
    r.loads[1]!.resolve('B');
    await tick(60);
    // The real clock passed the lag while a's load hung; the fake clock says b was said just now, so b plays.
    expect(r.loads[0]!.signal.aborted).toBe(true);
    expect(r.played.map((p) => p.audio)).toEqual(['B']);
  });

  it('loads and plays nothing while voice is off or hushed, and drops a waiting line when voice goes off', async () => {
    const r = rig();
    r.setOn(false);
    r.s.say('a');
    expect(r.loads).toHaveLength(0);
    r.setOn(true);
    r.s.say('b');
    r.setOn(false);
    r.loads[0]!.resolve('B');
    await tick();
    expect(r.played).toHaveLength(0);
  });

  it('stops the line playing and forgets the rest on clear, and speaks again after', async () => {
    const r = rig();
    r.s.say('a');
    r.s.say('b');
    r.loads[0]!.resolve('A');
    await tick();
    r.s.clear();
    expect(r.played[0]!.stopped).toBe(true);
    expect(r.loads[1]!.signal.aborted).toBe(true);
    r.loads[1]!.resolve('B');
    await tick();
    expect(r.played.map((p) => p.audio)).toEqual(['A']);
    r.s.say('c');
    r.loads[2]!.resolve('C');
    await tick();
    expect(r.played.map((p) => p.audio)).toEqual(['A', 'C']);
  });

  it('clears while a line is still loading, and the old load never plays', async () => {
    const r = rig();
    r.s.say('a');
    r.s.clear();
    r.s.say('b');
    r.loads[0]!.resolve('A');
    r.loads[1]!.resolve('B');
    await tick();
    expect(r.played.map((p) => p.audio)).toEqual(['B']);
  });

  it('speaks at 1.2× up to 2×, 1.3× at 4× and 1.4× at 8×', async () => {
    expect([1, 2, 4, 8].map(voiceRate)).toEqual([1.2, 1.2, 1.3, 1.4]);
    const r = rig({ speed: 8 });
    r.s.say('a');
    r.loads[0]!.resolve('A');
    await tick();
    expect(r.played[0]!.rate).toBe(1.4);
  });
});

describe('the table waiting for the speaker', () => {
  const settledWithin = async (p: Promise<void>, ms: number) => Promise.race([p.then(() => true), tick(ms).then(() => false)]);

  it('goes on at once when there is nothing to say (Voice off, or nothing said)', async () => {
    const r = rig();
    expect(await settledWithin(r.s.settled(1000), 5)).toBe(true);
    r.setOn(false);
    r.s.say('a');
    expect(await settledWithin(r.s.settled(1000), 5)).toBe(true);
  });

  it('waits for the line playing, and the ones loading after it, to finish', async () => {
    const r = rig();
    r.s.say('a');
    r.s.say('b');
    r.loads[0]!.resolve('A');
    await tick();
    const waited = r.s.settled(1000);
    expect(await settledWithin(waited, 10)).toBe(false);
    r.played[0]!.end();
    r.loads[1]!.resolve('B');
    await tick();
    expect(await settledWithin(waited, 10)).toBe(false);
    r.played[1]!.end();
    expect(await settledWithin(waited, 10)).toBe(true);
    expect(r.s.idle).toBe(true);
  });

  it('never waits past the cap, however long the line', async () => {
    const r = rig();
    r.s.say('a');
    r.loads[0]!.resolve('A');
    await tick();
    const started = performance.now();
    await r.s.settled(40);
    expect(performance.now() - started).toBeLessThan(200);
    expect(r.s.speaking).toBe(true);
  });

  it('goes on when a line fails, or is dropped, or the speaker is cleared', async () => {
    const r = rig();
    r.s.say('a');
    const failed = r.s.settled(1000);
    r.loads[0]!.resolve(null);
    expect(await settledWithin(failed, 10)).toBe(true);
    r.s.say('b');
    r.loads[1]!.resolve('B');
    await tick();
    const cleared = r.s.settled(1000);
    r.s.clear();
    expect(await settledWithin(cleared, 10)).toBe(true);
  });
});
