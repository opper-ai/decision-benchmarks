import { GAME_WORDS } from './game-words.ts';

/**
 * What a Pac-Man decide request may hold: the game's own questions, about a maze state, worded in the game's own
 * words. The service forwards nothing else (game.server.ts), so neither the free credits nor a player's key can be
 * used through it to ask a model anything else. Node-safe: the server runs it as is.
 */

/** Most questions in one request: Pac-Man and the four ghosts never ask more than four at once. */
export const MAX_QUESTIONS = 5;
const QUESTION_NAMES = new Set(['pacman', 'pacman_escape', 'blinky', 'pinky', 'inky', 'clyde']);
const DIRS = new Set(['up', 'down', 'left', 'right']);
const MAZE_ROW = /^[#\-. oFPBKICbkice_|=]{1,40}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Text made only of the game's own words, numbers and punctuation: what the game's questions are written in. */
export function gameText(text: unknown, max: number): boolean {
  // Printable ASCII only (and the dash in the FRUIT criterion): other scripts would slip words past the vocabulary.
  if (typeof text !== 'string' || text.length > max || /[^\x20-\x7E\u2014]/.test(text)) return false;
  for (const w of text.toLowerCase().match(/[a-z][a-z'-]*/g) ?? []) if (!GAME_WORDS.has(w.replace(/^[-']+|[-']+$/g, '')) && !GAME_WORDS.has(w.replace(/'s$/, ''))) return false;
  return true;
}

/** The state's other fields: numbers, flags, game words, or small objects of those (positions, the fruit). */
function stateValue(v: unknown, depth = 0): boolean {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return true;
  if (typeof v === 'string') return gameText(v, 300);
  if (depth >= 3) return false;
  if (Array.isArray(v)) return v.length <= 16 && v.every((x) => stateValue(x, depth + 1));
  return isObj(v) && Object.keys(v).length <= 16 && Object.entries(v).every(([k, x]) => k.length <= 32 && stateValue(x, depth + 1));
}

/**
 * Whether a decide body is what the game sends: at most five questions named for Pac-Man or a ghost, each a choice
 * between directions, worded in the game's own words, about a maze state, with at most one key per question.
 */
export function acceptsRequest(parsed: unknown): boolean {
  if (!isObj(parsed) || Object.keys(parsed).some((k) => !['model', 'state', 'questions', 'keys'].includes(k))) return false;
  const { questions, state, keys } = parsed;
  if (!isObj(questions) || Object.keys(questions).length === 0 || Object.keys(questions).length > MAX_QUESTIONS) return false;
  for (const [name, q] of Object.entries(questions)) {
    if (!QUESTION_NAMES.has(name) || !isObj(q) || q.type !== 'choice' || !gameText(q.instructions, 1500) || !isObj(q.criteria)) return false;
    const criteria = Object.entries(q.criteria);
    if (criteria.length < 2 || criteria.length > 4) return false;
    if (!criteria.every(([dir, text]) => DIRS.has(dir) && typeof text === 'string' && text.startsWith(`Go ${dir}: `) && gameText(text, 700))) return false;
  }
  if (!isObj(state) || !Array.isArray(state.maze) || state.maze.length > 40 || !state.maze.every((row) => typeof row === 'string' && MAZE_ROW.test(row))) return false;
  if (!Object.entries(state).every(([k, v]) => k === 'maze' || (k.length <= 32 && stateValue(v)))) return false;
  if (keys !== undefined && (!isObj(keys) || Object.keys(keys).length > MAX_QUESTIONS || !Object.values(keys).every((k) => typeof k === 'string' && k.length <= 64 && /^[\x21-\x7E]+$/.test(k)))) return false;
  return true;
}
