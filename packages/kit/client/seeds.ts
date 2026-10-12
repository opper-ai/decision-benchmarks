import { appPath } from './paths.ts';

/** A seed the server issued for a player's game, and its signed token (the high-score entry carries the token). */
export interface IssuedSeed {
  seed: number;
  token: string;
}

/** GET <game>/api/seed, or null when the server issues none or could not be reached (the game is then for fun only). */
export async function fetchSeed(): Promise<IssuedSeed | null> {
  try {
    const res = await fetch(appPath('/api/seed'), { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<IssuedSeed>;
    return Number.isInteger(data.seed) && typeof data.token === 'string' ? { seed: data.seed!, token: data.token } : null;
  } catch {
    return null;
  }
}
