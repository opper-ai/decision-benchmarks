import { enterScore as kitEnterScore, fetchHighScores, placeFor, type Boards, type EntryResult } from '../../../packages/kit/client/highscores.ts';
import type { HighScoreLine } from '../../../packages/kit/shared/contract.ts';
import type { Recording } from './replay.ts';
import { BOARD_KEYS, boardLabel } from '../shared/lineups.ts';

/** A line on a player high-score board. */
export type BoardEntry = HighScoreLine;
/** The boards: "mixed", and one per model playing all four ghosts. */
export type { Boards, EntryResult };
export { boardLabel, placeFor };

/** The players' boards (the kit's /api/highscores), or null unless every lineup's board is there. */
export async function fetchBoards(): Promise<Boards | null> {
  const view = await fetchHighScores();
  return view && BOARD_KEYS.every((k) => Array.isArray(view.boards[k])) ? view.boards : null;
}

/** Sends a finished game for a board: the server replays the recording for the score. */
export const enterScore = (board: string, initials: string, recording: Recording): Promise<EntryResult> => kitEnterScore(board, initials, recording);
