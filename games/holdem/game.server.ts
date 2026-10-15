// What the service needs from AI Hold'em: its table (server/table.ts), where the server deals and asks the models, so
// the deck and the AIs' hole cards never reach the browser. /api/decide forwards nothing for this game: a model's
// question holds its hole cards, so only the server may build it. /api/warm wakes the decision models (System One).
// Node-safe, erasable TypeScript only (the service runs it as is).
import type { GameServer } from '../../packages/kit/shared/game.ts';
import { HOLDEM_MODELS } from './shared/models.ts';
import { tableApi } from './server/table.ts';

const server: GameServer = {
  slug: 'holdem',
  decideRequest: () => ({ ok: false, error: "AI Hold'em's models play at its table (api/table/*), where the server deals" }),
  // The decision models, for /api/warm: a chat model needs no warming, and System One can't reach it anyway.
  models: HOLDEM_MODELS.filter((m) => m.kind === 'decision').map((m) => m.id),
  api: tableApi(),
};

export default server;
