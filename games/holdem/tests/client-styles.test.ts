// The kit's page.css styles the whole page, the room included: a class it hides everywhere must stay visible where
// the game uses the same name.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const kit = readFileSync(new URL('../../../packages/kit/client/page.css', import.meta.url), 'utf8');
const ours = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

describe('styles', () => {
  it("shows the room's labels although the kit hides every .lbl", () => {
    if (/(^|\n)\.lbl\s*\{\s*display:\s*none/.test(kit)) expect(ours).toMatch(/\.room \.lbl\s*\{\s*display:\s*inline/);
  });
});
