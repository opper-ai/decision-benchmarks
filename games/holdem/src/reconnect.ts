// The words for a table that lost its connection, and for one kept in this browser to go back to: the "Reconnecting…"
// banner's countdown, and the lobby's "Resume your game" card (remote-driver.ts keeps the table and retries). Pure, so
// tests check them.
import type { Resumable } from './remote-driver.ts';
import { SETS } from './roster.ts';
import type { LobbyChoice } from './views/lobby.ts';

/** The banner's second line: when the next try is, counted down in whole seconds. */
export function retryLine(msLeft: number): string {
  const s = Math.ceil(msLeft / 1000);
  return s <= 0 ? 'Trying again now' : `Trying again in ${s} s`;
}

/** How long ago a table was kept: "just now", "4 minutes ago", "2 hours ago". */
export function agoText(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hours = Math.floor(min / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

/** The lobby's choice for a kept table: its mode and models, and the opponent set they make, if they make one. */
export function choiceOf(saved: Resumable): LobbyChoice {
  const models = saved.seats.filter((s) => s.kind === 'model').map((s) => s.id);
  const set = SETS.find((s) => s.models.length === models.length && s.models.every((id, i) => id === models[i]));
  return { mode: saved.mode, setId: set?.id ?? 'custom', models };
}

/** The resume card's words: what kind of game, how far it got, and when. */
export function resumeLines(saved: Resumable): { title: string; detail: string } {
  return {
    title: saved.mode === 'play' ? 'Resume your game' : 'Resume watching',
    detail: `${saved.mode === 'play' ? 'You and' : 'Watching'} ${saved.seats.filter((s) => s.kind === 'model').length} models, hand ${saved.hand}, last played ${agoText(saved.ageMs)}.`,
  };
}

/**
 * What "Try again" sits down when a table stopped, or null for no Try again: only when the connection gave up and this
 * browser keeps the game's own table, which it does once the game had started (a new table that never started leaves
 * an older game kept here, not this one) or when the game was itself a resume. Always the kept table's own lineup and
 * mode, whatever the lobby had chosen.
 */
export function retryChoice(o: { gaveUp: boolean; started: boolean; resumed: boolean; saved: Resumable | null }): LobbyChoice | null {
  if (!o.gaveUp || !o.saved || !(o.started || o.resumed)) return null;
  return choiceOf(o.saved);
}
