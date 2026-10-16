// The kit's page.css styles the whole page, the room included: a class it hides everywhere must stay visible where
// the game uses the same name.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const kit = readFileSync(new URL('../../../packages/kit/client/page.css', import.meta.url), 'utf8');
const ours = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
const share = readFileSync(new URL('../src/share.css', import.meta.url), 'utf8');

/** Every selector in a stylesheet (at-rules' preludes left out), one per comma. */
function selectors(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  for (const m of text.matchAll(/([^{};]+)\{/g)) {
    const prelude = m[1]!.trim();
    if (!prelude || prelude.startsWith('@') || /^(from|to|\d+%)/.test(prelude)) continue;
    out.push(...prelude.split(',').map((s) => s.trim()));
  }
  return out;
}

describe('styles', () => {
  it("shows the room's labels although the kit hides every .lbl", () => {
    if (/(^|\n)\.lbl\s*\{\s*display:\s*none/.test(kit)) expect(ours).toMatch(/\.room \.lbl\s*\{\s*display:\s*inline/);
  });

  // The kit's header has its own .menu (the account's dropdown, .user-menu .menu): a bare .menu rule of ours laid its
  // lines out side by side as the action bar's columns.
  it('keeps the action bar’s .menu rules to the bar, clear of the header’s account menu', () => {
    expect(kit).toMatch(/\.user-menu \.menu/);
    const all = [...selectors(ours), ...selectors(share)];
    expect(all.length).toBeGreaterThan(100);
    expect(all.filter((s) => /^\.menu\b/.test(s))).toEqual([]);
    expect(all.filter((s) => /\.menu\b/.test(s)).every((s) => s.startsWith('.actions .menu'))).toBe(true);
  });
});
