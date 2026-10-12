import { TICK_MS } from '../../shared/match.ts';
import type { Decision, Replay } from '../../shared/replay.ts';
import type { Bubble } from '../render/renderer.ts';
import { topMoves } from './decisions.ts';

/** Thought bubbles for a replay at `tick`, aged in replay time relative to the clock value `now` (ms). */
export function bubblesAt(bySide: Decision[][], tick: number, now: number): [Bubble | null, Bubble | null] {
  const out: [Bubble | null, Bubble | null] = [null, null];
  for (const i of [0, 1] as const) {
    const ds = bySide[i];
    // Thinking until the answer arrived (its latency), not until it was used.
    const thinking = ds.find((d) => d.askedTick <= tick && tick < Math.min(d.appliedTick, d.askedTick + Math.ceil(d.latencyMs / TICK_MS)));
    if (thinking) {
      out[i] = { thinking: true, since: now - ((tick - thinking.askedTick) / 60) * 1000, top: [] };
      continue;
    }
    let last: Decision | undefined;
    for (const d of ds) if (d.appliedTick <= tick) last = d;
    out[i] =
      last && tick - last.appliedTick < 96
        ? { thinking: false, since: now - ((tick - last.appliedTick) / 60) * 1000, top: topMoves(last), fallback: last.fallback, latencyMs: last.latencyMs }
        : null;
  }
  return out;
}

export const decisionsBySide = (r: Replay): Decision[][] => [0, 1].map((i) => r.decisions.filter((d) => d.fighter === i));
