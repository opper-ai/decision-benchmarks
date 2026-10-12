// A fighter question as the System One API gets it, and the check the service runs on every request before a model
// sees it (game.server.ts). Node-safe: the service runs this as is.
import type { ChoiceQuestion, SystemOneRequest } from '../../../packages/kit/shared/systemone.ts';
import { isMoveId, MOVE_IDS, type MoveId } from './engine/moves.ts';
import { instructionsFor, rawFacts, TRACKS, type Question } from './question.ts';

/** The name of the one question a decision asks. */
export const QUESTION_NAME = 'move';
/** What a question's state may say, in the order the game writes it. */
export const STATE_KEYS = ['you', 'opponent', 'distance', 'time', 'recent', 'their usual attack'] as const;
/** At most this many questions a call (the page asks one; two fighters played by one model could ask two). */
export const MAX_QUESTIONS_PER_CALL = 2;
/** Longest state line and option text the game writes, with room to spare. */
export const MAX_STATE_CHARS = 240;
export const MAX_FACTS_CHARS = 160;

/** The System One request for a question (without a model, the server's default plays). */
export function toSystemOne(q: Question, model?: string): SystemOneRequest {
  const question: ChoiceQuestion = { type: 'choice', instructions: q.instructions, criteria: Object.fromEntries(q.options.map((o) => [o.id, o.facts])) };
  return {
    ...(model ? { model } : {}),
    state: Object.fromEntries(Object.entries(q.context).filter(([, v]) => v)),
    questions: { [QUESTION_NAME]: question },
  };
}

/** Every instruction text the game writes: per track, full or compact, with or without the passivity rule. */
const INSTRUCTIONS = new Map<string, 'assisted' | 'raw'>(TRACKS.flatMap((t) => [false, true].flatMap((compact) => [false, true].map((pass): [string, 'assisted' | 'raw'] => [instructionsFor(t, compact, pass), t]))));

const NUM = '[+-]?\\d+(?:\\.\\d+)?';
/**
 * An assisted option as shared/question.ts writes it: "avg +2.5, worst -12 (if uppercut), usual 0; adv -3f", and for
 * a movement ", ends 1.4; then sweep avg +3.1".
 */
const ASSISTED_FACTS = new RegExp(`^avg ${NUM}, worst ${NUM}(?: \\(if [a-z_]+\\))?(?:, usual ${NUM})?; adv ${NUM}f(?:, ends \\d+\\.\\d(?:; then [a-z_]+ avg ${NUM})?)?$`);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const refuse = (error: string) => ({ ok: false as const, error });

/**
 * Rebuilds a request from what the page sent, or refuses it: only fighter questions go to a model. Instructions must
 * be one of the game's own texts, options must be moves (each once) described as the game describes them, the state
 * may only hold the game's own lines, and every text is capped. The model is left to the caller.
 */
export function checkRequest(body: unknown): { ok: true; request: SystemOneRequest } | { ok: false; error: string } {
  if (!isObj(body)) return refuse('Expected a JSON object');
  for (const k of Object.keys(body)) if (!['model', 'state', 'questions', 'keys'].includes(k)) return refuse(`Unexpected field ${k.slice(0, 40)}`);
  if (body.model !== undefined && typeof body.model !== 'string') return refuse('model must be text');
  if (!isObj(body.state)) return refuse('state must be an object');
  const state: Record<string, string> = {};
  for (const [k, v] of Object.entries(body.state)) {
    if (!(STATE_KEYS as readonly string[]).includes(k)) return refuse(`That is not a fighter's state (${k.slice(0, 40)})`);
    if (typeof v !== 'string' || v.length > MAX_STATE_CHARS) return refuse(`state.${k} must be text of at most ${MAX_STATE_CHARS} characters`);
    state[k] = v;
  }
  if (!isObj(body.questions)) return refuse('questions must be an object');
  const names = Object.keys(body.questions);
  if (names.length < 1 || names.length > MAX_QUESTIONS_PER_CALL) return refuse(`One or ${MAX_QUESTIONS_PER_CALL} questions a call`);
  const questions: Record<string, ChoiceQuestion> = {};
  for (const name of names) {
    if (!/^[a-z][a-z0-9_]{0,15}$/.test(name)) return refuse('Question names are short lowercase words');
    const q = body.questions[name];
    if (!isObj(q) || Object.keys(q).some((k) => !['type', 'instructions', 'criteria'].includes(k))) return refuse('That is not a question this game asks');
    if (q.type !== 'choice') return refuse('Fighter questions are choices');
    const track = typeof q.instructions === 'string' ? INSTRUCTIONS.get(q.instructions) : undefined;
    if (!track) return refuse('Those are not the instructions this game writes');
    if (!isObj(q.criteria)) return refuse('criteria must be an object');
    const options = Object.entries(q.criteria);
    if (options.length < 1 || options.length > MOVE_IDS.length) return refuse('A question offers between one move and every move');
    const criteria: Record<string, string> = {};
    for (const [id, facts] of options) {
      if (!isMoveId(id)) return refuse(`${id.slice(0, 40)} is not a move`);
      if (typeof facts !== 'string' || facts.length > MAX_FACTS_CHARS) return refuse(`The option ${id} must be text of at most ${MAX_FACTS_CHARS} characters`);
      if (track === 'raw' ? facts !== rawFacts(id as MoveId) : !ASSISTED_FACTS.test(facts)) return refuse(`The option ${id} is not described as this game describes it`);
      criteria[id] = facts;
    }
    questions[name] = { type: 'choice', instructions: q.instructions as string, criteria };
  }
  return { ok: true, request: { ...(typeof body.model === 'string' ? { model: body.model } : {}), state, questions } };
}
