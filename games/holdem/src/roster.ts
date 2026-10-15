// Who can sit at the table, as the page shows them: the game's models (shared/models.ts, the one list the service and
// the bench use) with their avatar folder (public/avatars/index.json), the seat picker's groups and the badge on a name
// plate, the lobby's words for each opponent set, and which bot stands in for each model while the page runs on local
// bots (LocalDriver).
import type { BotName } from '../shared/bots.ts';
import { HOLDEM_MODELS, SETS as MODEL_SETS, type SetId } from '../shared/models.ts';
import type { Mood } from '../shared/recording.ts';

/**
 * The seat picker's groups: the decision models, the Claude, GPT, Gemini and Titans sets, and the other chat models (the
 * Open models set's among them, with their makers' badges).
 */
export type ModelGroup = 'decision' | 'claude' | 'gpt' | 'gemini' | 'titan' | 'more';
/** decision: a System One model (tell meter, no words). chat: table talk, a mood, reasoning shown after the hand. */
export type ModelStyle = 'decision' | 'chat';

export interface RosterModel {
  id: string;
  name: string;
  /** The folder under public/avatars/ (avatars/index.json). */
  slug: string;
  group: ModelGroup;
  style: ModelStyle;
  /** Who stands in for it while the page runs on local bots (LocalDriver). */
  standIn: BotName;
  /** For a phone's name plate: "Luna", and "GPT-6" under it. */
  short: string;
  tag: string;
  /** The name plate's badge: Decision model, Claude, GPT, Gemini, Titan, or the maker (DeepSeek, Qwen ...). */
  badge: string;
}

/** Avatar folders by model id, as avatars/index.json has them (folders keep the names they were drawn under). */
const AVATARS: Record<string, string> = {
  'typesafe/jev-1.13.0': 'typesafe-jev-1-13-0',
  'sference/clef': 'sference-clef',
  'cloudflare:global/clef-flash': 'cloudflare-global-clef-flash',
  'opper/kev-4b': 'opper-kev-4b',
  'berget/convaiinnovations/laya': 'berget-convaiinnovations-laya',
  'openai/gpt-6-luna-decisions': 'openai-gpt-6-luna-decisions',
  'azure:global/microsoft-decision-1': 'azure-global-microsoft-decision-1',
  'empiriolabs/aplomb-1': 'empiriolabs-aplomb-1',
  'greenpt/metis': 'greenpt-metis',
  'aws/claude-haiku-5-5-eu': 'anthropic-claude-haiku-5-5',
  'vertexai/claude-sonnet-5-5-eu': 'anthropic-claude-sonnet-5-5',
  'aws/claude-opus-5-5': 'anthropic-claude-opus-5-5',
  'anthropic/claude-fable-5-1': 'anthropic-claude-fable-5-1',
  'azure:eu/gpt-6-luna': 'azure-eu-gpt-6-luna',
  'azure/gpt-5.6-terra': 'azure-gpt-5-6-terra',
  'azure:eu/gpt-6.1-sol': 'azure-eu-gpt-6-1-sol',
  'azure/gpt-6-astra-global': 'azure-gpt-6-astra-global',
  // Drawn under the model's name, not its route, so a new route keeps the faces.
  'vertexai/gemini-3.1-pro-preview': 'google-gemini-3-1-pro',
  'vertexai/gemini-3.8-flash-eu': 'google-gemini-3-8-flash',
  'vertexai/gemini-3.5-flash-lite-eu': 'google-gemini-3-5-flash-lite',
  'vertexai/gemini-4-argon-eu': 'google-gemini-4-argon',
  'xai/grok-4.7': 'xai-grok-4-7',
  'melious/deepseek-v4.1-flash': 'deepseek-v4-1-flash',
  'nebius/deepseek-ai/DeepSeek-V4-Pro-0813': 'deepseek-v4-pro',
  'tensorx/qwen/qwen3.8-flash-next': 'qwen3-8-flash-next',
  'alibaba:global/qwen3.8-max': 'qwen3-8-max',
  'sference/kimi-k3': 'moonshot-kimi-k3',
  'inceptron/zai-org/GLM-5.3-Flash': 'zhipu-glm-5-3-flash',
  'inceptron/zai-org/GLM-5.3': 'zhipu-glm-5-3',
  'nebius/MiniMaxAI/MiniMax-M3': 'minimax-m3',
};

