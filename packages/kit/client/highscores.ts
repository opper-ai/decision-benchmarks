import { appPath } from './paths.ts';
import type { HighScoreLine, HighScoresView } from '../shared/contract.ts';

/** The players' boards of the game this page belongs to, by board id. */
export type Boards = Record<string, HighScoreLine[]>;

export const BOARD_SIZE = 10;

/** GET <game>/api/highscores: the boards in the game's order, or null (none, not reachable, or not well formed). */
export async function fetchHighScores(): Promise<HighScoresView | null> {
  try {
    const res = await fetch(appPath('/api/highscores'), { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<HighScoresView>;
    if (!Array.isArray(data.order) || !data.boards || typeof data.boards !== 'object') return null;
    return data.order.every((k) => Array.isArray(data.boards![k])) ? { order: data.order, boards: data.boards } : null;
  } catch {
    return null;
  }
}

/** The place a score would take on a board (1 to 10), or null; with no boards yet, the first place. */
export function placeFor(boards: Boards | null, board: string, score: number): number | null {
  // Boards that couldn't be loaded give no place: the server takes no entries then either.
  if (score <= 0 || !boards) return null;
  const list = boards[board] ?? [];
  const place = list.filter((e) => e.score >= score).length + 1;
  return place <= BOARD_SIZE ? place : null;
}

export type EntryResult = { ok: true; place: number | null; score: number; boards: Boards } | { ok: false; error: string };

/** Sends a finished game for a board: the server replays the recording for the score. */
export async function enterScore(board: string, initials: string, recording: unknown): Promise<EntryResult> {
  try {
    const res = await fetch(appPath('/api/highscores'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ board, initials, recording }) });
    const data = (await res.json().catch(() => ({}))) as { place?: number | null; score?: number; boards?: Boards; error?: string };
    if (res.ok && data.boards && typeof data.score === 'number') return { ok: true, place: data.place ?? null, score: data.score, boards: data.boards };
    return { ok: false, error: data.error ?? 'That did not work. Try again.' };
  } catch {
    return { ok: false, error: 'No connection. Try again.' };
  }
}
