import { describe, expect, it } from 'vitest';
import { bestWindow, framesOf, TAIL_S, WATCH_STEP_MS } from '../src/highlight';
import { createGame, step, type Move } from '../shared/engine';

describe("a recording's highlight", () => {
  it("plays the game at Watch's pace, then holds on its end", () => {
    const moves: Move[] = ['straight', 'straight', 'left', 'left'];
    const frames = framesOf(7, moves, 30);
    // A step every WATCH_STEP_MS: 4 steps take 360 ms, about 11 frames, then TAIL_S seconds on the last board.
    expect(frames.length).toBe(Math.ceil((moves.length * WATCH_STEP_MS) / (1000 / 30)) + 1 + TAIL_S * 30);
    expect(frames[0]).toEqual(createGame(7));
    const last = moves.reduce((s, m) => step(s, m), createGame(7));
    expect(frames.at(-1)).toEqual(last);
  });

  it('picks the window with the most apples eaten, the later one on a tie', () => {
    const at = (apples: number) => ({ ...createGame(1), apples });
    const frames = [0, 0, 1, 2, 2, 2, 3, 3].map(at);
    expect(bestWindow(frames, 3)).toBe(1); // 0 -> 2
    expect(bestWindow(frames, 2)).toBe(5); // +1 at 1, 2 and 5: the latest
    expect(bestWindow(frames, 3, 3)).toBe(5); // from frame 3 on: +1 from 4 and from 5, the later
  });
});
