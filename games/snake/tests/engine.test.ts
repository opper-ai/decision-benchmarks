import { describe, expect, it } from 'vitest';
import { createGame, MAX_STEPS, moveToward, mulberry32, replay, SIZE, STARVE_STEPS, step, turn, type GameState, type Move } from '../shared/engine';

/** A state with the snake and apple where a test wants them. */
const at = (body: [number, number][], heading: GameState['heading'], apple: [number, number] | null = [0, 0], extra: Partial<GameState> = {}): GameState => ({
  ...createGame(1),
  body: body.map(([x, y]) => ({ x, y })),
  heading,
  apple: apple && { x: apple[0], y: apple[1] },
  ...extra,
});

describe('a new game', () => {
  it('starts 3 long in the middle heading right, with one apple on a free cell', () => {
    const s = createGame(42);
    expect(s.body).toEqual([{ x: 8, y: 8 }, { x: 7, y: 8 }, { x: 6, y: 8 }]);
    expect(s.heading).toBe('right');
    expect(s.apple).not.toBeNull();
    expect(s.body.some((c) => c.x === s.apple!.x && c.y === s.apple!.y)).toBe(false);
  });

  it('places apples from the seed alone: same seed, same apples; other seeds, other apples', () => {
    expect(createGame(7)).toEqual(createGame(7));
    const firsts = new Set(Array.from({ length: 30 }, (_, i) => JSON.stringify(createGame(i).apple)));
    expect(firsts.size).toBeGreaterThan(20);
  });

  it('uses mulberry32 as documented', () => {
    // The first numbers of mulberry32 with seed 0, as its reference implementation gives them.
    const [a, s1] = mulberry32(0);
    const [b] = mulberry32(s1);
    expect(a).toBeCloseTo(0.26642920868471265, 12);
    expect(b).toBeCloseTo(0.0003297457005828619, 12);
  });
});

describe('moves', () => {
  it('turns relative to the heading, and maps keys to moves (never a U-turn)', () => {
    expect(turn('up', 'left')).toBe('left');
    expect(turn('up', 'right')).toBe('right');
    expect(turn('left', 'left')).toBe('down');
    expect(turn('down', 'straight')).toBe('down');
    expect(moveToward('right', 'up')).toBe('left');
    expect(moveToward('right', 'right')).toBe('straight');
    expect(moveToward('right', 'left')).toBeNull();
  });

  it('is deterministic: the same seed and moves replay to the same game', () => {
    const moves: Move[] = Array.from({ length: 400 }, (_, i) => (['straight', 'left', 'straight', 'right'] as const)[(i * 7) % 4]!);
    expect(replay(99, moves)).toEqual(replay(99, moves));
    let s = createGame(99);
    for (const m of moves) s = step(s, m);
    expect(s).toEqual(replay(99, moves));
  });

  it('grows by one on an apple, and the next apple depends only on the seed and the count eaten', () => {
    const s = step(at([[5, 5], [4, 5], [3, 5]], 'right', [6, 5], { rng: 123 }), 'straight');
    expect(s.apples).toBe(1);
    expect(s.body).toHaveLength(4);
    expect(s.sinceApple).toBe(0);
    // The same PRNG state places the same apple, whatever the moves before.
    const t = step(at([[5, 5], [4, 5], [3, 5]], 'right', [6, 5], { rng: 123, steps: 40 }), 'straight');
    expect(t.apple).toEqual(s.apple);
    expect(t.rng).toBe(s.rng);
  });
});

describe('death', () => {
  it('ends the game at the wall', () => {
    const s = step(at([[SIZE - 1, 3], [SIZE - 2, 3], [SIZE - 3, 3]], 'right'), 'straight');
    expect(s.over).toBe('wall');
    expect(step(at([[4, 0], [4, 1], [4, 2]], 'up'), 'straight').over).toBe('wall');
  });

  it('ends the game on its own body, but not on the cell its tail leaves this step', () => {
    // A 2 x 2 loop: the head at (5,5) heading up, the tail at (6,5)... moving right goes into the tail's cell.
    const loop = at([[5, 5], [5, 6], [6, 6], [6, 5]], 'up', [0, 0]);
    expect(step(loop, 'right').over).toBeNull();
    // Into the body proper (not the tail): a 5-long snake curled round.
    const curl = at([[5, 5], [5, 6], [6, 6], [6, 5], [6, 4]], 'up', [0, 0]);
    expect(step(curl, 'right').over).toBe('body');
  });

  it(`starves after ${STARVE_STEPS} steps without an apple`, () => {
    let s = at([[2, 2], [1, 2], [0, 2]], 'right', null, { sinceApple: STARVE_STEPS - 2 });
    s = step(s, 'straight');
    expect(s.over).toBeNull();
    s = step(s, 'straight');
    expect(s.over).toBe('starved');
  });

  it(`stops at ${MAX_STEPS} steps`, () => {
    const s = step(at([[2, 2], [1, 2], [0, 2]], 'right', null, { steps: MAX_STEPS - 1 }), 'straight');
    expect(s.over).toBe('steps');
  });

  it('changes nothing once the game is over', () => {
    const over = step(at([[SIZE - 1, 3], [SIZE - 2, 3], [SIZE - 3, 3]], 'right'), 'straight');
    expect(step(over, 'left')).toBe(over);
  });
});
