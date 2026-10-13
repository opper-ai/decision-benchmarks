// What the service needs from Snake: its request check and its high-score check. Node-safe, erasable TypeScript only
// (the service runs it as is).
import type { GameServer } from '../../packages/kit/shared/game.ts';
import { DEFAULT_MODEL, isModelId } from '../../packages/kit/shared/models.ts';
import { BOARD, checkPlayerGame } from './shared/player-check.ts';
import { parseState, QUESTION, requestFor } from './shared/questions.ts';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const server: GameServer = {
  slug: 'snake',
  /**
   * Only Snake's own question reaches a model: the board is read back from the state and the request rebuilt from it,
   * and the body must be exactly that rebuilt request (no other fields, questions or wording, and the options in the
   * order the step shuffles them to).
   */
  decideRequest(body) {
    const refuse = { ok: false as const, error: 'That is not a question this game asks' };
    if (!isObj(body) || Object.keys(body).some((k) => !['model', 'state', 'questions', 'keys'].includes(k))) return refuse;
    const view = parseState(body.state);
    if (!view) return refuse;
    const rebuilt = requestFor(view);
    if (JSON.stringify(body.state) !== JSON.stringify(rebuilt.state) || JSON.stringify(body.questions) !== JSON.stringify(rebuilt.questions)) return refuse;
    const model = body.model ?? DEFAULT_MODEL;
    if (!isModelId(model)) return { ok: false, error: `Unknown decision model: ${String(model).slice(0, 80)}` };
    let keys: Record<string, string> | undefined;
    if (body.keys !== undefined) {
      const k = body.keys;
      if (!isObj(k) || Object.keys(k).join() !== QUESTION || typeof k[QUESTION] !== 'string' || !/^s\d{1,4}$/.test(k[QUESTION] as string)) return refuse;
      keys = { [QUESTION]: k[QUESTION] as string };
    }
    return { ok: true, request: { model, ...rebuilt }, ...(keys ? { keys } : {}) };
  },
  highScores: {
    boards: [{ id: BOARD, label: 'Your apples' }],
    seeded: true,
    check: (rec, _verify, seeds) => checkPlayerGame(rec, seeds),
  },
};

export default server;