/** Practice stand-ins: a mix of styles at every preset table, so each set plays differently. */
const STAND_INS: Record<string, BotName> = {
  'typesafe/jev-1.13.0': 'maniac',
  'sference/clef': 'rock',
  'openai/gpt-6-luna-decisions': 'station',
  'cloudflare:global/clef-flash': 'maniac',
  'opper/kev-4b': 'station',
  'berget/convaiinnovations/laya': 'rock',
  'azure:global/microsoft-decision-1': 'rock',
  'empiriolabs/aplomb-1': 'station',
  'greenpt/metis': 'maniac',
  'aws/claude-haiku-5-5-eu': 'station',
  'vertexai/claude-sonnet-5-5-eu': 'maniac',
  'aws/claude-opus-5-5': 'rock',
  'azure:eu/gpt-6-luna': 'station',
  'azure/gpt-5.6-terra': 'rock',
  'azure:eu/gpt-6.1-sol': 'maniac',
  'anthropic/claude-fable-5-1': 'rock',
  'azure/gpt-6-astra-global': 'maniac',
  'vertexai/gemini-3.1-pro-preview': 'rock',
  'vertexai/gemini-3.8-flash-eu': 'maniac',
  'vertexai/gemini-3.5-flash-lite-eu': 'station',
  'vertexai/gemini-4-argon-eu': 'station',
  'xai/grok-4.7': 'maniac',
  'melious/deepseek-v4.1-flash': 'station',
  'nebius/deepseek-ai/DeepSeek-V4-Pro-0813': 'rock',
  'tensorx/qwen/qwen3.8-flash-next': 'maniac',
  'alibaba:global/qwen3.8-max': 'rock',
  'sference/kimi-k3': 'station',
  'inceptron/zai-org/GLM-5.3-Flash': 'maniac',
  'inceptron/zai-org/GLM-5.3': 'rock',
  'nebius/MiniMaxAI/MiniMax-M3': 'station',
};

/** Names for a phone's name plate: the character's own name, and the family or version beside it. */
const SHORT: Record<string, [string, string]> = {
  'typesafe/jev-1.13.0': ['Jev', 'Jev 1.13'],
  'sference/clef': ['Clef', 'Decision'],
  'openai/gpt-6-luna-decisions': ['Luna', 'GPT-6 Decisions'],
  'cloudflare:global/clef-flash': ['Flash', 'Clef Flash'],
  'opper/kev-4b': ['Kev', 'Kev 4B'],
  'berget/convaiinnovations/laya': ['Laya', 'Decision'],
  'azure:global/microsoft-decision-1': ['Decision 1', 'Microsoft'],
  'empiriolabs/aplomb-1': ['Aplomb', 'Aplomb 1'],
  'greenpt/metis': ['Metis', 'Decision'],
  'aws/claude-haiku-5-5-eu': ['Haiku', 'Claude 5.5'],
  'vertexai/claude-sonnet-5-5-eu': ['Sonnet', 'Claude 5.5'],
  'aws/claude-opus-5-5': ['Opus', 'Claude 5.5'],
  'anthropic/claude-fable-5-1': ['Fable', 'Claude 5.1'],
  'azure:eu/gpt-6-luna': ['Luna', 'GPT-6'],
  'azure/gpt-5.6-terra': ['Terra', 'GPT-5.6'],
  'azure:eu/gpt-6.1-sol': ['Sol', 'GPT-6.1'],
  'azure/gpt-6-astra-global': ['Astra', 'GPT-6'],
  'vertexai/gemini-3.1-pro-preview': ['Pro', 'Gemini 3.1'],
  'vertexai/gemini-3.8-flash-eu': ['Flash', 'Gemini 3.8'],
  'vertexai/gemini-3.5-flash-lite-eu': ['Flash Lite', 'Gemini 3.5'],
  'vertexai/gemini-4-argon-eu': ['Argon', 'Gemini 4'],
  'xai/grok-4.7': ['Grok', 'Grok 4.7'],
  'melious/deepseek-v4.1-flash': ['V4.1 Flash', 'DeepSeek'],
  'nebius/deepseek-ai/DeepSeek-V4-Pro-0813': ['V4 Pro', 'DeepSeek'],
  'tensorx/qwen/qwen3.8-flash-next': ['Flash-Next', 'Qwen3.8'],
  'alibaba:global/qwen3.8-max': ['Max', 'Qwen3.8'],
  'sference/kimi-k3': ['Kimi', 'Kimi K3'],
  'inceptron/zai-org/GLM-5.3-Flash': ['GLM Flash', 'GLM-5.3'],
  'inceptron/zai-org/GLM-5.3': ['GLM', 'GLM-5.3'],
  'nebius/MiniMaxAI/MiniMax-M3': ['MiniMax', 'MiniMax M3'],
};

