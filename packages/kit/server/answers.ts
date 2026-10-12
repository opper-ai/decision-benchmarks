import { createHmac, timingSafeEqual } from 'node:crypto';
import { answerMessage } from '../shared/answers.ts';

export { answerMessage };

/**
 * Signed model answers, so a high-score entry can only replay ghost moves the server actually got from a model. Each
 * answer to a game question is signed for its junction (the decision point's key), the question (which ghost), the
 * direction and the model; the recording carries the signature, and the high-score check verifies it.
 */

const signingKey = (secret: string): Buffer => createHmac('sha256', secret).update('jevman: answer signatures').digest();

export function signAnswer(secret: string, message: string): string {
  return createHmac('sha256', signingKey(secret)).update(message).digest('base64url').slice(0, 22);
}

/** A check for signatures made with `secret`, for the high-score check. */
export function answerVerifier(secret: string): (message: string, sig: string) => boolean {
  const key = signingKey(secret);
  return (message, sig) => {
    if (typeof sig !== 'string' || sig.length !== 22) return false;
    const want = Buffer.from(createHmac('sha256', key).update(message).digest('base64url').slice(0, 22));
    return timingSafeEqual(want, Buffer.from(sig));
  };
}

const MAX_KEYS = 8;

/**
 * Signatures for a decide response: one per question the request named a junction key for and the model answered
 * with a direction. `model` is the listed model id the server called (the request's, else its default).
 */
export function signAnswers(secret: string, keys: unknown, answers: Record<string, unknown>, model: string): Record<string, string> {
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return {};
  const out: Record<string, string> = {};
  for (const [question, key] of Object.entries(keys as Record<string, unknown>).slice(0, MAX_KEYS)) {
    const answer = answers[question] as { choice?: unknown } | undefined;
    if (typeof key !== 'string' || key.length > 64 || typeof answer?.choice !== 'string') continue;
    out[question] = signAnswer(secret, answerMessage(key, question, answer.choice, model));
  }
  return out;
}
