/**
 * Pac-Man's own model ids: jevman's, from before Opper renamed some routes. The game keeps them so its recordings,
 * demos and high-score boards stay as they are; `opper` is the id Opper serves a model under when it differs (Opper
 * retired opper/clef and opper/clef-flash on 2026-10-08). On the kit, requests carry the Opper id
 * (packages/kit/shared/models.ts) and answers are signed as the game's id (game.server.ts).
 */
export const DECISION_MODELS = [
  { id: 'typesafe/jev-1.13.0', name: 'jev 1.13', maker: 'TypeSafe' },
  { id: 'opper/clef', name: 'Clef', maker: 'Cloudflare', opper: 'sference/clef' },
  { id: 'opper/clef-flash', name: 'Clef Flash', maker: 'Cloudflare', opper: 'cloudflare:global/clef-flash' },
  { id: 'opper/kev-4b', name: 'Kev 4B', maker: 'Jared Palmer' },
  { id: 'berget/convaiinnovations/laya', name: 'Laya', maker: 'ConvAI Innovations' },
  { id: 'openai/gpt-6-luna-decisions', name: 'GPT-6 Luna', maker: 'OpenAI' },
  { id: 'empiriolabs/aplomb-1', name: 'Aplomb 1', maker: 'EmpirioLabs' },
  { id: 'microsoft/decision-1', name: 'Microsoft Decision 1', maker: 'Microsoft', opper: 'azure:global/microsoft-decision-1' },
] as const;

export type ModelId = (typeof DECISION_MODELS)[number]['id'];

export const DEFAULT_MODEL: ModelId = 'typesafe/jev-1.13.0';

export const isModelId = (v: unknown): v is ModelId => DECISION_MODELS.some((m) => m.id === v);

/** The display name of a listed model; any other model shows its id. */
export const modelName = (id: string): string => DECISION_MODELS.find((m) => m.id === id)?.name ?? id;

/** The Opper id a listed model is served under (what the kit's server forwards). */
export const opperIdOf = (id: string): string => {
  const listed = (DECISION_MODELS as readonly { id: string; opper?: string }[]).find((m) => m.id === id);
  return listed?.opper ?? id;
};

/** The game's id for an Opper id (from /api/me, or a results row), or the id itself when the game does not list it. */
export const fromOpperId = (opperId: string): string => {
  const listed = (DECISION_MODELS as readonly { id: string; opper?: string }[]).find((m) => m.opper === opperId || m.id === opperId);
  return listed?.id ?? opperId;
};
