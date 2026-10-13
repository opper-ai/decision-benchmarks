import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { REGISTRY } from '../../../games/registry';

describe('the production server', () => {
  // The image runs `node server/main.ts`: Node strips the types and runs the rest as is, so the kit's server and every
  // game's server module must stay within what stripping supports (no constructor parameter properties, enums or
  // namespaces, imports with .ts extensions). Vitest transpiles everything, so only plain Node catches a slip.
  it("loads the kit's server and every game's server module under plain Node, as the image runs them", () => {
    const games = REGISTRY.map((g) => `./games/${g.slug}/game.server.ts`);
    const script = [
      "await import('./packages/kit/server/app.ts');",
      "await import('./packages/kit/server/routes.ts');",
      "const { REGISTRY } = await import('./games/registry.ts');",
      'for (const g of REGISTRY) { const s = await g.server(); if (s.slug !== g.slug) throw new Error(g.slug); }',
      ...games.map((m) => `await import(${JSON.stringify(m)});`),
      "console.log('ok')",
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(out.trim()).toBe('ok');
  });

  it("loads the bench, the submissions check and every game's definition under plain Node, as the scripts run them", () => {
    const script = [
      "await import('./packages/kit/bench/bench.ts');",
      "await import('./packages/kit/bench/submissions.ts');",
      "const { REGISTRY } = await import('./games/registry.ts');",
      'for (const g of REGISTRY) { const d = await g.definition(); if (d.slug !== g.slug) throw new Error(g.slug); }',
      "console.log('ok')",
    ].join('\n');
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim()).toBe('ok');
  });
});
