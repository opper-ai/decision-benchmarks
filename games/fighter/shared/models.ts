import { DECISION_MODELS } from '../../../packages/kit/shared/models.ts';
import { BASELINE_INFO, BASELINES, baselineName } from './baselines.ts';

export type AdapterKind = 'systemone' | 'baseline';

export interface ModelInfo {
  id: string;
  kind: AdapterKind;
  label: string;
  /** Usable context in tokens, when short: questions are trimmed to fit. */
  contextTokens?: number;
  description?: string;
}

/** Decision models with a short context, by Opper id: their questions are trimmed to fit. */
const CONTEXT_TOKENS: Record<string, number> = { 'berget/convaiinnovations/laya': 440 };

/** The decision models Opper serves (the kit's list), then the baselines, which need no model. */
export const MODELS: ModelInfo[] = [
  ...DECISION_MODELS.map((m): ModelInfo => ({ id: m.id, kind: 'systemone', label: m.name, ...(CONTEXT_TOKENS[m.id] ? { contextTokens: CONTEXT_TOKENS[m.id] } : {}) })),
  ...BASELINES.map((id): ModelInfo => ({ id, kind: 'baseline', label: baselineName(id), description: BASELINE_INFO[id] })),
];

/** Who you fight on Play unless you pick someone else. */
export const DEFAULT_OPPONENT = 'sference/clef';

export function modelInfo(id: string): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? { id, kind: 'systemone', label: id.split('/').pop() ?? id };
}
