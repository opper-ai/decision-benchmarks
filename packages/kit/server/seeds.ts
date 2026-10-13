import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { SeedVerifier } from '../shared/game.ts';

/**
 * Seeds the server issues for a player's game (GET <game>/api/seed), so a high-score entry plays the board it was
 * dealt, not one picked for being easy. A token is `<seed>.<issued at, ms>.<signature>`, signed with a key per game,
 * HMAC(SESSION_SECRET, "decision-benchmarks:seeds:" + slug): a token issued for one game never verifies in another.
 * Nothing is stored: the token carries everything the check needs.
 */

/** How long a token stays good: one game and a slow initials entry fit in it many times over. */
export const SEED_TTL_MS = 60 * 60_000;
/** Seeds are 31-bit, so every game's PRNG and JSON take them as they are. */
const MAX_SEED = 2 ** 31;
const SIG_CHARS = 22;

/** The seed-signing key of one game. */
export const seedKey = (secret: string, slug: string): Buffer => createHmac('sha256', secret).update(`decision-benchmarks:seeds:${slug}`).digest();

const sign = (key: Buffer, seed: number, issuedAt: number): string => createHmac('sha256', key).update(`seed|${seed}|${issuedAt}`).digest('base64url').slice(0, SIG_CHARS);

export interface IssuedSeed {
  seed: number;
  token: string;
}

/** A fresh random seed and its token. */
export function issueSeed(key: Buffer, now: number, random: (max: number) => number = (max) => randomInt(max)): IssuedSeed {
  const seed = random(MAX_SEED);
  const issuedAt = Math.floor(now);
  return { seed, token: `${seed}.${issuedAt}.${sign(key, seed, issuedAt)}` };
}

/** A check for tokens made with one game's key, as of `now()`: the seed and its age, or null. */
export function seedVerifier(key: Buffer, now: () => number): SeedVerifier {
  return (token) => {
    if (typeof token !== 'string' || token.length > 64) return null;
    const m = /^(\d{1,10})\.(\d{1,15})\.([A-Za-z0-9_-]+)$/.exec(token);
    if (!m) return null;
    const seed = Number(m[1]);
    const issuedAt = Number(m[2]);
    const sig = m[3]!;
    if (seed >= MAX_SEED || sig.length !== SIG_CHARS) return null;
    if (!timingSafeEqual(Buffer.from(sign(key, seed, issuedAt)), Buffer.from(sig))) return null;
    const ageMs = now() - issuedAt;
    // Issued in the future (another server's clock, a little ahead) counts as just issued; expired is refused.
    if (ageMs > SEED_TTL_MS) return null;
    return { seed, ageMs: Math.max(0, ageMs) };
  };
}
