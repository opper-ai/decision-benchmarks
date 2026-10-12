import { describe, expect, it } from 'vitest';
import {
  committedFrames,
  gap,
  hashState,
  isActionable,
  legalMoves,
  newGame,
  predictActionable,
  step,
  type GameEvent,
  type GameState,
  type Inputs,
} from '../shared/engine/engine.ts';
import type { MoveId } from '../shared/engine/moves.ts';

/** A game already in the fight phase with the fighters `g` units apart. */
function fight(g = 1000): GameState {
  const s = newGame(1);
  while (s.round.phase !== 'fight') step(s);
  s.fighters[0].x = 5000 - g / 2;
  s.fighters[1].x = 5000 + g / 2;
  return s;
}

/** Start the given moves now, then tick until the fighters are both actionable again (or n ticks). */
function play(s: GameState, inputs: Inputs, n = 200): GameEvent[] {
  const events: GameEvent[] = [...step(s, inputs)];
  for (let t = 0; t < n; t++) {
    if (isActionable(s, 0) && isActionable(s, 1)) break;
    events.push(...step(s));
  }
  return events;
}

const kinds = (es: GameEvent[]) => es.filter((e) => e.kind !== 'start').map((e) => `${e.kind}:${'f' in e ? e.f : ''}:${'move' in e ? e.move : ''}`);

