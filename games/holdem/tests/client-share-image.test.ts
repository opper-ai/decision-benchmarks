import { describe, expect, it } from 'vitest';
import type { TableSnapshot } from '../src/driver';
import { LocalDriver } from '../src/local-driver';
import { momentOf } from '../src/highlights';
import { estimate, SHARE_H, SHARE_W, shareCardData, shareCardLayout, wrap, type Item } from '../src/share-image';
import { personOf } from '../src/view-model';

async function finished(seats: { kind: 'human' | 'model' | 'bot'; id: string }[], seed: number) {
  const d = new LocalDriver({ thinkScale: 0, sleep: async () => {} });
  let s: TableSnapshot = await d.start({ seed, seats });
  while (!(s.view.street === 'done' && s.over)) {
    if (s.view.street === 'done') s = await d.nextHand();
    else if (s.turn) s = (await d.act({ key: s.turn.options.some((o) => o.key === 'allin') ? 'allin' : 'call' })).snapshot;
    else s = (await d.step()).snapshot;
  }
  return { review: await d.review(), snap: s };
}

const inside = (it: Item): boolean => {
  if (it.kind === 'back' || it.kind === 'bubble') return true;
  if (it.kind === 'rect') return it.x >= 0 && it.y >= 0 && it.x + it.w <= SHARE_W && it.y + it.h <= SHARE_H;
  if (it.kind === 'ellipse') return it.cx - it.rx >= 0 && it.cy - it.ry >= 0 && it.cx + it.rx <= SHARE_W && it.cy + it.ry <= SHARE_H;
  if (it.kind === 'avatar') return it.cx - it.r >= 0 && it.cy - it.r >= 0 && it.cx + it.r <= SHARE_W && it.cy + it.r <= SHARE_H;
  if (it.kind === 'card') return it.x >= 0 && it.y >= 0 && it.x + it.w <= SHARE_W && it.y + it.w * 1.4 <= SHARE_H;
  const w = estimate(it.text, it.font, it.size, it.weight);
  const left = it.align === 'left' ? it.x : it.align === 'center' ? it.x - w / 2 : it.x - w;
  return left >= 0 && left + w <= SHARE_W && it.y - it.size >= 0 && it.y <= SHARE_H;
};

describe('the share image', () => {
  it('says what the end screen says, from the player’s side', async () => {
    const { review, snap } = await finished([{ kind: 'human', id: 'you' }, { kind: 'model', id: 'aws/claude-opus-5-5' }, { kind: 'model', id: 'sference/clef' }, { kind: 'bot', id: 'maniac' }], 12);
    const d = shareCardData(review, snap.places, snap.eliminations, snap.hand, 0);
    const mine = snap.places[0]!;
    expect(d.title).toBe(mine === 1 ? 'You won the table' : `You finished ${['', '1st', '2nd', '3rd', '4th'][mine]}`);
    expect(d.standings.map((s) => s.place)).toEqual([1, 2, 3, 4]);
    expect(d.standings.find((s) => s.name === 'You')!.place).toBe(mine);
    // The felt shows the best moment's protagonist, with the end screen's sentence.
    const m = momentOf(review.hands, review.players, (s) => personOf(review.players[s]!).name)!;
    expect(d.featured?.caption).toBe(m.text);
    expect(d.featured?.name).toBe(personOf(review.players[m.highlight.featured]!).name);
    expect(d.moment?.title).toBe(m.title);
    expect(d.standings.find((s) => s.name === 'Opus 5.5')!.slug).toBe('anthropic-claude-opus-5-5');
    expect(d.featured?.hole).toHaveLength(2);
  });

  it('lays everything out inside 1200×630: the poster, the places, the moment, the felt and its cards', async () => {
    for (const seed of [1, 2, 3, 4]) {
      const { review, snap } = await finished([{ kind: 'model', id: 'openai/gpt-6-luna-decisions' }, { kind: 'model', id: 'azure:global/microsoft-decision-1' }, { kind: 'model', id: 'vertexai/claude-sonnet-5-5-eu' }, { kind: 'model', id: 'azure/gpt-6-astra-global' }], seed);
      const data = shareCardData(review, snap.places, snap.eliminations, snap.hand, null);
      expect(data.title).toMatch(/wins the table$/);
      const items = shareCardLayout(data);
      const outside = items.filter((it) => !inside(it));
      expect(outside).toEqual([]);
      expect(items.filter((it) => it.kind === 'avatar')).toHaveLength(4 + (data.featured ? 1 : 0));
      if (data.featured) expect(items.filter((it) => it.kind === 'card')).toHaveLength(2 + data.featured.board.length);
      // The title, on one line or two.
      const titled = items.filter((it) => it.kind === 'text' && it.font === 'Fraunces' && it.color === '#b5342b' && !/^\d/.test(it.text));
      expect(titled.map((it) => (it.kind === 'text' ? it.text : '')).join(' ')).toBe(data.title);
    }
  });

  it('shrinks a long title and wraps the moment into two lines at most', () => {
    const data = { title: 'Microsoft Decision 1 wins the table', sub: 'x', standings: [], moment: { title: 'Bluff that worked', where: 'Hand 3' }, featured: { name: 'Clef', slug: null, hole: ['As', 'Kd'], board: ['2c', '3d', '4h'], caption: 'word '.repeat(80) } };
    const items = shareCardLayout(data);
    const title = items.find((it) => it.kind === 'text' && it.font === 'Fraunces' && it.text.startsWith('Microsoft'));
    expect(title && title.kind === 'text' && title.size).toBeLessThan(60);
    const body = items.filter((it) => it.kind === 'text' && it.text.startsWith('word'));
    expect(body).toHaveLength(3);
    expect(wrap('a b c d e f', 3, 2, (t) => t.length <= 3)).toEqual(['a b', 'c…']);
  });
});
