import { createHmac, timingSafeEqual } from 'node:crypto';
import { answerMessage } from '../shared/answers.ts';

export { answerMessage };

/**
 * Signed model answers, so a high-score entry can only replay moves the server actually got from a model. Each answer
 * is signed for its question's key, the question, the choice and the model; the recording carries the signature, and
 * the game's high-score check verifies it. The key is per game, HMAC(SESSION_SECRET, "decision-benchmarks:answers:" +
 * slug), so an answer signed for one game never verifies in another.
 */

/** The signing key of one game. */
export const answerKey = (secret: string, slug: string): Buffer => createHmac('sha256', secret).update(`decision-benchmarks:answers:${slug}`).digest();

const SIG_CHARS = 22;

export function signAnswer(key: Buffer, message: string): string {
  return createHmac('sha256', key).update(message).digest('base64url').slice(0, SIG_CHARS);
}

/** A check for signatures made with one game's key, for that game's high-score check. */
export function answerVerifier(key: Buffer): (message: string, sig: string) => boolean {
  return (message, sig) => {
    if (typeof sig !== 'string' || sig.length !== SIG_CHARS) return false;
    const want = Buffer.from(signAnswer(key, message));
    return timingSafeEqual(want, Buffer.from(sig));
  };
}

const MAX_KEYS = 8;

/**
 * Signatures for a decide response: one per question the game named a key for and the model answered with a choice.
 * `model` is the id the answers are signed as (the game's own name for the model the server called).
 */
export function signAnswers(key: Buffer, keys: Record<string, string> | undefined, answers: Record<string, unknown>, model: string): Record<string, string> {
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return {};
  const out: Record<string, string> = {};
  for (const [question, k] of Object.entries(keys).slice(0, MAX_KEYS)) {
    const answer = answers[question] as { choice?: unknown } | undefined;
    if (typeof k !== 'string' || k.length > 64 || typeof answer?.choice !== 'string') continue;
    out[question] = signAnswer(key, answerMessage(k, question, answer.choice, model));
  }
  return out;
}