describe('engine', () => {
  it('goes from intro to fight', () => {
    const s = newGame(7);
    expect(isActionable(s, 0)).toBe(false);
    for (let t = 0; t < 90; t++) step(s);
    expect(s.round.phase).toBe('fight');
    expect(isActionable(s, 0)).toBe(true);
    expect(gap(s)).toBeGreaterThanOrEqual(2000);
    expect(gap(s)).toBeLessThanOrEqual(4000);
  });

  it('a jab against an idle (guarding) fighter is blocked', () => {
    const s = fight(800);
    const es = play(s, ['jab', null]);
    expect(kinds(es)).toContain('block:0:jab');
    // Chip: a quarter of 4.
    expect(s.fighters[1].hp).toBe(99);
  });

  it('a low kick beats a standing guard', () => {
    const s = fight(1000);
    const es = play(s, ['low_kick', null]);
    expect(kinds(es)).toContain('hit:0:low_kick');
    expect(s.fighters[1].hp).toBe(94);
  });

  it('block_low stops lows but not overheads', () => {
    const s = fight(1000);
    play(s, [null, 'block_low'], 0);
    const es0 = play(s, ['low_kick', null]);
    expect(kinds(es0)).toContain('block:0:low_kick');
    expect(s.fighters[1].hp).toBe(99);

    const t = fight(1800);
    step(t, [null, 'block_low']);
    const es = play(t, ['jump_kick', null]);
    expect(kinds(es)).toContain('hit:0:jump_kick');
  });

  it('throw beats block (unblockable)', () => {
    const s = fight(550);
    step(s, [null, 'block_high']);
    const es = play(s, ['throw', null]);
    expect(kinds(es)).toContain('hit:0:throw');
    expect(s.fighters[1].hp).toBe(88);
  });

  it('strike beats throw: a throw whiffs against a fighter in startup', () => {
    const s = fight(550);
    const es = play(s, ['throw', 'jab']);
    expect(kinds(es)).toEqual(['hit:1:jab']);
    expect(s.fighters[0].hp).toBe(96);
  });

  it('uppercut beats a jump-in', () => {
    const s = fight(1500);
    step(s, ['jump_kick', null]);
    for (let t = 0; t < 10; t++) step(s);
    const es = play(s, [null, 'uppercut']);
    expect(kinds(es)).toContain('hit:1:uppercut');
    expect(s.fighters[0].hp).toBe(86);
  });

  it('jumping dodges a sweep', () => {
    const s = fight(1000);
    step(s, [null, 'jump']);
    for (let t = 0; t < 5; t++) step(s);
    const es = play(s, ['sweep', null]);
    expect(kinds(es)).toContain('whiff:0:sweep');
  });

  it('out-of-range attacks whiff', () => {
    const s = fight(3000);
    const es = play(s, ['jab', null]);
    expect(kinds(es)).toEqual(['whiff:0:jab']);
  });

  it('a landed jab chains into the straight', () => {
    const s = fight(800);
    step(s, [null, 'block_low']);
    const es = play(s, ['jab_straight', null]);
    expect(kinds(es)).toEqual(['hit:0:jab_straight', 'hit:0:straight']);
    expect(s.fighters[1].hp).toBe(88);
  });

  it('a blocked jab does not chain', () => {
    const s = fight(800);
    const es = play(s, ['jab_straight', null]);
    expect(kinds(es)).toEqual(['block:0:jab_straight']);
  });

  it('sweep knocks down; the fighter is invulnerable while getting up', () => {
    const s = fight(1000);
    step(s, ['sweep', null]);
    let t = 0;
    while (s.fighters[1].phase !== 'knockdown' && t++ < 60) step(s);
    expect(s.fighters[1].phase).toBe('knockdown');
    expect(committedFrames(s.fighters[1])).toBeGreaterThan(20);
  });

  it('special needs meter and absorbs one hit', () => {
    const s = fight(1500);
    expect(legalMoves(s, 0)).not.toContain('special');
    s.fighters[0].meter = 100;
    expect(legalMoves(s, 0)).toContain('special');
    s.fighters[1].x = 5000 + 400;
    s.fighters[0].x = 5000 - 400;
    step(s, ['special', 'jab']);
    const es = play(s, [null, null]);
    expect(kinds(es)).toContain('armor:1:jab');
    expect(kinds(es)).toContain('hit:0:special');
    expect(s.fighters[0].meter).toBeLessThan(100);
  });

  it('hit-stop freezes the fight and the timer', () => {
    const s = fight(1000);
    step(s, ['low_kick', null]);
    let t = 0;
    while (s.hitstop === 0 && t++ < 30) step(s);
    const timer = s.round.timer;
    const x = s.fighters[1].x;
    step(s);
    expect(s.round.timer).toBe(timer);
    expect(s.fighters[1].x).toBe(x);
  });

  it('KO ends the round, two rounds end the match', () => {
    const s = fight(1000);
    s.fighters[1].hp = 5;
    const es = play(s, ['low_kick', null], 400);
    expect(es.some((e) => e.kind === 'ko')).toBe(true);
    expect(s.wins).toEqual([1, 0]);
    while (s.round.phase !== 'fight') step(s);
    s.fighters[1].hp = 5;
    s.fighters[0].x = 4500;
    s.fighters[1].x = 5500;
    const es2 = play(s, ['low_kick', null], 400);
    while ((s.round.phase as string) !== 'over') es2.push(...step(s));
    expect(s.winner).toBe(0);
    expect(es2.some((e) => e.kind === 'match_end')).toBe(true);
  });

  it('timeout gives the round to the healthier fighter', () => {
    const s = fight(3000);
    s.fighters[0].hp = 50;
    s.round.timer = 2;
    step(s);
    step(s);
    expect(s.results[0]).toMatchObject({ winner: 1, reason: 'time' });
  });

  /** Fighter 1 just started getting up, fighter 0 free at `g`. */
  function wakeUp(g: number): GameState {
    const s = fight(g);
    const f = s.fighters[1];
    Object.assign(f, { phase: 'getup', len: 20, frame: 0, move: null, atk: null });
    return s;
  }

  /** Fighter 0 starts `atk` after `delay` ticks; fighter 1 plays `reply` as soon as it can act. */
  function wakeExchange(g: number, delay: number, atk: MoveId, reply: MoveId | null): GameEvent[] {
    const s = wakeUp(g);
    const es: GameEvent[] = [];
    let attacked = false;
    let replied = false;
    for (let t = 0; t < 120; t++) {
      const inputs: Inputs = [null, null];
      if (!attacked && t >= delay && isActionable(s, 0)) {
        inputs[0] = atk;
        attacked = true;
      }
      if (!replied && reply && isActionable(s, 1)) {
        inputs[1] = reply;
        replied = true;
      }
      es.push(...step(s, inputs));
    }
    return es;
  }

  const hits0 = (es: GameEvent[]) => es.some((e) => e.kind === 'hit' && e.f === 0);

  it('there is no unanswerable wake-up attack', () => {
    for (const [atk, reply] of [
      ['sweep', 'block_low'],
      ['low_kick_sweep', 'block_low'],
      ['low_kick', 'block_low'],
      ['throw', 'jump'],
      ['straight', 'block_high'],
    ] as [MoveId, MoveId][]) {
      for (let delay = 0; delay < 30; delay++) {
        const g = atk === 'throw' ? 750 : 1000;
        expect(hits0(wakeExchange(g, delay, atk, reply)), `${atk} after ${delay} vs ${reply}`).toBe(false);
      }
    }
  });

  it('a fighter that does nothing on wake-up can still be hit (the attack is real)', () => {
    let any = false;
    for (let delay = 0; delay < 30; delay++) any ||= hits0(wakeExchange(1000, delay, 'sweep', null));
    expect(any).toBe(true);
  });

  it('cannot be thrown in the first frames after getting up', () => {
    // Without throw protection, a throw timed for the wake-up frame would land on a fighter that idles.
    const landed: number[] = [];
    for (let delay = 0; delay < 30; delay++) if (hits0(wakeExchange(750, delay, 'throw', null))) landed.push(delay);
    // Getup ends after 20 ticks and a throw connects 6 ticks after it starts, so without protection a
    // throw started at tick 14 would land on the first standing frame. With 6 frames of protection the
    // earliest one that lands starts 6 ticks later.
    expect(Math.min(...landed)).toBeGreaterThanOrEqual(20);
  });

  it('the special dashes in', () => {
    const s = fight(2000);
    s.fighters[0].meter = 100;
    const x0 = s.fighters[0].x;
    const es = play(s, ['special', null]);
    expect(s.fighters[0].x).toBeGreaterThan(x0 + 800);
    expect(kinds(es)).toContain('block:0:special');
  });

  it('uppercut knocks down', () => {
    const s = fight(900);
    step(s, [null, 'block_low']);
    step(s, ['uppercut', null]);
    let t = 0;
    while (s.fighters[1].phase !== 'knockdown' && t++ < 30) step(s);
    expect(s.fighters[1].phase).toBe('knockdown');
  });

  it('a combo that lands at its starter\'s max reach is guaranteed', () => {
    const s = fight(1000);
    step(s, [null, 'block_low']);
    const es = play(s, ['jab_straight', null]);
    expect(kinds(es)).toEqual(['hit:0:jab_straight', 'hit:0:straight']);
  });

  it('passivity: waiting costs HP after 8 s, being attacked does not count', () => {
    const s = newGame(1, { passivity: true });
    while (s.round.phase !== 'fight') step(s);
    s.fighters[0].x = 3000;
    s.fighters[1].x = 6000;
    const es: GameEvent[] = [];
    for (let t = 0; t < 60 * 10; t++) es.push(...step(s));
    // Both waited 10 s: 8 s free, then about 2 HP each.
    expect(es.filter((e) => e.kind === 'penalty' && e.f === 0).length).toBeGreaterThanOrEqual(2);
    expect(s.fighters[0].hp).toBeLessThan(100);

    // Stepping in resets the clock.
    step(s, ['walk_forward', null]);
    expect(s.fighters[0].passive).toBe(0);
  });

  it('passivity is off unless the rules turn it on', () => {
    const s = newGame(1);
    while (s.round.phase !== 'fight') step(s);
    for (let t = 0; t < 60 * 10; t++) step(s);
    expect(s.fighters[0].hp).toBe(100);
  });

  it('walking back guards high but not low', () => {
    const s = fight(900);
    step(s, [null, 'walk_back']);
    const es = play(s, ['straight', null]);
    expect(kinds(es)).toContain('block:0:straight');
    const t = fight(800);
    step(t, [null, 'walk_back']);
    const es2 = play(t, ['low_kick', null]);
    expect(kinds(es2)).toContain('hit:0:low_kick');
  });

  it('dash_forward covers 0.8 quickly', () => {
    const s = fight(3000);
    const x0 = s.fighters[0].x;
    step(s, ['dash_forward', null]);
    for (let t = 0; t < 9; t++) step(s);
    expect(s.fighters[0].x - x0).toBe(800);
  });

  it('is deterministic', () => {
    const run = () => {
      const s = newGame(42);
      const moves: MoveId[] = ['walk_forward', 'jab', 'low_kick', 'block_low', 'throw', 'sweep', 'jump_kick', 'uppercut'];
      let k = 0;
      for (let t = 0; t < 3000; t++) {
        const inputs: Inputs = [null, null];
        if (isActionable(s, 0)) inputs[0] = moves[k++ % moves.length];
        if (isActionable(s, 1)) inputs[1] = moves[(k * 3) % moves.length];
        step(s, inputs);
      }
      return hashState(s);
    };
    expect(run()).toBe(run());
  });

  it('predicts when a fighter will next be actionable', () => {
    const s = fight(3000);
    step(s, ['high_kick', null]);
    for (let t = 0; t < 15; t++) step(s);
    const p = predictActionable(s, 0)!;
    let real = 0;
    while (!isActionable(s, 0)) {
      step(s);
      real++;
    }
    expect(p.ticks).toBe(real);
    expect(p.state.fighters[0].x).toBe(s.fighters[0].x);
  });
});
