import { legalMoves, type GameState, type Side } from './engine/engine.ts';
import type { MoveId } from './engine/moves.ts';

/**
 * What a fighter does when its model gives no usable answer: keep guarding. Deliberately weak, so the
 * harness never plays well on a model's behalf.
 */
export function fallbackMove(s: GameState, i: Side): MoveId | null {
  const legal = legalMoves(s, i);
  if (!legal.length) return null;
  const f = s.fighters[i];
  if (f.phase === 'block' && f.guard === 'low' && legal.includes('block_low')) return 'block_low';
  return legal.includes('block_high') ? 'block_high' : legal[0];
}
