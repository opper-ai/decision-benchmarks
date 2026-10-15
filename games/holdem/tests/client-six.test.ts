import { describe, expect, it } from 'vitest';
import type { TableSnapshot } from '../src/driver';
import { LocalDriver } from '../src/local-driver';
import { SHARE_H, SHARE_W, shareCardData, shareCardLayout, type Item } from '../src/share-image';

const SIX = ['aws/claude-opus-5-5', 'azure:eu/gpt-6.1-sol', 'sference/clef', 'typesafe/jev-1.13.0', 'openai/gpt-6-luna-decisions', 'opper/kev-4b'];

async function sixGame() {
  const d = new LocalDriver({ thinkScale: 0, sleep: async () => {} });
  let s: TableSnapshot = await d.start({ seed: 8, seats: SIX.map((id) => ({ kind: 'model' as const, id })) });
  while (!(s.view.street === 'done' && s.over)) s = s.view.street === 'done' ? await d.nextHand() : (await d.step()).snapshot;
  return { review: await d.review(), s };
}

const boxes = (items: Item[]) => items.flatMap((it) => (it.kind === 'avatar' ? [{ l: it.cx - it.r, r: it.cx + it.r, t: it.cy - it.r, b: it.cy + it.r }] : []));
const meet = (a: { l: number; r: number; t: number; b: number }, b: typeof a) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

describe('a table of six, shared', () => {
  it('lists all six on the share image, each row inside the poster, faces apart', async () => {
    const { review, s } = await sixGame();
    const data = shareCardData(review, s.places, s.eliminations, s.hand, null);
    expect(data.standings).toHaveLength(6);
    const items = shareCardLayout(data);
    const faces = boxes(items).filter((b) => b.r < SHARE_W / 2);
    expect(faces).toHaveLength(6);
    for (const f of faces) expect(f.b).toBeLessThan(SHARE_H - 34);
    for (let i = 0; i < faces.length; i++) for (let j = i + 1; j < faces.length; j++) expect(meet(faces[i]!, faces[j]!)).toBe(false);
  });
});
