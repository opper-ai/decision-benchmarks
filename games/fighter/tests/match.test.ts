import { describe, expect, it } from 'vitest';
import { Match } from '../shared/match.ts';
import { ReplayPlayer, decodeReplay, encodeReplay } from '../shared/replay.ts';
import { bradleyTerry, leaderboard, matchStats } from '../shared/stats.ts';
import { FakeClock, fakeAdapter } from './support/fake.ts';

const meta = (model: string) => ({ model, label: model, kind: 'systemone', color: '#000' });

async function playMatch(mode: 'realtime' | 'paused', seed = 5) {
  const clock = new FakeClock();
  const m = new Match({
    seed,
    mode,
    deadlineMs: 2000,
    clock,
    fighters: [meta('fast'), meta('slow')],
    adapters: [
      fakeAdapter('fast', clock, (k) => 150 + ((k * 37) % 200)),
      fakeAdapter('slow', clock, (k) => (k % 5 === 2 ? 2600 : 600 + ((k * 53) % 700)), (k) => k % 6 === 1),
    ],
  });
  const replay = await m.run();
  return { m, replay };
}

describe('match', () => {
  it('plays a full realtime match and the replay reproduces it exactly', async () => {
    const { m, replay } = await playMatch('realtime');
    expect(m.over).toBe(true);
    expect(replay.decisions.length).toBeGreaterThan(50);
    expect(replay.decisions.some((d) => d.fallback === 'timeout')).toBe(true);
    expect(replay.decisions.some((d) => d.fallback === 'invalid')).toBe(true);
    const player = new ReplayPlayer(replay);
    expect(player.diverged).toBeNull();
    expect(player.endTick).toBe(m.state.tick);
    const mid = player.stateAt(1234);
    expect(mid.tick).toBe(1234);
  }, 60_000);

  it('the faster model waits less in realtime mode', async () => {
    const { replay } = await playMatch('realtime', 9);
    const [a, b] = matchStats(replay);
    expect(a.waitTicks / a.decisions).toBeLessThan(b.waitTicks / b.decisions);
    expect(a.calibration.n).toBeGreaterThan(0);
  }, 60_000);

  it('paused mode never lets a fighter act on a fallback for slowness under the deadline', async () => {
    const { replay } = await playMatch('paused');
    const slowFallbacks = replay.decisions.filter((d) => d.fallback === 'timeout');
    // Only the 2600 ms answers time out.
    for (const d of slowFallbacks) expect(d.latencyMs).toBeGreaterThanOrEqual(2000);
    expect(new ReplayPlayer(replay).diverged).toBeNull();
  }, 60_000);

  it('round-trips through gzip', async () => {
    const { replay } = await playMatch('paused', 11);
    const bytes = await encodeReplay(replay);
    expect(bytes.length).toBeLessThan(JSON.stringify(replay).length / 3);
    expect(await decodeReplay(bytes)).toEqual(replay);
  }, 60_000);

  it('detects a tampered replay', async () => {
    const { replay } = await playMatch('paused', 13);
    const d = replay.decisions.find((x) => x.move !== 'backdash')!;
    d.move = 'backdash';
    expect(new ReplayPlayer(replay).diverged).not.toBeNull();
  }, 60_000);
});

describe('ratings', () => {
  it('Bradley-Terry ranks the stronger player higher and keeps undefeated players finite', () => {
    const games = [
      { left: 'a', right: 'b', winner: 0 as const },
      { left: 'b', right: 'a', winner: 1 as const },
      { left: 'a', right: 'c', winner: 0 as const },
      { left: 'b', right: 'c', winner: 0 as const },
    ];
    const r = bradleyTerry(games, ['a', 'b', 'c']);
    expect(r.get('a')!).toBeGreaterThan(r.get('b')!);
    expect(r.get('b')!).toBeGreaterThan(r.get('c')!);
    expect(Number.isFinite(r.get('a')!)).toBe(true);
  });

  it('builds leaderboard rows', async () => {
    const { replay } = await playMatch('paused', 17);
    const lb = leaderboard([{ id: 'x', mode: 'paused', left: 'fast', right: 'slow', winner: replay.result.winner, createdAt: replay.createdAt, stats: matchStats(replay) }]);
    expect(lb.rows).toHaveLength(2);
    expect(lb.rows[0].matches).toBe(1);
    expect(lb.rows[0].ci[0]).toBeLessThanOrEqual(lb.rows[0].rating);
  }, 60_000);
});
