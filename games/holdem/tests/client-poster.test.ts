import { describe, expect, it } from 'vitest';
import type { TableSnapshot } from '../src/driver';
import { highlightsOf, momentOf, titleOf } from '../src/highlights';
import { LocalDriver } from '../src/local-driver';
import { POSTER_H, POSTER_HOOK, POSTER_W, posterData, posterLayout } from '../src/poster';
import { estimate, type Item } from '../src/share-image';
import { personOf } from '../src/view-model';

async function review(seed: number) {
  const d = new LocalDriver({ thinkScale: 0, sleep: async () => {} });
  const seats = [{ kind: 'model' as const, id: 'anthropic/claude-fable-5-1' }, { kind: 'model' as const, id: 'azure/gpt-6-astra-global' }, { kind: 'model' as const, id: 'vertexai/gemini-4-argon-eu' }];
  let s: TableSnapshot = await d.start({ seed, seats });
  while (!(s.view.street === 'done' && s.over)) s = s.view.street === 'done' ? await d.nextHand() : (await d.step()).snapshot;
  return d.review();
}

const inside = (it: Item): boolean => {
  if (it.kind === 'bubble') return it.x - it.maxWidth / 2 >= 0 && it.x + it.maxWidth / 2 <= POSTER_W && it.y - 2 * it.size * 1.05 - it.size * 0.6 >= 0;
  if (it.kind === 'back') return true;
  if (it.kind === 'rect') return it.x >= 0 && it.y >= 0 && it.x + it.w <= POSTER_W && it.y + it.h <= POSTER_H;
  if (it.kind === 'ellipse') return it.cx - it.rx >= 0 && it.cy - it.ry >= 0 && it.cx + it.rx <= POSTER_W && it.cy + it.ry <= POSTER_H;
  if (it.kind === 'avatar') return it.cx - it.r >= 0 && it.cy - it.r >= 0 && it.cx + it.r <= POSTER_W && it.cy + it.r <= POSTER_H;
  if (it.kind === 'card') return it.x >= 0 && it.y >= 0 && it.x + it.w <= POSTER_W && it.y + it.w * 1.4 <= POSTER_H;
  const w = estimate(it.text, it.font, it.size, it.weight);
  const left = it.align === 'left' ? it.x : it.align === 'center' ? it.x - w / 2 : it.x - w;
  return left >= 0 && left + w <= POSTER_W && it.y - it.size >= 0 && it.y <= POSTER_H;
};

describe('the poster', () => {
  it('shows the replay’s best moment, as its end screen says it, with both players’ cards and the board', async () => {
    const r = await review(5);
    const d = posterData(r)!;
    const m = momentOf(r.hands, r.players, (s) => personOf(r.players[s]!).name)!;
    expect(d.hook).toBe(POSTER_HOOK);
    expect(d.moment.title).toBe(m.title);
    expect(`Hand ${m.highlight.hand}. ${d.moment.caption}`).toBe(m.text);
    expect(d.featured.name).toBe(personOf(r.players[m.highlight.featured]!).name);
    expect(d.against.name).not.toBe(d.featured.name);
    expect(d.featured.hole).toHaveLength(2);
    expect(d.lineup.map((p) => p.name)).toEqual(['Fable 5.1', 'GPT-6 Astra', 'Gemini 4 Argon']);
    // Or the best moment of one hand.
    const other = r.hands.find((h) => h.hand !== m.highlight.hand)!.hand;
    expect(posterData(r, other)?.moment.where).toMatch(new RegExp(`^Hand ${other} of ${r.hands.length}, blinds \\d+/\\d+$`));
    // Or the best of one kind: the game's biggest pot is always there; a kind the game lacks gives nothing.
    expect(posterData(r, undefined, 'biggest_pot')?.moment.title).toBe('Biggest pot');
    const kinds = new Set(r.hands.flatMap((h) => highlightsOf(h, r.players).map((x) => x.kind)));
    for (const kind of ['bluff', 'hero_call', 'cooler'] as const) {
      const d = posterData(r, undefined, kind);
      expect(d === null).toBe(!kinds.has(kind));
      if (d) expect(d.moment.title).toBe(titleOf({ kind, worked: d.moment.title === 'Bluff that worked' }));
    }
  });

  it('lays everything out inside 1280×720: the title, the hook, the moment, the felt, the faces and the cards', async () => {
    for (const seed of [1, 2, 3]) {
      const d = posterData(await review(seed))!;
      const items = posterLayout({ ...d, say: 'I have been waiting all night for this one, and you walked right into it.' });
      expect(items.filter((it) => !inside(it))).toEqual([]);
      expect(items.filter((it) => it.kind === 'avatar')).toHaveLength(d.lineup.length + 2);
      expect(items.filter((it) => it.kind === 'card')).toHaveLength(d.featured.hole.length + d.against.hole.length + d.board.length);
      const words = items.flatMap((it) => (it.kind === 'text' ? [it.text] : []));
      expect(words).toContain("AI Hold'em");
      expect(words).toContain(POSTER_HOOK);
      expect(items.filter((it) => it.kind === 'bubble')).toHaveLength(1);
    }
  });
});
