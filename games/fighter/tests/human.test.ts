import { describe, expect, it } from 'vitest';
import type { Adapter, HumanInput } from '../shared/adapter.ts';
import { isActionable, legalMoves, newGame, step, type GameState } from '../shared/engine/engine.ts';
import { Match } from '../shared/match.ts';
import { ReplayPlayer } from '../shared/replay.ts';
import { BUFFER_MS, DOUBLE_TAP_MS, KeyState } from '../src/input.ts';
import { FakeClock, fakeAdapter } from './support/fake.ts';

/** A state where fighter 0 is free to act. */
function freeState(): GameState {
  const s = newGame(3, { passivity: true });
  while (s.round.phase !== 'fight' || !isActionable(s, 0)) step(s, [null, null]);
  return s;
}

function keys(t: { now: number }) {
  const k = new KeyState();
  k.now = () => t.now;
  return k;
}

describe('the keyboard', () => {
  it('uses a press made a moment before the fighter is free, and only once', () => {
    const t = { now: 1000 };
    const k = keys(t);
    const s = freeState();
    k.down('KeyU', false, 1000);
    t.now = 1000 + BUFFER_MS - 10;
    expect(k.next(s, 0, false)?.move).toBe('jab');
    expect(k.next(s, 0, true)).toEqual({ move: 'jab', at: 1000 });
    expect(k.next(s, 0, true)).toBeNull();
  });

  it('forgets a press that is too old', () => {
    const t = { now: 0 };
    const k = keys(t);
    k.down('KeyU', false, 0);
    t.now = BUFFER_MS + 1;
    expect(k.next(freeState(), 0, true)).toBeNull();
  });

  it('turns screen directions into forward and back for each side', () => {
    const t = { now: 0 };
    const k = keys(t);
    const s = freeState();
    k.down('ArrowRight', false, 0);
    expect(k.next(s, 0, true)?.move).toBe('walk_forward');
    expect(k.next(s, 1, true)?.move).toBe(legalMoves(s, 1).includes('walk_back') ? 'walk_back' : 'block_high');
    k.up('ArrowRight');
    expect(k.next(s, 0, true)).toBeNull();
  });

  it('dashes on a double tap, and backdashes on a double tap away', () => {
    const t = { now: 0 };
    const k = keys(t);
    const s = freeState();
    k.down('ArrowRight', false, 0);
    k.up('ArrowRight');
    k.down('ArrowRight', false, DOUBLE_TAP_MS - 50);
    t.now = DOUBLE_TAP_MS - 40;
    expect(k.next(s, 0, true)?.move).toBe('dash_forward');
    k.up('ArrowRight');
    k.down('ArrowLeft', false, 1000);
    k.up('ArrowLeft');
    k.down('ArrowLeft', false, 1100);
    t.now = 1110;
    expect(k.next(s, 0, true)?.move).toBe('backdash');
  });

  it('holds blocks, prefers a fresh attack over a held block, and knows the Shift strings', () => {
    const t = { now: 0 };
    const k = keys(t);
    const s = freeState();
    k.down('ArrowDown', false, 0);
    expect(k.next(s, 0, true)?.move).toBe('block_low');
    k.down('KeyJ', true, 10);
    t.now = 20;
    expect(k.next(s, 0, true)?.move).toBe('low_kick_sweep');
    expect(k.next(s, 0, true)?.move).toBe('block_low');
  });

  it('maps punches to the top row and kicks to the bottom row', () => {
    const t = { now: 0 };
    const k = keys(t);
    const s = freeState();
    const expected: [string, string][] = [['KeyU', 'jab'], ['KeyI', 'straight'], ['KeyJ', 'low_kick'], ['KeyK', 'high_kick'], ['KeyL', 'sweep'], ['KeyH', 'throw']];
    for (const [code, move] of expected) {
      k.down(code, false, t.now);
      const got = k.next(s, 0, true)?.move;
      if (legalMoves(s, 0).includes(move as never)) expect(got).toBe(move);
    }
    expect(k.down('KeyG', false, 0)).toBe(false);
  });

  it('ignores a held key repeat and unknown keys', () => {
    const k = keys({ now: 0 });
    expect(k.down('KeyQ', false, 0)).toBe(false);
    expect(k.down('KeyU', false, 0, true)).toBe(true);
    expect(k.next(freeState(), 0, true)).toBeNull();
  });
});

/** A scripted player: closes in, then jabs whenever free. */
function scriptedHuman(clock: FakeClock): Adapter {
  const input: HumanInput = {
    next(s, i) {
      const gap = s.fighters[1].x - s.fighters[0].x;
      const move = gap > 1000 ? 'walk_forward' : 'jab';
      return legalMoves(s, i).includes(move) ? { move, at: clock.now() } : null;
    },
  };
  return { id: 'human', kind: 'human', warmUp: async () => {}, decide: () => Promise.reject(new Error('never asked')), human: input };
}

describe('a human in a match', () => {
  it('is never asked, acts when free, and the replay reproduces the match', async () => {
    const clock = new FakeClock();
    const bot = fakeAdapter('bot', clock, () => 200);
    let asked = 0;
    const human = scriptedHuman(clock);
    human.decide = () => {
      asked++;
      return Promise.reject(new Error('never asked'));
    };
    const m = new Match({
      seed: 11,
      mode: 'realtime',
      deadlineMs: 2000,
      clock,
      adapters: [human, bot],
      fighters: [
        { model: 'human', label: 'Human', kind: 'human', color: '#000', via: 'human' },
        { model: 'bot', label: 'Bot', kind: 'systemone', color: '#111' },
      ],
    });
    const replay = await m.run();
    expect(asked).toBe(0);
    const mine = replay.decisions.filter((d) => d.fighter === 0);
    expect(mine.length).toBeGreaterThan(20);
    expect(mine.every((d) => !d.fallback && d.answer?.costUsd === 0)).toBe(true);
    expect(mine.some((d) => d.move === 'jab')).toBe(true);
    expect(new ReplayPlayer(replay).diverged).toBeNull();
  }, 60_000);

  it('in paused mode, the fight waits for the player', async () => {
    const clock = new FakeClock();
    let pressed = false;
    const human: Adapter = {
      id: 'human',
      kind: 'human',
      warmUp: async () => {},
      decide: () => Promise.reject(new Error('never asked')),
      human: { next: (s, i) => (pressed && legalMoves(s, i).includes('block_high') ? { move: 'block_high', at: clock.now() } : null) },
    };
    const m = new Match({
      seed: 5,
      mode: 'paused',
      deadlineMs: 10000,
      clock,
      adapters: [human, fakeAdapter('bot', clock, () => 50)],
      fighters: [
        { model: 'human', label: 'Human', kind: 'human', color: '#000', via: 'human' },
        { model: 'bot', label: 'Bot', kind: 'systemone', color: '#111' },
      ],
    });
    const run = m.run();
    const settle = async (n: number) => {
      for (let k = 0; k < n; k++) await clock.sleep(5);
    };
    // Play until the player is free to act in the fight; then nothing moves until they press a key.
    for (let k = 0; k < 5000 && !(m.state.round.phase === 'fight' && isActionable(m.state, 0)); k++) await clock.sleep(5);
    expect(m.state.round.phase).toBe('fight');
    const stuck = m.state.tick;
    await settle(200);
    expect(m.state.tick).toBe(stuck);
    pressed = true;
    await settle(200);
    expect(m.state.tick).toBeGreaterThan(stuck);
    m.stop();
    await run;
  });
});
