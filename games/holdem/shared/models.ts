// The models AI Hold'em seats (the plan's "Opponent sets"): every decision model the kit lists, the chat models of the
// Claude, GPT, Gemini, Open models and Titans sets, and more chat models any seat can pick. A chat model is called through Opper's
// OpenAI-compatible chat completions with the game's JSON schema (questions.ts); a decision model through System One.
// Ids are Opper routes, chosen for EU residency where Opper has one (checked against GET /v3/models and real table
// decisions with the strict schema, 2026-10-14):
//
// - Haiku 5.5 aws/claude-haiku-5-5-eu (Ireland), Sonnet 5.5 vertexai/claude-sonnet-5-5-eu, Opus 5.5
//   aws/claude-opus-5-5 (Sweden), GPT-6 Luna azure:eu/gpt-6-luna, GPT-5.6 Terra azure/gpt-5.6-terra (EU),
//   GPT-6.1 Sol azure:eu/gpt-6.1-sol, Gemini 3.8 Flash vertexai/gemini-3.8-flash-eu, Gemini 3.5 Flash Lite
//   vertexai/gemini-3.5-flash-lite-eu, Gemini 4 Argon vertexai/gemini-4-argon-eu, DeepSeek V4.1 Flash melious/
//   (Finland), DeepSeek V4 Pro and MiniMax M3 nebius/, Qwen3.8 Flash-Next tensorx/, Kimi K3 sference/ (EEA), GLM-5.3
//   and GLM-5.3 Flash inceptron/: EU routes.
// - Fable 5.1 (anthropic/, US), GPT-6 Astra (azure/...-global), Gemini 3.1 Pro (vertexai/, global; the latest Pro,
//   still a preview), Grok 4.7 (xai/, US) and Qwen3.8 Max (alibaba:global/) have no EU route.
// - Reasoning effort is low, except where a route needs otherwise:
//   - Gemini 4 Argon's Vertex route refuses low (400 "Thinking budget is not supported": Opper sends it as a budget,
//     the model takes a level), and MiniMax M3's Nebius route does not think: neither is sent an effort. The Gemini
//     set takes low (3.8 Flash refuses minimal); Gemini 3.1 Pro at its default thought for 24 s on a river, at low 4–7 s.
//   - The DeepSeeks at low (and minimal) thought to the 4000-token cap on the turn and river, 20–30 s; Qwen3.8 Max at
//     low took 12–30 s. With none they answer in 1–6 s, every answer valid; Flash-Next is given none too.
//   - Grok 4.7 has nothing under minimal, and minimal is no faster: 4–9 s before the flop, 17–28 s on the turn and
//     river, so its late-street decisions often run out the 20 s and fall back.
// - Qwen3.8 Flash is not here: its routes (novita/, deepinfra/) always think and ignore the effort, 16 s to over 60 s a
//   decision. Qwen3.8 Flash-Next takes its place. fal/minimax-h3 is a video model, so MiniMax plays as MiniMax M3.
// - The Decision set is Jev 1.14, Clef and GPT-6 Luna Decisions (2026-10-16): strong decision models on JevMan's
//   leaderboard, one Jev only, each answering the table's question in 0.2 to 1.4 s. Eevo 1 is stronger but costs about
//   45 times as much a decision as Jev (about $0.002 against $0.00004), and the free credits pay for the set, so it sits
//   in the seat picker only.
//
// avatars/index.json is keyed by these ids. Isomorphic.
import type { ChatModel } from '../../../packages/kit/shared/chat.ts';
import { DECISION_MODELS } from '../../../packages/kit/shared/models.ts';

export type ModelKind = 'decision' | 'chat';
export type SetId = 'decision' | 'claude' | 'gpt' | 'gemini' | 'open' | 'titans';

/**
 * How long a decision may take before the fallback plays it: the kit's 2.5 s for decision models, a 20 s time bank for
 * chat models. At the table the server asks the model within one request, and CloudFront gives up on a request to the
 * service after about 30 s, so a chat model's time stays well under that; the bench gives it the same.
 */
export const DECISION_TIMEOUT_MS = 2500;
export const CHAT_TIMEOUT_MS = 20_000;

export interface HoldemModel {
  id: string;
  name: string;
  maker: string;
  kind: ModelKind;
  /** The preset tables it sits at. */
  sets: readonly SetId[];
  /** How long one of its decisions may take. */
  timeoutMs: number;
  /** Chat models: reasoning_effort, capped low to keep the table moving (none, or not sent, where a route needs it). */
  reasoningEffort?: 'none' | 'low' | 'medium';
  /** Chat models: room for the reply, reasoning included. */
  maxTokens?: number;
}

