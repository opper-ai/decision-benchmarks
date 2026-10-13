/**
 * The System One decision API, as games, the server and the bench speak it: a request names a model, a state and up
 * to a few choice questions; the answer picks one of each question's criteria keys, with probabilities. Isomorphic.
 */

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** Option key to what choosing it means; the answer's `choice` is one of these keys. */
  criteria: Record<string, string>;
}

export interface SystemOneRequest {
  /** The decision model (an id from shared/models.ts); the server's default when missing. */
  model?: string;
  state: Record<string, unknown>;
  questions: Record<string, ChoiceQuestion>;
  /** Each question's key (a junction, a turn), so the server can sign its answer for that key. */
  keys?: Record<string, string>;
}

/** What /api/decide (and the bench's transports) return. */
export interface DecideResponse {
  /** The model the server called, as the game named it (missing from older servers). */
  model?: string;
  answers: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number };
  latencyMs: number;
  costUsd: number | null;
  /** True when costUsd is estimated from token usage (TypeSafe's API sends no cost). */
  costEstimated?: boolean;
  /** The server's signature on each answer (by question), and the model id it signed them as. */
  signatures?: Record<string, string>;
  signedAs?: string;
  traceId: string | null;
}

/**
 * Sends one request and resolves with the answers, or rejects (the scheduler then uses its fallback). `signal` lets a
 * real-time game give up on a request whose step has passed; a transport that can't cancel may ignore it.
 */
export type Transport = (body: SystemOneRequest, opts?: { signal?: AbortSignal }) => Promise<DecideResponse>;

/** A request's own timeout, and the caller's signal when it has one: whichever ends it first. */
export const withSignal = (timeoutMs: number, signal?: AbortSignal): AbortSignal => (signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs));

/** A parsed answer: one of the offered options, and whatever probabilities and confidence came with it. */
export interface ParsedChoice<O extends string = string> {
  choice: O;
  probabilities: Partial<Record<O, number>>;
  confidence: number | null;
}

/** An answer to a choice question, or null when it is malformed or picks something that was not offered. */
export function parseChoice<O extends string>(answer: unknown, options: readonly O[]): ParsedChoice<O> | null {
  if (!answer || typeof answer !== 'object') return null;
  const a = answer as { type?: unknown; choice?: unknown; confidence?: unknown; probabilities?: unknown };
  if (a.type !== 'choice' || typeof a.choice !== 'string' || !options.includes(a.choice as O)) return null;
  const raw = (a.probabilities && typeof a.probabilities === 'object' ? a.probabilities : {}) as Record<string, unknown>;
  const probabilities: Partial<Record<O, number>> = {};
  for (const o of options) if (typeof raw[o] === 'number') probabilities[o] = raw[o] as number;
  return { choice: a.choice as O, probabilities, confidence: typeof a.confidence === 'number' ? a.confidence : null };
}

/** The fixed question a warm-up sends: the client only picks the model, never the content. */
export const WARM_UP_REQUEST: Omit<SystemOneRequest, 'model'> = {
  state: { note: 'warm-up' },
  questions: { warmup: { type: 'choice', instructions: 'Pick one.', criteria: { a: 'Option A', b: 'Option B' } } },
};
