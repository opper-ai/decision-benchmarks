import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

// The image and CI as reviewed: the image builds every game, CI's loops fail loudly, and the service cannot rewrite its
// code.
describe('CI and the image', () => {
  const ci = read('.github/workflows/ci.yml');

  it('replays submissions in a loop that fails when listing the games fails', () => {
    const replay = ci.slice(ci.indexOf('name: Replay every submission'), ci.indexOf('npm run check-contract'));
    expect(replay).toMatch(/set -euo pipefail/);
    expect(replay).toMatch(/games=\$\(node /);
    expect(replay).toMatch(/for game in \$games; do/);
  });

  it("smoke-tests every game the image serves, game.json's updatedAt included", () => {
    expect(ci).toMatch(/python3 scripts\/smoke-image\.py/);
    expect(read('scripts/smoke-image.py')).toMatch(/fromisoformat\(info\['updatedAt'\]\)/);
  });

  it('copies every game into the image, and the runtime code root-owned', () => {
    expect(read('.dockerignore')).toMatch(/^!games\/$/m);
    expect(read('.dockerignore')).not.toMatch(/^games\//m);
    const runtime = read('Dockerfile').split(/^FROM /m).find((stage) => /AS runtime/.test(stage))!;
    expect(runtime).toMatch(/^COPY packages\/kit\/server /m);
    expect(runtime).not.toMatch(/--chown/);
  });
});
