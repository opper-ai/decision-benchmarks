import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('the production server', () => {
  // The image runs `node server/main.ts`: Node strips the types and runs the rest as is, so server code must stay
  // within what stripping supports (no constructor parameter properties, enums or namespaces). Vitest transpiles
  // everything, so only plain Node catches a slip.
  it('loads under plain Node, as the image runs it', () => {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', "await import('./server/app.ts'); await import('./server/routes.ts'); console.log('ok')"], { encoding: 'utf8' });
    expect(out.trim()).toBe('ok');
  });
});
