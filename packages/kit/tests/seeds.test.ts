import { describe, expect, it } from 'vitest';
import { issueSeed, SEED_TTL_MS, seedKey, seedVerifier } from '../server/seeds';

const key = seedKey('s'.repeat(64), 'snake');

describe('issued seeds', () => {
  it('verifies a token it issued, with its seed and age', () => {
    const { seed, token } = issueSeed(key, 1_000_000, () => 4242);
    expect(seed).toBe(4242);
    expect(seedVerifier(key, () => 1_005_000)(token)).toEqual({ seed: 4242, ageMs: 5000 });
  });

  it("refuses a token that was edited, expired, or issued for another game, and anything that isn't one", () => {
    const { token } = issueSeed(key, 1_000_000, () => 7);
    const at = (now: number) => seedVerifier(key, () => now);
    expect(at(1_000_000 + SEED_TTL_MS + 1)(token)).toBeNull();
    expect(at(1_000_000)(token.replace(/^7\./, '8.'))).toBeNull();
    expect(at(1_000_000)(token.replace('.1000000.', '.1000001.'))).toBeNull();
    expect(seedVerifier(seedKey('s'.repeat(64), 'pacman'), () => 1_000_000)(token)).toBeNull();
    for (const junk of [undefined, null, 7, '', '7', 'a.b.c', `${'9'.repeat(70)}`, { seed: 7 }]) expect(at(1_000_000)(junk)).toBeNull();
  });

  it('issues different seeds from the random source', () => {
    const seeds = new Set(Array.from({ length: 20 }, () => issueSeed(key, 0).seed));
    expect(seeds.size).toBeGreaterThan(15);
    for (const s of seeds) expect(Number.isInteger(s) && s >= 0 && s < 2 ** 31).toBe(true);
  });
});
