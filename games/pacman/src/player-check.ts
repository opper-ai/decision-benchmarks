import { questionName } from './brain';
import { createGame, step } from './sim';
import { GHOST_IDS, type Dir, type GhostId } from './types';
import { answerMessage } from '../shared/answers';
import { boardOf, type GhostLineup } from '../shared/lineups';

/** Longest game a check replays: half an hour of steps at the fixed rate. */
export const MAX_PLAYER_STEPS = 60 * 60 * 30;
/** The live game falls back to the backup rule after 2 s; a ghost never waits for an answer much longer. */
const MAX_WAIT_S = 3;
/** Backup-rule moves a game may have (a slow connection makes some; a forged game would want many). */
const MAX_FALLBACK_SHARE = 0.25;
const DIRS = new Set<string>(['up', 'down', 'left', 'right']);

export type PlayerCheck = { ok: true; score: number; board: string | null } | { ok: false; error: string };
/** Verifies a server signature on an answer message (the server passes its own; tests pass a stand-in). */
export type AnswerVerifier = (message: string, sig: string) => boolean;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const frameNo = (v: unknown, steps: number) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < steps;

/**
 * A player's game against AI ghosts, replayed from its recording, with every ghost move checked: a model's answer
 * must carry the server's signature for that junction, ghost, direction and the lineup's model for that ghost (the
 * same question at the same junction can recur, so a signature can too); a backup-rule move is allowed within a share; no ghost may wait longer than the live game lets
 * it. The score is the replay's, never a claimed one. Bundled for the server at build time (vite build --ssr).
 */
export function checkPlayerGame(raw: unknown, verify: AnswerVerifier): PlayerCheck {
  const bad = (error: string): PlayerCheck => ({ ok: false, error });
  if (!isObject(raw) || raw.version !== 1) return bad('not a recording');
  const setup = raw.setup;
  if (!isObject(setup) || setup.pacmanControl !== 'keyboard' || setup.ghostsByAI !== true) return bad('not a game against AI ghosts');
  const lineup = setup.lineup;
  if (!isObject(lineup) || !GHOST_IDS.every((g) => typeof lineup[g] === 'string')) return bad('no lineup');
  const fixedStep = raw.fixedStep;
  const steps = raw.steps;
  if (typeof fixedStep !== 'number' || !(fixedStep > 0 && fixedStep <= 0.05) || !Number.isInteger(steps) || (steps as number) < 1 || (steps as number) > MAX_PLAYER_STEPS) return bad('bad steps');
  const n = steps as number;
  const keys = raw.keys ?? [];
  if (!Array.isArray(keys) || keys.length > n || !keys.every((k) => Array.isArray(k) && k.length === 2 && frameNo(k[0], n) && (k[1] === null || DIRS.has(k[1] as string)))) return bad('bad steering');
  const decisions = raw.decisions;
  // At most a few ghost moves a step: a cap that keeps a crafted recording from making the check slow.
  if (!Array.isArray(decisions) || decisions.length > n * 4) return bad('bad decisions');
  const queued = new Map<string, { dir: Dir; src: string }[]>();
  for (const d of decisions) {
    if (!Array.isArray(d) || d.length !== 4 || !frameNo(d[0], n) || typeof d[1] !== 'string' || d[1].length > 64 || !DIRS.has(d[2] as string) || typeof d[3] !== 'string' || d[3].length > 120) return bad('bad decisions');
    const k = `${d[0]}|${d[1]}`;
    const list = queued.get(k);
    const entry = { dir: d[2] as Dir, src: d[3] };
    if (list) list.push(entry);
    else queued.set(k, [entry]);
  }
  const final = raw.final;
  if (!isObject(final) || !Number.isInteger(final.score)) return bad('bad final state');
  const steering = new Map<number, Dir | null>((keys as [number, Dir | null][]).map(([f, dir]) => [f, dir]));

  const state = createGame({ pacmanControl: 'keyboard', ghostsByAI: true });
  const waited: Record<GhostId, number> = { blinky: 0, pinky: 0, inky: 0, clyde: 0 };
  let moves = 0;
  let fallbacks = 0;
  let problem: string | null = null;
  for (let f = 0; f < n && problem === null; f++) {
    if (steering.has(f)) state.keyDir = steering.get(f)!;
    step(state, fixedStep, {
      decide: (point) => {
        const entry = queued.get(`${f}|${point.key}`)?.shift();
        if (!entry) return null;
        if (point.actor === 'pacman' || !point.options.includes(entry.dir)) {
          problem ??= 'a move the game could not make';
          return null;
        }
        moves += 1;
        if (entry.src === 'f') {
          fallbacks += 1;
          return entry.dir;
        }
        const cut = entry.src.lastIndexOf('~');
        const model = entry.src.slice(0, cut);
        const sig = entry.src.slice(cut + 1);
        if (cut < 1 || model !== lineup[point.actor] || !verify(answerMessage(point.key, questionName(point), entry.dir, model), sig)) {
          problem ??= 'a ghost move no model answered';
          return null;
        }
        return entry.dir;
      },
    });
    // Waiting counts only while the game runs (not through a lost life's or a cleared level's pause).
    for (const g of GHOST_IDS) {
      waited[g] = state.status === 'playing' && state.ghosts[g].waiting ? waited[g] + fixedStep : state.status === 'playing' ? 0 : waited[g];
      if (waited[g] > MAX_WAIT_S) problem ??= 'a ghost waited longer than the game allows';
    }
  }
  if (problem !== null) return bad(problem);
  for (const list of queued.values()) if (list.length) return bad('moves the game never asked for');
  if (moves >= 20 && fallbacks / moves > MAX_FALLBACK_SHARE) return bad('too many backup moves');
  if (state.score !== final.score || state.lives !== final.lives || state.level !== final.level || n !== final.frames) return bad('the game does not replay to its score');
  if (state.status !== 'gameover') return bad('the game is not over');
  return { ok: true, score: state.score, board: boardOf(lineup as GhostLineup) };
}
