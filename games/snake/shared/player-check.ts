// A player's game for the high scores (SPEC.md, "High scores"): the seed token the server issued and the player's
// moves. The server replays the moves from that seed for the score; the client never names the seed or the score.
// Isomorphic and Node-safe (the service runs it).
import type { HighScoreCheck, SeedVerifier } from '../../../packages/kit/shared/game.ts';
import { createGame, MAX_STEPS, step, type Move } from './engine.ts';

/** The only board: your apples. */
export const BOARD = 'classic';
/**
 * The fastest the player's board steps (the race's Fast speed, 8 steps a second). The check uses it as the floor for
 * every speed: one board for all speeds, and a slower game only ever takes longer than this.
 */
export const PLAYER_STEP_MS = 125;
/** A game can't come in faster than this share of its steps' time (timers drift, so not all of it). */
const MIN_TIME_SHARE = 0.8;

const LETTER: Record<string, Move> = { L: 'left', S: 'straight', R: 'right' };
export const moveLetter = (m: Move): string => m[0]!.toUpperCase();

export interface PlayerRecording {
  format: 1;
  game: 'snake';
  /** The token GET api/seed issued for this game. */
  seedToken: string;
  /** One letter a step: L, S or R. */
  moves: string;
}

export function checkPlayerGame(raw: unknown, seeds: SeedVerifier): HighScoreCheck {
  const bad = (error: string): HighScoreCheck => ({ ok: false, error });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('not a recording');
  const r = raw as Partial<PlayerRecording>;
  if (r.format !== 1 || r.game !== 'snake' || Object.keys(r).length !== 4) return bad('not a Snake recording');
  if (typeof r.moves !== 'string' || !new RegExp(`^[LSR]{1,${MAX_STEPS}}$`).test(r.moves)) return bad('bad moves');
  const issued = seeds(r.seedToken);
  if (!issued) return bad('not a seed this server issued, or it expired');
  let s = createGame(issued.seed);
  for (const ch of r.moves) {
    if (s.over) return bad('moves after the game ended');
    s = step(s, LETTER[ch]!);
  }
  if (!s.over) return bad('the game is not over');
  if (issued.ageMs < s.steps * PLAYER_STEP_MS * MIN_TIME_SHARE) return bad('played faster than the game runs');
  return { ok: true, score: s.apples, board: BOARD };
}
