import { ReplayPlayer, type Replay } from '../../shared/replay.ts';
import { Stage } from '../stage.ts';

/** One frame of a match, the stage alone filling the window and standing still: for the poster and for embeds. */
export function stillView(host: HTMLElement, r: Replay, tick: number): () => void {
  const player = new ReplayPlayer(r);
  const wrap = document.createElement('div');
  wrap.className = 'still';
  host.replaceChildren(wrap);
  const stage = new Stage(wrap, r.fighters);
  // Two ticks in, so the fighters are drawn mid-motion rather than snapped.
  const at = Math.max(0, Math.min(player.endTick, tick));
  stage.jump(player.stateAt(Math.max(0, at - 2)));
  const s = player.stateAt(Math.max(0, at - 1));
  stage.tick(s, player.advance(s));
  stage.paused = true;
  return () => stage.destroy();
}
