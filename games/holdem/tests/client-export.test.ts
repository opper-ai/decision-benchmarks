import { describe, expect, it } from 'vitest';
import type { TableSnapshot } from '../src/driver';
import { CLIP_MAX_SECONDS, CLIP_SIZE, clipFrameItems, clipInfo, clipTimeline, frameAt } from '../src/export';
import { LocalDriver } from '../src/local-driver';
import type { Item } from '../src/share-image';

async function game() {
  const d = new LocalDriver({ thinkScale: 0, sleep: async () => {} });
  let s: TableSnapshot = await d.start({ seed: 21, seats: [{ kind: 'human', id: 'you' }, { kind: 'model', id: 'aws/claude-opus-5-5' }, { kind: 'model', id: 'azure:eu/gpt-6.1-sol' }, { kind: 'model', id: 'sference/clef' }] });
  while (!(s.view.street === 'done' && s.over)) {
    if (s.view.street === 'done') s = await d.nextHand();
    else if (s.turn) s = (await d.act({ key: s.turn.options.find((o) => o.key === 'check' || o.key === 'call')!.key })).snapshot;
    else s = (await d.step()).snapshot;
  }
  return d.review();
}

const inBounds = (it: Item) => {
  if (it.kind === 'rect') return it.x >= 0 && it.y >= 0 && it.x + it.w <= CLIP_SIZE && it.y + it.h <= CLIP_SIZE;
  if (it.kind === 'card') return it.x >= 0 && it.y >= 0 && it.x + it.w <= CLIP_SIZE && it.y + it.w * 1.4 <= CLIP_SIZE;
  if (it.kind === 'avatar') return it.cx - it.r >= 0 && it.cy - it.r >= 0 && it.cx + it.r <= CLIP_SIZE && it.cy + it.r <= CLIP_SIZE;
  if (it.kind === 'ellipse') return it.cx - it.rx >= 0 && it.cx + it.rx <= CLIP_SIZE && it.cy - it.ry >= 0 && it.cy + it.ry <= CLIP_SIZE;
  return true;
};

describe('a hand as a clip', () => {
  it('plays every moment in order and fits in 20 seconds', async () => {
    const review = await game();
    for (const hand of review.hands) {
      const tl = clipTimeline(hand);
      expect(tl.duration).toBeLessThanOrEqual(CLIP_MAX_SECONDS);
      expect(tl.beats[0]!.kind).toBe('deal');
      expect(tl.beats.at(-1)!.kind).toBe('end');
      expect(tl.beats.at(-1)!.upTo).toBe(hand.events.length - 1);
      // In time order, every event reached once.
      tl.beats.forEach((b, i) => {
        if (i) expect(b.at).toBeCloseTo(tl.beats[i - 1]!.at + tl.beats[i - 1]!.dur, 6);
        if (i) expect(b.upTo).toBeGreaterThanOrEqual(tl.beats[i - 1]!.upTo);
      });
      expect(tl.beats.filter((b) => b.kind === 'action')).toHaveLength(hand.events.filter((e) => e.type === 'action').length);
    }
  });

  it('squeezes a long hand: actions give way, never under a third of a second', () => {
    const many = { hand: 1, runout: [], actions: [], events: [{ type: 'start', button: 0, sb: 10, bb: 20, ante: 0, stacks: [100, 100] }, ...Array.from({ length: 60 }, () => ({ type: 'action', seat: 0, key: 'check', kind: 'check', to: 0, add: 0, allIn: false })), { type: 'end', stacks: [100, 100], net: [0, 0] }] } as never;
    const tl = clipTimeline(many);
    expect(tl.duration).toBeLessThanOrEqual(CLIP_MAX_SECONDS);
    expect(Math.min(...tl.beats.filter((b) => b.kind === 'action').map((b) => b.dur))).toBeGreaterThanOrEqual(0.33);
  });

  it('shows the table as it was at each moment: the deal, the talk, the end', async () => {
    const review = await game();
    const hand = review.hands.find((h) => h.actions.some((a) => a.say) && h.events.some((e) => e.type === 'showdown')) ?? review.hands.find((h) => h.actions.some((a) => a.say))!;
    const tl = clipTimeline(hand);
    const first = frameAt(hand, tl, 0);
    expect(first.beat.kind).toBe('deal');
    expect(first.model.seats.filter((p) => p.dealt).every((p) => p.cards?.length === 2)).toBe(true);
    expect(first.model.board).toEqual([]);
    const talk = tl.beats.find((b) => b.say)!;
    const during = frameAt(hand, tl, talk.at + 0.1);
    expect(during.talk).toContainEqual(talk.say);
    const end = frameAt(hand, tl, tl.duration - 0.01);
    expect(end.beat.kind).toBe('end');
    expect(end.model.street).toBe('done');
    const info = clipInfo(hand, review.players);
    for (const t of [0, talk.at + 0.1, tl.duration / 2, tl.duration - 0.01]) {
      const items = clipFrameItems(frameAt(hand, tl, t), info, hand);
      expect(items.filter((it) => !inBounds(it))).toEqual([]);
      expect(items.filter((it) => it.kind === 'avatar')).toHaveLength(4);
    }
    // The talk is drawn as a bubble; the human is You.
    expect(clipFrameItems(during, info, hand).some((it) => it.kind === 'bubble' && it.text === talk.say!.text)).toBe(true);
    expect(clipFrameItems(first, info, hand).some((it) => it.kind === 'text' && it.text === 'You')).toBe(true);
  });

  it('ends on the hand’s story, when it has one', async () => {
    const review = await game();
    const withStory = review.hands.map((h) => [h, clipInfo(h, review.players)] as const).find(([, i]) => i.caption);
    if (!withStory) return;
    const [hand, info] = withStory;
    const tl = clipTimeline(hand);
    const items = clipFrameItems(frameAt(hand, tl, tl.duration - 0.01), info, hand);
    const words = items.flatMap((it) => (it.kind === 'text' ? [it.text] : [])).join(' ');
    expect(words).toContain(info.caption!.split(' ').slice(0, 3).join(' '));
  });
});
