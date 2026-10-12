import { BASELINES, BASELINE_INFO } from './baselines.ts';

export type AdapterKind = 'systemone' | 'chat' | 'baseline';

export interface ModelInfo {
  id: string;
  kind: AdapterKind;
  label: string;
  /** Usable context in tokens, when short: questions are trimmed to fit. */
  contextTokens?: number;
  description?: string;
  /** Extra fields for the chat request (e.g. reasoning effort). */
  params?: Record<string, unknown>;
}

/** Models offered in the picker. Any other Opper chat model id can be used from the CLI. */
export const MODELS: ModelInfo[] = [
  { id: 'typesafe/jev-1.13.0', kind: 'systemone', label: 'Jev 1.13' },
  { id: 'opper/kev-4b', kind: 'systemone', label: 'Kev 4B' },
  { id: 'sference/clef', kind: 'systemone', label: 'Clef' },
  { id: 'cloudflare:global/clef-flash', kind: 'systemone', label: 'Clef Flash' },
  // OpenAI's Decisions API, reached through Opper's System One endpoint: a full distribution, no output tokens.
  { id: 'openai/gpt-6-luna-decisions', kind: 'systemone', label: 'GPT-6 Luna Decisions' },
  { id: 'azure:eu/microsoft-decision-1', kind: 'systemone', label: 'Microsoft Decision 1' },
  { id: 'berget/convaiinnovations/laya', kind: 'systemone', label: 'Laya', contextTokens: 440 },
  { id: 'gemini/gemini-3.5-flash-lite', kind: 'chat', label: 'Gemini 3.5 Flash Lite' },
  { id: 'gemini/gemini-3.5-flash', kind: 'chat', label: 'Gemini 3.5 Flash' },
  // Gemini 3.8's thinking only switches off with 'low' through Opper ('none' and 'minimal' still reason).
  { id: 'gemini/gemini-3.8-flash', kind: 'chat', label: 'Gemini 3.8 Flash', params: { reasoning_effort: 'low' } },
  { id: 'openai/gpt-6-luna', kind: 'chat', label: 'GPT-6 Luna', params: { reasoning_effort: 'none' } },
  { id: 'openai/gpt-5.4-mini', kind: 'chat', label: 'GPT-5.4 mini' },
  { id: 'anthropic/claude-haiku-4-5', kind: 'chat', label: 'Claude Haiku 4.5' },
  ...BASELINES.map((id) => ({ id, kind: 'baseline' as const, label: `Baseline: ${id.split('/')[1]}`, description: BASELINE_INFO[id] })),
];

/**
 * The official roster: every listed model plus reference baselines. Random asks "is it deciding at
 * all"; greedy and maximin (the strongest) ask "does it beat a fixed rule on the assisted table".
 */
export const OFFICIAL_ROSTER: string[] = [...MODELS.filter((m) => m.kind !== 'baseline').map((m) => m.id), 'baseline/maximin', 'baseline/greedy', 'baseline/random'];

export const DEFAULT_LEFT = 'typesafe/jev-1.13.0';
export const DEFAULT_RIGHT = 'sference/clef';

export function modelInfo(id: string): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? { id, kind: 'chat', label: id.split('/').pop() ?? id };
}
