// Spoken table talk: the voice each chat model speaks its lines in (decision models never talk), through Opper's
// text-to-speech with Mistral's Voxtral (TTS_MODEL, EU, about a second and $0.001 a line). Isomorphic: the server's
// speak route (server/table.ts) and the replay voice script (scripts/voices.ts) read it, and the tests check it.
//
// The casting follows each model's character (scripts/avatars.ts CHARACTERS): gender, age and temperament, against
// each speaker's accent, pitch and pace, measured on one sample line. Voices are distinct at every preset table
// (Claude, GPT, Gemini, Titans, Open models) and in every curated replay; with 21 chat models and 14 English speakers,
// a few speakers sit at two tables that never meet. Three speakers have emotion variants (Paul, Oliver and Jane): they
// go to talkers whose moods carry (Sol, Sonnet, Luna and Kimi K3), and a seat's mood picks the variant where one fits.
//
//   speaker   accent, pitch (median f0 on a sample)   cast as
//   David     GB, deepest (88 Hz), unhurried           Fable 5.1 (ancient storyteller), DeepSeek V4 Pro (sea captain)
//   Rob       US, deep (103 Hz)                        GPT-5.6 Terra (grounded, weather-beaten)
//   Howard    GB, deep (108 Hz), measured              Opus 5.5 (grand conductor), GLM-5.3 (dignified illusionist)
//   James     US, even (119 Hz)                        Gemini 4 Argon (serene colossus), Grok 4.7 (deadpan rebel)
//   Paul*     US, 121 Hz, eight moods                  GPT-6.1 Sol (charismatic showman)
//   Oliver*   GB, 128 Hz, slow, seven moods            Sonnet 5.5 (dreamy romantic poet)
//   Hugo      GB, lively (129 Hz)                      Gemini 3.8 Flash (grinning young photographer)
//   Fred      GB, quick (127 Hz)                       GLM-5.3 Flash (jittery young street magician)
//   Sky       GB, low and calm (186 Hz)                Haiku 5.5 (minimalist poet of few words)
//   Harriet   GB, steady (186 Hz)                      Gemini 3.1 Pro (poised pro), MiniMax M3 (sharp, quick-eyed)
//   Margaret  US, unhurried (229 Hz)                   GPT-6 Astra (cosmic star-being), Qwen3.8 Max (grand matriarch)
//   Sheila    US, quick and bright (222 Hz)            DeepSeek V4.1 Flash (eager young free diver)
//   Mary      GB, high and lively (246 Hz)             Gemini 3.5 Flash Lite (light-hearted), Qwen3.8 Flash-Next (sprightly racer)
//   Jane*     GB, 232 Hz, nine moods                   GPT-6 Luna (enigmatic), Kimi K3 (steely mountaineer)
//
// Node-safe, erasable TypeScript only.
import type { Mood } from './recording.ts';

/** Opper's text-to-speech model for table talk: Mistral's Voxtral TTS 3, EU. */
export const TTS_MODEL = 'mistral/voxtral-mini-tts-3-0';

/**
 * The model's English voices, as GET /v3/audio/voices?model=mistral/voxtral-mini-tts-3-0&language=en listed them on
 * 2026-10-28 (35 of the 66 it lists without a language). Presets named voice_<n> have one delivery; en_paul_*,
 * gb_oliver_* and gb_jane_* are one speaker each in several moods.
 */
export const VOXTRAL_VOICES: readonly string[] = [
  // en_us
  'voice_3150', // James, male
  'voice_478', // Sheila, female
  'voice_447', // Margaret, female
  'voice_485', // Rob, male
  'en_paul_sad',
  'en_paul_neutral', // the model's default voice
  'en_paul_happy',
  'en_paul_frustrated',
  'en_paul_excited',
  'en_paul_confident',
  'en_paul_cheerful',
  'en_paul_angry',
  // en_gb
  'voice_3149', // Hugo, male
  'voice_3147', // Howard, male
  'voice_591', // Fred, male
  'voice_590', // Harriet, female
  'voice_1788', // David, male
  'voice_1787', // Mary, female
  'voice_1786', // Sky, female
  'gb_oliver_neutral',
  'gb_oliver_sad',
  'gb_oliver_excited',
  'gb_oliver_curious',
  'gb_oliver_confident',
  'gb_oliver_cheerful',
  'gb_oliver_angry',
  'gb_jane_sarcasm',
  'gb_jane_confused',
  'gb_jane_shameful',
  'gb_jane_sad',
  'gb_jane_neutral',
  'gb_jane_jealousy',
  'gb_jane_frustrated',
  'gb_jane_curious',
  'gb_jane_confident',
];

