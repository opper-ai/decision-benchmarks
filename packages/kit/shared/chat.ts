/**
 * Chat models in a game: how a game that plays chat models (through an OpenAI-compatible chat completions endpoint,
 * such as Opper's /v3/compat/chat/completions) asks them its questions. By default the bench's chat adapter asks for a
 * choice and probabilities (bench/transports.ts); a game with its own format (say, table talk next to the choice)
 * gives one here, so the bench, and the service when it plays chat models, ask exactly what the game asks. Isomorphic.
 */
import type { ChoiceQuestion } from './systemone.ts';

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface ChatFormat {
  /** The messages for one question, from the request's state. */
  messages(state: Record<string, unknown>, q: ChoiceQuestion): ChatMessage[];
  /** The request's response_format: a strict JSON schema whose choice is one of the question's criteria keys. */
  responseFormat(q: ChoiceQuestion): Record<string, unknown>;
  /**
   * The answer in a reply's content: `{ type: 'choice', choice, ... }` (anything else the game keeps rides along), or
   * null when the content is not a valid answer (the game's fallback then decides).
   */
  parse(content: string, q: ChoiceQuestion): Record<string, unknown> | null;
}

/** A chat model a game's official runs play, by its Opper id. */
export interface ChatModel {
  id: string;
  name: string;
  /** Sent as reasoning_effort (low, medium, ...); the bench's --reasoning-effort overrides it. */
  reasoningEffort?: string;
  /** Room for the reply, reasoning included. */
  maxTokens?: number;
}

/** The answer a transport gives for a reply the model refused to write (finish_reason "refusal"): no choice, so every game falls back. */
export const REFUSAL = { type: 'refusal' } as const;

/** What an OpenAI-compatible chat completions endpoint answers, as far as a game reads it. */
export interface ChatCompletion {
  choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** The request body for one question: the messages, the strict schema, room for the reply and the reasoning effort. */
export function chatRequestBody(o: { model: string; maxTokens?: number; reasoningEffort?: string }, messages: readonly ChatMessage[], responseFormat: Record<string, unknown>): Record<string, unknown> {
  return { model: o.model, messages, response_format: responseFormat, max_tokens: o.maxTokens ?? 1200, ...(o.reasoningEffort ? { reasoning_effort: o.reasoningEffort } : {}) };
}

/** The answer in a completion: REFUSAL for a refused reply, else `parse` of its content (a ```json fence taken off). */
export function chatReplyAnswer(data: ChatCompletion, parse: (content: string) => unknown): unknown {
  const choice = data.choices?.[0];
  // A refusal is no answer either, but one a game may want to count apart from a malformed reply.
  if (choice?.finish_reason === 'refusal' || choice?.message?.refusal) return { ...REFUSAL };
  return parse((choice?.message?.content ?? '').replace(/^```(?:json)?\s*|\s*```$/g, ''));
}