const slugOf = (id: string): string => AVATARS[id] ?? id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function groupOf(m: (typeof HOLDEM_MODELS)[number]): ModelGroup {
  if (m.kind === 'decision') return 'decision';
  if (m.sets.includes('titans')) return 'titan';
  if (m.sets.includes('claude')) return 'claude';
  if (m.sets.includes('gpt')) return 'gpt';
  if (m.sets.includes('gemini')) return 'gemini';
  return 'more';
}

const BADGES: Record<Exclude<ModelGroup, 'more'>, string> = { decision: 'Decision model', claude: 'Claude', gpt: 'GPT', gemini: 'Gemini', titan: 'Titan' };

export const MODELS: readonly RosterModel[] = HOLDEM_MODELS.map((m) => {
  const group = groupOf(m);
  return {
    id: m.id,
    name: m.name,
    slug: slugOf(m.id),
    group,
    style: m.kind,
    standIn: STAND_INS[m.id] ?? 'station',
    short: SHORT[m.id]?.[0] ?? m.name,
    tag: SHORT[m.id]?.[1] ?? m.name,
    badge: group === 'more' ? m.maker : BADGES[group],
  };
});

/** The seat picker's groups, in order, with their names. */
export const GROUPS: readonly ModelGroup[] = ['decision', 'claude', 'gpt', 'gemini', 'titan', 'more'];
export const GROUP_NAMES: Record<ModelGroup, string> = { decision: 'Decision models', claude: 'Claude', gpt: 'GPT', gemini: 'Gemini', titan: 'Titans', more: 'More chat models' };

export const modelById = (id: string): RosterModel | undefined => MODELS.find((x) => x.id === id);

export interface OpponentSet {
  id: SetId;
  name: string;
  /** One line for the lobby. */
  blurb: string;
  models: readonly string[];
  /** Signed-out players can play this set on the free credits (decision models only). */
  free: boolean;
}

const BLURBS: Record<SetId, { name: string; blurb: string }> = {
  decision: { name: 'Decision', blurb: 'Fast decision models. No words, only tells.' },
  claude: { name: 'Claude', blurb: 'Haiku, Sonnet and Opus talk across the felt.' },
  gpt: { name: 'GPT', blurb: 'Luna, Terra and Sol, the latest of each tier.' },
  gemini: { name: 'Gemini', blurb: 'Pro, Flash and Flash Lite, quick on the draw.' },
  open: { name: 'Open models', blurb: 'DeepSeek, Kimi and GLM, the chattiest at the table.' },
  titans: { name: 'Titans', blurb: 'Fable, Astra and Argon. Big, expensive, very good.' },
};

export const SETS: readonly OpponentSet[] = MODEL_SETS.map((s) => ({ id: s.id, ...BLURBS[s.id], models: s.models, free: s.id === 'decision' }));

export const setById = (id: string): OpponentSet | undefined => SETS.find((s) => s.id === id);

/** The avatar for a model in a mood. */
export const avatarPath = (slug: string, mood: Mood = 'relaxed'): string => `avatars/${slug}/${mood}.webp`;

/** The bots' names as people read them, for a bot seat. */
export const BOT_LABELS: Record<BotName, string> = { rock: 'Rock', station: 'Station', maniac: 'Maniac', random: 'Random' };
