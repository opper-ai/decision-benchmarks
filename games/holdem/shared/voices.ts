// Spoken table talk: the voice each chat model speaks its lines in (decision models never talk), through Opper's
// text-to-speech with xAI's Grok TTS (TTS_MODEL: about a second and $0.0011 a line). Isomorphic: the server's speak
// route (server/table.ts) and the replay voice script (scripts/voices.ts) read it, and the tests check it.
//
// Grok TTS has five voices. Measured on one sample line (median pitch), and as xAI describes them:
//
//   voice  pitch    character                     cast as
//   rex    114 Hz   male, confident, the deepest  GPT-6.1 Sol, Gemini 3.8 Flash, Grok 4.7, GLM-5.3 Flash
//   leo    147 Hz   male, authoritative, steady   Opus 5.5, GPT-5.6 Terra, Fable 5.1, DeepSeek V4 Pro
//   sal    142 Hz   neutral, smooth               Sonnet 5.5, Gemini 4 Argon, GLM-5.3
//   ara    193 Hz   female, warm                  Haiku 5.5, GPT-6 Luna, Gemini 3.1 Pro, Kimi K3, MiniMax M3
//   eve    190 Hz   female, upbeat                Gemini 3.5 Flash Lite, GPT-6 Astra, Qwen3.8 Max, DeepSeek V4.1 Flash,
//                                                 Qwen3.8 Flash-Next
//
// Each model's voice follows its avatar's character (scripts/avatars.ts CHARACTERS): gender, age and temperament.
// Every preset table (three seats) has three different voices, and so do the Titans and Open models replays (the Open
// models replay seats two men and two women: leo, sal, ara, eve). Claude vs GPT seats four men and Grok TTS has three
// male voices, so two of them share one there: Opus 5.5 and GPT-5.6 Terra are both leo (the two older, grander men).
// Haiku 5.5, a calm young poet drawn without a clear gender, speaks as ara so the Claude table keeps three voices.
//
// Node-safe, erasable TypeScript only.

/** Opper's text-to-speech model for table talk: xAI's Grok TTS. */
export const TTS_MODEL = 'xai/tts';

/** The model's voices, as GET /v3/audio/voices?model=xai/tts listed them on 2026-10-28. */
export const TTS_VOICES = ['eve', 'ara', 'leo', 'rex', 'sal'] as const;
export type Voice = (typeof TTS_VOICES)[number];

/** Every chat model's voice, by model id (shared/models.ts). */
export const VOICES: Readonly<Record<string, Voice>> = {
  // Claude
  'aws/claude-haiku-5-5-eu': 'ara',
  'vertexai/claude-sonnet-5-5-eu': 'sal',
  'aws/claude-opus-5-5': 'leo',
  // GPT
  'azure:eu/gpt-6-luna': 'ara',
  'azure/gpt-5.6-terra': 'leo',
  'azure:eu/gpt-6.1-sol': 'rex',
  // Gemini
  'vertexai/gemini-3.1-pro-preview': 'ara',
  'vertexai/gemini-3.8-flash-eu': 'rex',
  'vertexai/gemini-3.5-flash-lite-eu': 'eve',
  // Titans
  'anthropic/claude-fable-5-1': 'leo',
  'azure/gpt-6-astra-global': 'eve',
  'vertexai/gemini-4-argon-eu': 'sal',
  // Open models
  'nebius/deepseek-ai/DeepSeek-V4-Pro-0813': 'leo',
  'sference/kimi-k3': 'ara',
  'inceptron/zai-org/GLM-5.3': 'sal',
  // At no preset table
  'xai/grok-4.7': 'rex',
  'melious/deepseek-v4.1-flash': 'eve',
  'tensorx/qwen/qwen3.8-flash-next': 'eve',
  'alibaba:global/qwen3.8-max': 'eve',
  'inceptron/zai-org/GLM-5.3-Flash': 'rex',
  'nebius/MiniMaxAI/MiniMax-M3': 'ara',
};

/** The voice a model speaks in; null: it never talks. */
export function voiceFor(model: string): Voice | null {
  return Object.hasOwn(VOICES, model) ? VOICES[model]! : null;
}
