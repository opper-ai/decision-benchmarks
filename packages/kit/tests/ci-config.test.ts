import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

// The image and CI as reviewed: CI builds a real game, its loops fail loudly, and the service cannot rewrite its code.
describe('CI and the image', () => {
  const ci = read('.github/workflows/ci.yml');

  it('builds the Pac-Man fixture and replays submissions in a loop that fails when listing the games fails', () => {
    expect(ci).toMatch(/npm run build -- pacman/);
    const replay = ci.slice(ci.indexOf('name: Replay every submission'), ci.indexOf('name: Build the Pac-Man fixture'));
    expect(replay).toMatch(/set -euo pipefail/);
    expect(replay).toMatch(/games=\$\(node /);
    expect(replay).toMatch(/for game in \$games; do/);
  });

  it('keeps the fixture out of the image and copies the runtime code root-owned', () => {
    expect(read('.dockerignore')).toMatch(/^games\/pacman\/$/m);
    const runtime = read('Dockerfile').split(/^FROM /m).find((stage) => /AS runtime/.test(stage))!;
    expect(runtime).toMatch(/^COPY packages\/kit\/server /m);
    expect(runtime).not.toMatch(/--chown/);
  });
});
