// One line of table talk spoken through Opper's text-to-speech (POST /v3/audio/speech): the mp3 as base64, what it
// took and what it cost. The table's speak route (table.ts) decides which line and voice, and who pays; this only asks.
// Opper refusing the key maps as the model calls' refusals do (kit decide.ts refusedUpstream), so the page handles both.
//
// Node-safe, erasable TypeScript only.
import { refusedUpstream, type KeyMode } from '../../../packages/kit/server/decide.ts';
import { withSignal } from '../../../packages/kit/shared/systemone.ts';
import { TTS_MODEL, TTS_SPEED, TTS_VOICES, type Voice } from '../shared/voices.ts';

export const SPEECH_PATH = '/v3/audio/speech';
/** A line is a few seconds of speech, made in about one: past this the page has moved on. */
export const SPEECH_TIMEOUT_MS = 10_000;

export interface SpeechDeps {
  apiKey: string;
  baseUrl: string;
  /** Opper only: the project an organization key calls for (X-Opper-Project). */
  project?: string;
  keyMode?: KeyMode;
  fetch: typeof fetch;
  now: () => number;
  timeoutMs?: number;
  callName?: string;
}

export type SpeechResult =
  | { status: 200; body: { audio: string; format: 'mp3' }; latencyMs: number; costUsd: number | null }
  | { status: number; body: Record<string, unknown>; latencyMs: number; costUsd: null };

/** Speaks `text` in `voice`. */
export async function speak(text: string, voice: Voice, deps: SpeechDeps): Promise<SpeechResult> {
  const redact = (s: string): string => s.split(deps.apiKey).join('[redacted]');
  const started = deps.now();
  const took = () => Math.round(deps.now() - started);
  const timeoutMs = deps.timeoutMs ?? SPEECH_TIMEOUT_MS;
  try {
    const res = await deps.fetch(`${deps.baseUrl.replace(/\/+$/, '')}${SPEECH_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        'Content-Type': 'application/json',
        'X-Opper-Name': deps.callName ?? 'decision-benchmarks',
        ...(deps.project ? { 'X-Opper-Project': deps.project } : {}),
      },
      body: JSON.stringify({ model: TTS_MODEL, input: text, voice: TTS_VOICES[voice], format: 'mp3', speed: TTS_SPEED }),
      signal: withSignal(timeoutMs),
    });
    if (!res.ok) {
      const error = redact(`Speech returned HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      const refused = refusedUpstream(res.status, deps.keyMode, 'Speech');
      return { status: refused?.status ?? 502, body: (refused?.body as Record<string, unknown> | undefined) ?? { error }, latencyMs: took(), costUsd: null };
    }
    const data = (await res.json()) as { audio?: { b64_json?: unknown }; usage?: { cost?: unknown } };
    const audio = data.audio?.b64_json;
    if (typeof audio !== 'string' || !audio) return { status: 502, body: { error: 'Speech answered no audio' }, latencyMs: took(), costUsd: null };
    const header = res.headers.get('x-opper-cost');
    const cost = typeof data.usage?.cost === 'number' ? data.usage.cost : header !== null ? Number(header) : NaN;
    return { status: 200, body: { audio, format: 'mp3' }, latencyMs: took(), costUsd: Number.isFinite(cost) && cost >= 0 ? cost : null };
  } catch (err) {
    const e = err as Error;
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { status: timedOut ? 504 : 502, body: { error: timedOut ? `Speech timed out after ${timeoutMs} ms` : redact(`Speech request failed: ${e?.message ?? String(err)}`) }, latencyMs: took(), costUsd: null };
  }
}
