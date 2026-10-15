import { refusedUpstream, type DecideResult, type KeyMode } from './decide.ts';
import { chatReplyAnswer, chatRequestBody, type ChatCompletion, type ChatFormat } from '../shared/chat.ts';
import { withSignal, type SystemOneRequest } from '../shared/systemone.ts';

/**
 * A chat model asked from the server, for a game whose server asks the models itself (AI Hold'em's table): Opper's
 * OpenAI-compatible chat completions with the game's own format (its messages and strict JSON schema), as the bench's
 * chatTransport asks it. The answer is shaped as /api/decide's (answers by question, usage, latency, cost), and Opper
 * refusing the key maps as it does there, so a game handles both kinds of model alike.
 */

/** Opper's OpenAI-compatible chat completions. */
export const CHAT_PATH = '/v3/compat/chat/completions';

export interface ChatDeps {
  apiKey: string;
  baseUrl: string;
  /** Opper only: the project an organization key calls for (X-Opper-Project). */
  project?: string;
  keyMode?: KeyMode;
  fetch: typeof fetch;
  now: () => number;
  /** The model's time to answer; past it the call is cancelled (504). */
  timeoutMs: number;
  /** The caller gave up (the player left): the call is cancelled. */
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Sent as X-Opper-Name, so traces show which game called. */
  callName?: string;
  format: ChatFormat;
  reasoningEffort?: string;
  maxTokens?: number;
  /** The model's name for people, in errors. */
  label?: string;
}

/** One question to a chat model (the request has exactly one). */
export async function handleChat(input: Required<Pick<SystemOneRequest, 'model'>> & Pick<SystemOneRequest, 'state' | 'questions'>, deps: ChatDeps): Promise<DecideResult> {
  const names = Object.keys(input.questions);
  if (names.length !== 1) return { status: 400, body: { error: 'A chat model is asked one question at a time' } };
  const name = names[0]!;
  const q = input.questions[name]!;
  const label = deps.label ?? input.model;
  const redact = (s: string): string => s.split(deps.apiKey).join('[redacted]');
  const log = (line: string) => deps.log?.(redact(line));
  const tag = `[chat${deps.keyMode ? ` ${deps.keyMode}` : ''}]`;
  const started = deps.now();
  try {
    const res = await deps.fetch(`${deps.baseUrl.replace(/\/+$/, '')}${CHAT_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        'Content-Type': 'application/json',
        'X-Opper-Name': deps.callName ?? 'decision-benchmarks',
        ...(deps.project ? { 'X-Opper-Project': deps.project } : {}),
      },
      body: JSON.stringify(chatRequestBody({ model: input.model, maxTokens: deps.maxTokens, reasoningEffort: deps.reasoningEffort }, deps.format.messages(input.state, q), deps.format.responseFormat(q))),
      signal: withSignal(deps.timeoutMs, deps.signal),
    });
    const latencyMs = Math.round(deps.now() - started);
    if (!res.ok) {
      const error = redact(`${label} returned HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      log(`${tag} ${input.model} failed after ${latencyMs} ms: ${error}`);
      return refusedUpstream(res.status, deps.keyMode, label) ?? { status: 502, body: { error } };
    }
    const data = (await res.json()) as ChatCompletion;
    const cost = res.headers.get('x-opper-cost');
    const traceId = res.headers.get('x-opper-trace-id');
    const answer = chatReplyAnswer(data, (content) => deps.format.parse(content, q));
    log(`${tag} ${input.model} ok in ${latencyMs} ms, cost ${cost ?? '?'} USD, trace ${traceId ?? '?'}`);
    return {
      status: 200,
      body: { model: input.model, answers: { [name]: answer }, usage: { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0 }, latencyMs, costUsd: cost === null ? null : Number(cost), traceId },
    };
  } catch (err) {
    const e = err as Error;
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    const error = deps.signal?.aborted ? `${label} was cancelled` : timedOut ? `${label} timed out after ${deps.timeoutMs} ms` : redact(`${label} request failed: ${e?.message ?? String(err)}`);
    log(`${tag} ${input.model} ${error}`);
    return { status: timedOut ? 504 : 502, body: { error } };
  }
}