/** A model's voice: the plain one, and the variant to speak a mood in where the speaker has one. */
export interface Casting {
  voice: string;
  moods?: Partial<Record<Mood, string>>;
}

const DAVID = 'voice_1788';
const ROB = 'voice_485';
const HOWARD = 'voice_3147';
const JAMES = 'voice_3150';
const HUGO = 'voice_3149';
const FRED = 'voice_591';
const SKY = 'voice_1786';
const HARRIET = 'voice_590';
const MARGARET = 'voice_447';
const SHEILA = 'voice_478';
const MARY = 'voice_1787';
/** Relaxed is the plain voice; nervous has no fitting variant for Paul and Oliver, so it stays plain too. */
const PAUL: Casting = { voice: 'en_paul_neutral', moods: { confident: 'en_paul_confident', annoyed: 'en_paul_frustrated', smug: 'en_paul_happy' } };
const OLIVER: Casting = { voice: 'gb_oliver_neutral', moods: { confident: 'gb_oliver_confident', annoyed: 'gb_oliver_angry', smug: 'gb_oliver_cheerful' } };
const JANE: Casting = { voice: 'gb_jane_neutral', moods: { confident: 'gb_jane_confident', nervous: 'gb_jane_confused', annoyed: 'gb_jane_frustrated', smug: 'gb_jane_sarcasm' } };

/** Every chat model's voice, by model id (shared/models.ts). */
export const VOICES: Readonly<Record<string, Casting>> = {
  // Claude
  'aws/claude-haiku-5-5-eu': { voice: SKY },
  'vertexai/claude-sonnet-5-5-eu': OLIVER,
  'aws/claude-opus-5-5': { voice: HOWARD },
  // GPT
  'azure:eu/gpt-6-luna': JANE,
  'azure/gpt-5.6-terra': { voice: ROB },
  'azure:eu/gpt-6.1-sol': PAUL,
  // Gemini
  'vertexai/gemini-3.1-pro-preview': { voice: HARRIET },
  'vertexai/gemini-3.8-flash-eu': { voice: HUGO },
  'vertexai/gemini-3.5-flash-lite-eu': { voice: MARY },
  // Titans
  'anthropic/claude-fable-5-1': { voice: DAVID },
  'azure/gpt-6-astra-global': { voice: MARGARET },
  'vertexai/gemini-4-argon-eu': { voice: JAMES },
  // Open models
  'nebius/deepseek-ai/DeepSeek-V4-Pro-0813': { voice: DAVID },
  'sference/kimi-k3': JANE,
  'inceptron/zai-org/GLM-5.3': { voice: HOWARD },
  // At no preset table
  'xai/grok-4.7': { voice: JAMES },
  'melious/deepseek-v4.1-flash': { voice: SHEILA },
  'tensorx/qwen/qwen3.8-flash-next': { voice: MARY },
  'alibaba:global/qwen3.8-max': { voice: MARGARET },
  'inceptron/zai-org/GLM-5.3-Flash': { voice: FRED },
  'nebius/MiniMaxAI/MiniMax-M3': { voice: HARRIET },
};

/** The voice a model speaks a line in, in its mood (the plain voice where the speaker has no variant); null: it never talks. */
export function voiceFor(model: string, mood?: Mood): string | null {
  const c = Object.hasOwn(VOICES, model) ? VOICES[model] : undefined;
  if (!c) return null;
  return (mood && c.moods?.[mood]) || c.voice;
}

/** The speaker behind a voice (en_paul_happy and en_paul_neutral are both Paul), to tell neighbours apart. */
export const speakerOf = (voice: string): string => /^(en_paul|gb_oliver|gb_jane)_/.exec(voice)?.[1] ?? voice;
