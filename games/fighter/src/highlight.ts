import { TICK_HZ } from '../shared/engine/engine.ts';
import type { ReplayPlayer } from '../shared/replay.ts';

/** A match's highlight, as a video and as a GIF: the most damage dealt in so many seconds. */
export const HIGHLIGHT_S = 18;
export const GIF_S = 10;
/** Seconds drawn after the match's last tick, so a highlight that ends on the knockout shows who won. */
export const TAIL_S = 2;

/** The match at `fps` frames a second, then TAIL_S seconds on its end: for each frame, the damage dealt in it. */
export function damagePerFrame(player: ReplayPlayer, fps: number): number[] {
  const ticksPerFrame = TICK_HZ / fps;
  const frames = Math.ceil(player.endTick / ticksPerFrame) + TAIL_S * fps;
  const dmg = new Array<number>(frames).fill(0);
  for (const e of player.events) if (e.kind === 'hit') dmg[Math.min(frames - 1, Math.floor(e.tick / ticksPerFrame))]! += e.dmg;
  return dmg;
}

/** The window of `n` frames from `from` (up to `to`) with the most damage dealt: its first frame. Ties go to the later one. */
export function bestWindow(dmg: number[], n: number, from = 0, to = dmg.length): number {
  let best = -1;
  let start = from;
  for (let s = from; s + n <= to; s++) {
    let sum = 0;
    for (let k = s; k < s + n; k++) sum += dmg[k]!;
    if (sum >= best) {
      best = sum;
      start = s;
    }
  }
  return start;
}

/** The ticks of a match's highlight: from its first frame's tick, for HIGHLIGHT_S seconds (or the whole match). */
export function highlightTicks(player: ReplayPlayer, fps: number): { from: number; to: number } {
  const dmg = damagePerFrame(player, fps);
  const n = Math.min(HIGHLIGHT_S * fps, dmg.length);
  const ticksPerFrame = TICK_HZ / fps;
  const from = bestWindow(dmg, n) * ticksPerFrame;
  return { from, to: from + n * ticksPerFrame };
}
