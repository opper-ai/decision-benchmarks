/**
 * The decision models Opper serves, one route each: a snapshot of GET https://api.opper.ai/v3/models?type=evaluation
 * (2026-10-12). `id` is the Opper id a run calls and a results row names, as the hub matches it against the catalogue.
 * The bench can read the live list (packages/kit/bench/models.ts) to see what changed; this list is what the server
 * forwards and what official runs play, so a new model lands here by pull request.
 */
export const DECISION_MODELS = [
  { id: 'typesafe/jev-1.13.0', name: 'Jev 1.13', maker: 'TypeSafe' },
  { id: 'sference/clef', name: 'Clef', maker: 'Cloudflare' },
  { id: 'cloudflare:global/clef-flash', name: 'Clef Flash', maker: 'Cloudflare' },
  { id: 'opper/kev-4b', name: 'Kev 4B', maker: 'Jared Palmer' },
  { id: 'berget/convaiinnovations/laya', name: 'Laya', maker: 'ConvAI Innovations' },
  { id: 'openai/gpt-6-luna-decisions', name: 'GPT-6 Luna Decisions', maker: 'OpenAI' },
  { id: 'azure:global/microsoft-decision-1', name: 'Microsoft Decision 1', maker: 'Microsoft' },
  { id: 'empiriolabs/aplomb-1', name: 'Aplomb 1', maker: 'EmpirioLabs' },
  { id: 'greenpt/metis', name: 'Metis', maker: 'GreenPT' },
] as const;

export type ModelId = (typeof DECISION_MODELS)[number]['id'];

export interface DecisionModel {
  id: string;
  name: string;
  maker: string;
}

/** The model a request without one plays, and the only one TypeSafe's own API serves. */
export const DEFAULT_MODEL: ModelId = 'typesafe/jev-1.13.0';

export const isModelId = (v: unknown): v is ModelId => typeof v === 'string' && DECISION_MODELS.some((m) => m.id === v);

/** The display name of a listed model; any other id shows as itself. */
export const modelName = (id: string): string => DECISION_MODELS.find((m) => m.id === id)?.name ?? id;

/** The maker of a listed model, or undefined. */
export const modelMaker = (id: string): string | undefined => DECISION_MODELS.find((m) => m.id === id)?.maker;
