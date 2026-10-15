// The kit's leaderboard shows each model's maker mark from the game's own public/logos: every mark it can ask for has
// to be there, or the page shows a broken image.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('maker logos', () => {
  it('ships every mark the kit leaderboard can show', () => {
    const source = readFileSync(new URL('../../../packages/kit/client/logos.ts', import.meta.url), 'utf8');
    const files = [...new Set([...source.matchAll(/file: '([^']+)'/g)].map((m) => m[1]!))];
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(existsSync(new URL(`../public/logos/${f}`, import.meta.url)), f).toBe(true);
  });
});
