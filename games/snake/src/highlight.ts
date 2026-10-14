// A recorded game's highlight, as jevman cuts its own: the 18 seconds in which the snake ate the most apples, played at
// Watch's pace, as a video; and the best 10 seconds of those as a GIF. scripts/clips.ts renders them; the page offers
// them to save while that game plays.
import { createGame, step, type GameState, type Move } from '../shared/engine.ts';

/** Watch replays a recording at this pace, and the clips play at it too. */
export const WATCH_STEP_MS = 90;
export const HIGHLIGHT_S = 18;
export const GIF_S = 10;
/** Seconds the clip holds on the end of the game, so one that ends on GAME OVER shows the final score. */
export const TAIL_S = 2;

/** The game as Watch shows it at `fps` frames a second: the state on each frame, then TAIL_S seconds on the end. */
export function framesOf(seed: number, moves: readonly Move[], fps: number): GameState[] {
  const states: GameState[] = [];
  let s = createGame(seed);
  const msPerFrame = 1000 / fps;
  let next = 0;
  for (let f = 0; ; f++) {
    while (next < moves.length && (next + 1) * WATCH_STEP_MS <= f * msPerFrame) s = step(s, moves[next++]!);
    states.push(s);
    if (next >= moves.length) break;
  }
  for (let t = 0; t < TAIL_S * fps; t++) states.push(s);
  return states;
}

/** The first frame of the `n`-frame window from `from` (up to `to`) in which the most apples were eaten. Ties go to the later one. */
export function bestWindow(frames: readonly GameState[], n: number, from = 0, to = frames.length): number {
  let best = -1;
  let start = from;
  for (let s = from; s + n <= to; s++) {
    const gain = frames[s + n - 1]!.apples - frames[s]!.apples;
    if (gain >= best) {
      best = gain;
      start = s;
    }
  }
  return start;
}
