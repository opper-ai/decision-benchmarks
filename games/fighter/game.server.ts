// What the service needs from the fighter: its request check. Node-safe, erasable TypeScript only (the service runs it
// as is). No high scores: a player's match is theirs to download, not a board entry.
import type { GameServer } from '../../packages/kit/shared/game.ts';
import { DEFAULT_MODEL, isModelId } from '../../packages/kit/shared/models.ts';
import { checkRequest } from './shared/request.ts';

const server: GameServer = {
  slug: 'fighter',
  /**
   * Only fighter questions go to a model (shared/request.ts rebuilds the request: the game's own instructions, moves as
   * options, the game's state lines, every text capped, at most two questions), and only to a listed decision model.
   */
  decideRequest(body) {
    const checked = checkRequest(body);
    if (!checked.ok) return checked;
    const model = checked.request.model ?? DEFAULT_MODEL;
    if (!isModelId(model)) return { ok: false, error: `Unknown decision model: ${model.slice(0, 80)}` };
    return { ok: true, request: { ...checked.request, model } };
  },
};

export default server;
