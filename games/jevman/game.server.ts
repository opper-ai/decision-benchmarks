// What the service needs from Pac-Man: its request check and its high-score check. Node-safe, erasable TypeScript
// only (the service runs it as is). Served at <APP_BASE_PATH>/jevman/.
import type { GameServer } from '../../packages/kit/shared/game.ts';
import type { SystemOneRequest } from '../../packages/kit/shared/systemone.ts';
import { checkPlayerGame } from './src/player-check.ts';
import { BOARD_KEYS, boardLabel } from './shared/lineups.ts';
import { DECISION_MODELS, DEFAULT_MODEL, isModelId, opperIdOf } from './shared/models.ts';
import { acceptsRequest } from './shared/questions.ts';

const server: GameServer = {
  slug: 'jevman',
  /**
   * Only the game's own questions (shared/questions.ts) go to a model. The page names models by the game's ids
   * (jevman's); the request carries the Opper id, and the answers are signed as the game's id, which the high-score
   * check compares with the lineup.
   */
  decideRequest(body) {
    if (!acceptsRequest(body)) return { ok: false, error: 'That is not a question this game asks' };
    const b = body as SystemOneRequest;
    const model = b.model ?? DEFAULT_MODEL;
    if (!isModelId(model)) return { ok: false, error: `Unknown decision model: ${String(model).slice(0, 80)}` };
    return { ok: true, request: { model: opperIdOf(model), state: b.state, questions: b.questions }, ...(b.keys ? { keys: b.keys } : {}), as: model };
  },
  /** The Opper ids of its lineup: /api/warm warms nothing else. */
  models: DECISION_MODELS.map((m) => opperIdOf(m.id)),
  highScores: {
    boards: BOARD_KEYS.map((id) => ({ id, label: boardLabel(id) })),
    check(rec, verify) {
      const r = checkPlayerGame(rec, verify);
      if (!r.ok) return r;
      // A custom mix of models has no board.
      return r.board === null ? { ok: false, error: 'a custom lineup has no board' } : { ok: true, score: r.score, board: r.board };
    },
  },
};

export default server;