/** The Decision set, strongest first: the lobby seats them in this order. */
const DECISION_SET: readonly string[] = ['typesafe/jev-1.14.0', 'sference/clef', 'openai/gpt-6-luna-decisions'];

/** A chat model: low reasoning effort unless `effort` says otherwise (null: none is sent, the route's default). */
const chat = (id: string, name: string, maker: string, sets: SetId[], effort: 'none' | 'low' | null = 'low'): HoldemModel => ({
  id,
  name,
  maker,
  kind: 'chat',
  sets,
  timeoutMs: CHAT_TIMEOUT_MS,
  ...(effort ? { reasoningEffort: effort } : {}),
  maxTokens: 4000,
});

export const HOLDEM_MODELS: readonly HoldemModel[] = [
  ...DECISION_MODELS.map((m): HoldemModel => ({ id: m.id, name: m.name, maker: m.maker, kind: 'decision', sets: DECISION_SET.includes(m.id) ? ['decision'] : [], timeoutMs: DECISION_TIMEOUT_MS })),
  chat('aws/claude-haiku-5-5-eu', 'Haiku 5.5', 'Anthropic', ['claude']),
  chat('vertexai/claude-sonnet-5-5-eu', 'Sonnet 5.5', 'Anthropic', ['claude']),
  chat('aws/claude-opus-5-5', 'Opus 5.5', 'Anthropic', ['claude']),
  chat('azure:eu/gpt-6-luna', 'GPT-6 Luna', 'OpenAI', ['gpt']),
  chat('azure/gpt-5.6-terra', 'GPT-5.6 Terra', 'OpenAI', ['gpt']),
  chat('azure:eu/gpt-6.1-sol', 'GPT-6.1 Sol', 'OpenAI', ['gpt']),
  chat('vertexai/gemini-3.1-pro-preview', 'Gemini 3.1 Pro', 'Google', ['gemini']),
  chat('vertexai/gemini-3.8-flash-eu', 'Gemini 3.8 Flash', 'Google', ['gemini']),
  chat('vertexai/gemini-3.5-flash-lite-eu', 'Gemini 3.5 Flash Lite', 'Google', ['gemini']),
  chat('anthropic/claude-fable-5-1', 'Fable 5.1', 'Anthropic', ['titans']),
  chat('azure/gpt-6-astra-global', 'GPT-6 Astra', 'OpenAI', ['titans']),
  chat('vertexai/gemini-4-argon-eu', 'Gemini 4 Argon', 'Google', ['titans'], null),
  // The open-weights models: DeepSeek V4 Pro, Kimi K3 and GLM-5.3 make the Open models set; the rest sit at no preset
  // table. Any seat can pick any of them.
  chat('xai/grok-4.7', 'Grok 4.7', 'xAI', []),
  chat('melious/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 'DeepSeek', [], 'none'),
  chat('nebius/deepseek-ai/DeepSeek-V4-Pro-0813', 'DeepSeek V4 Pro', 'DeepSeek', ['open'], 'none'),
  chat('tensorx/qwen/qwen3.8-flash-next', 'Qwen3.8 Flash-Next', 'Qwen', [], 'none'),
  chat('alibaba:global/qwen3.8-max', 'Qwen3.8 Max', 'Qwen', [], 'none'),
  chat('sference/kimi-k3', 'Kimi K3', 'Moonshot', ['open']),
  chat('inceptron/zai-org/GLM-5.3-Flash', 'GLM-5.3 Flash', 'Zhipu', []),
  chat('inceptron/zai-org/GLM-5.3', 'GLM-5.3', 'Zhipu', ['open']),
  chat('nebius/MiniMaxAI/MiniMax-M3', 'MiniMax M3', 'MiniMax', [], null),
];

/** The preset tables: you and the set's models (three each, so a preset table is four-handed). */
export const SETS: readonly { id: SetId; name: string; models: readonly string[] }[] = (['decision', 'open', 'titans', 'gemini', 'claude', 'gpt'] as const).map((id) => ({
  id,
  name: { decision: 'Decision models', claude: 'Claude', gpt: 'GPT', gemini: 'Gemini', open: 'Open models', titans: 'Titans' }[id],
  models: id === 'decision' ? DECISION_SET : HOLDEM_MODELS.filter((m) => m.sets.includes(id)).map((m) => m.id),
}));

export const holdemModel = (id: string): HoldemModel | undefined => HOLDEM_MODELS.find((m) => m.id === id);

/** The chat models, as the kit's bench plays them (GameDefinition.chatModels). */
export const CHAT_MODELS: readonly ChatModel[] = HOLDEM_MODELS.filter((m) => m.kind === 'chat').map((m) => ({ id: m.id, name: m.name, ...(m.reasoningEffort ? { reasoningEffort: m.reasoningEffort } : {}), ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}) }));
