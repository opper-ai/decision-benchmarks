// Spoken table talk: the voice each chat model speaks its lines in (decision models never talk), through Opper's
// text-to-speech with Fish Audio's S2.1 Pro (TTS_MODEL: about a second and $0.0007 a line). Isomorphic: the server's
// speak route (server/table.ts) and the replay voice script (scripts/voices.ts) read it, and the tests check it.
//
// A voice is picked by its id in Fish Audio's library (Opper lists none for this model). These are all from Fish
// Audio's own account, "Fish Official", and none imitates a known person; much of the rest of the library does.
//
// Each model's voice follows its avatar's character (scripts/avatars.ts CHARACTERS): gender, age and temperament, matched
// to the library's descriptions. No two models share a voice, so any table, preset or not, sounds different.
//
// Node-safe, erasable TypeScript only.

/** Opper's text-to-speech model for table talk: Fish Audio's own route. */
export const TTS_MODEL = 'fish/s2.1-pro';

/** How fast the model speaks: its normal pace is unhurried for a table that keeps moving. */
export const TTS_SPEED = 1.2;

/** The directions a model may give its delivery (shared/delivery.ts), which S2.1 Pro acts on without saying them. */
export const DELIVERY_TAGS = ['pause', 'long pause', 'laughs', 'sighs', 'breathes', 'whispering', 'softly', 'slowly', 'excited', 'dry', 'deadpan', 'teasing', 'nervous'] as const;
/** At most this many directions a line. */
export const MAX_TAGS = 2;

/** The voices in use, with their ids in Fish Audio's library, and how the library describes them. */
export const TTS_VOICES = {
  Sarah: '933563129e564b19a115bedd57b7406a', // young woman, soft and intimate
  James: '08b4100b4c3747fe84ed8b57d26a95ba', // British man, late twenties
  Richard: 'fbc1029c018041d4b17f2c1e57222dff', // British man, storytelling
  Selene: 'b347db033a6549378b48d00acb0d06cd', // woman, meditative
  Harlan: 'acbc93229cde47bfb1353667fb084d3c', // Southern US man, mid-fifties
  Troy: 'bd45448dd6f84f9ebd06f369f93f4410', // Australian man, early forties, a host
  Margaret: '22220edad3e748d386b68377ae0fe0f2', // British woman, early fifties
  Cody: 'f663fef9788d4ac0a6bfe36f1b3c871f', // young man, upbeat
  Eilidh: '4aedc6f5657240e6b3986568f0788f2e', // Scottish woman, early twenties
  George: 'be3a29e6405b413292fe257325ef3f8e', // American man, late seventies
  Alastair: '8d5d5e17e2fa4b6cb587ece7198be0d9', // New Zealand man, mid-fifties, deep
  Ethan: '536d3a5e000945adb7038665781a4aca', // man, calm explainer
  Gordon: '8fc159b6d6e7417d85d49033be1e81a4', // Scottish man, mid-sixties
  Eimear: 'b47bb94bf3ce42b2a7643c31af62c553', // Irish woman, early thirties
  Eoin: '2091911675124249a73d321664ef94a7', // Irish man, late forties
  Dax: '9fa4b7a1b67446b48208f2f5d4bcd8da', // American man, casual
  Aimee: 'a52fdd0e957b4c288d8ec590bdd10288', // Australian woman, late twenties
  Siobhan: '51ff1af4f33c4996bc8b2973877e7df6', // Irish woman, early thirties, bright
  Beulah: '06b231de6de243e499460d9964ea0544', // Southern US woman, early sixties
  Enzo: 'c4b91a220f7543a885b8a23744fa711b', // American teenage boy, animated
  Delia: 'c70cfb98867a4bfb9ae20d2401257b92', // American woman, confident
} as const;
export type Voice = keyof typeof TTS_VOICES;

/** Every chat model's voice, by model id (shared/models.ts). */
export const VOICES: Readonly<Record<string, Voice>> = {
  // Claude
  'aws/claude-haiku-5-5-eu': 'Sarah', // calm young poet, androgynous
  'vertexai/claude-sonnet-5-5-eu': 'James', // dreamy romantic poet
  'aws/claude-opus-5-5': 'Richard', // grand theatrical conductor
  // GPT
  'azure:eu/gpt-6-luna': 'Selene', // calm, enigmatic woman
  'azure/gpt-5.6-terra': 'Harlan', // sturdy, weather-beaten man
  'azure:eu/gpt-6.1-sol': 'Troy', // radiant showman
  // Gemini
  'vertexai/gemini-3.1-pro-preview': 'Margaret', // poised professional card player
  'vertexai/gemini-3.8-flash-eu': 'Cody', // grinning young press photographer
  'vertexai/gemini-3.5-flash-lite-eu': 'Eilidh', // light-hearted young woman
  // Titans
  'anthropic/claude-fable-5-1': 'George', // ancient storyteller
  'azure/gpt-6-astra-global': 'Alastair', // majestic cosmic star-being
  'vertexai/gemini-4-argon-eu': 'Ethan', // serene, cool colossus
  // Open models
  'nebius/deepseek-ai/DeepSeek-V4-Pro-0813': 'Gordon', // seasoned submarine captain
  'sference/kimi-k3': 'Eimear', // calm, steely mountaineer
  'inceptron/zai-org/GLM-5.3': 'Eoin', // dignified grand illusionist
  // At no preset table
  'xai/grok-4.7': 'Dax', // deadpan space-age rebel
  'melious/deepseek-v4.1-flash': 'Aimee', // eager young free diver
  'tensorx/qwen/qwen3.8-flash-next': 'Siobhan', // sprightly young racer
  'alibaba:global/qwen3.8-max': 'Beulah', // grand, imposing matriarch
  'inceptron/zai-org/GLM-5.3-Flash': 'Enzo', // lanky, jittery young street magician
  'nebius/MiniMaxAI/MiniMax-M3': 'Delia', // sharp, quick-eyed woman
};

/** The voice a model speaks in; null: it never talks. */
export function voiceFor(model: string): Voice | null {
  return Object.hasOwn(VOICES, model) ? VOICES[model]! : null;
}
