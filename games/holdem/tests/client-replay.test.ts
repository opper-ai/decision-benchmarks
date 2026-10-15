import { describe, expect, it } from 'vitest';
import type { Recording } from '../shared/recording';
import type { TableSnapshot } from '../src/driver';
import { LocalDriver } from '../src/local-driver';
import { ReplayDriver } from '../src/replay-driver';
import { decodeGame, encodeGame } from '../src/share';

/** A watched practice game: chat models with talk and reasoning, a decision model with probabilities, a bot. */
async function watchedGame(seed: number): Promise<Recording> {
  const d = new LocalDriver({ thinkScale: 0, sleep: async () => {} });
  let s: TableSnapshot = await d.start({ seed, seats: [{ kind: 'model', id: 'aws/claude-opus-5-5' }, { kind: 'model', id: 'sference/clef' }, { kind: 'bot', id: 'maniac' }, { kind: 'model', id: 'azure:eu/gpt-6.1-sol' }] });
  while (!(s.view.street === 'done' && s.over)) s = s.view.street === 'done' ? await d.nextHand() : (await d.step()).snapshot;
  return (await d.review()).recording!;
}

async function playToEnd(d: ReplayDriver) {
  let s = await d.start();
  const metas = [];
  while (!(s.view.street === 'done' && s.over)) {
    if (s.view.street === 'done') s = await d.nextHand();
    else {
      const r = await d.step();
      metas.push(r);
      s = r.snapshot;
    }
  }
  return { last: s, metas };
}

describe('ReplayDriver', () => {
  it('plays a recording back to its result, every card face up, with each move’s talk, face, tell and reasoning', async () => {
    const rec = await watchedGame(31);
    const d = new ReplayDriver(rec);
    const first = await d.start();
    expect(first.viewer).toBeNull();
    expect(first.view.players.filter((p) => p.cards).length).toBe(4);
    const { last, metas } = await playToEnd(d);
    expect(last.places).toEqual(rec.result.places);
    expect(last.view.players.map((p) => p.stack)).toEqual(rec.result.chips);
    const recorded = rec.hands.flatMap((h) => h.actions);
    expect(metas.map((m) => m.seat)).toEqual(recorded.map((a) => a.seat));
    expect(metas.filter((m) => m.seat === 0).some((m) => m.meta.say && m.meta.mood && m.meta.reasoning)).toBe(true);
    expect(metas.filter((m) => m.seat === 1).every((m) => m.meta.probabilities)).toBe(true);
    const review = await d.review();
    expect(review.hands).toHaveLength(rec.hands.length);
    expect(review.recording).toEqual(rec);
    await expect(d.step()).rejects.toThrow(/over/);
    await expect(d.nextHand()).rejects.toThrow(/over/);
  });

  it('refuses to act, and jumps to any hand and back', async () => {
    const rec = await watchedGame(32);
    const d = new ReplayDriver(rec);
    await d.start();
    await expect(d.act({ key: 'fold' })).rejects.toThrow(/plays itself/);
    const n = Math.min(d.hands, 7);
    const at = await d.jumpTo(n);
    expect(at.hand).toBe(n);
    expect(d.position()).toMatchObject({ hand: n, move: 0 });
    expect((await d.review()).hands).toHaveLength(n - 1);
    // Back to the start, then on to the end from a jump.
    expect((await d.jumpTo(1)).hand).toBe(1);
    expect((await d.jumpTo(999)).hand).toBe(d.hands);
    let s = d.snapshot();
    while (!(s.view.street === 'done' && s.over)) s = s.view.street === 'done' ? await d.nextHand() : (await d.step()).snapshot;
    expect(s.places).toEqual(rec.result.places);
  });

  it('plays a share link: the decoded game ends as the original did', async () => {
    const rec = await watchedGame(33);
    const back = decodeGame(encodeGame(rec));
    if (!back.ok) throw new Error(back.error);
    const { last } = await playToEnd(new ReplayDriver(back.recording));
    expect(last.places).toEqual(rec.result.places);
  });

  it('refuses a recording that does not replay', async () => {
    const rec = await watchedGame(34);
    const broken: Recording = structuredClone(rec);
    broken.hands[0]!.actions[0]!.key = broken.hands[0]!.actions[0]!.key === 'fold' ? 'pot' : 'fold';
    expect(() => new ReplayDriver(broken)).toThrow();
    expect(() => new ReplayDriver({ ...rec, result: { chips: [1, 2, 3, 4], places: [1, 2, 3, 4] } })).toThrow(/claims/);
  });
});

describe('a replay of a game with your table talk', () => {
  it('keeps the talk in each finished hand it hands the review', async () => {
    const d = new LocalDriver({ thinkScale: 0, sleep: async () => {} });
    let s = await d.start({ seed: 4, seats: [{ kind: 'human', id: 'you' }, { kind: 'model', id: 'aws/claude-opus-5-5' }] });
    let said = 0;
    while (!s.over) {
      if (s.view.street === 'done') s = await d.nextHand();
      else if (s.turn) {
        if (said < 3 && d.say(`line ${said}`)) said++;
        s = (await d.act({ key: s.turn.options.some((o) => o.key === 'allin') ? 'allin' : 'call' })).snapshot;
      } else s = (await d.step()).snapshot;
    }
    const recording = (await d.review()).recording!;
    const talked = recording.hands.flatMap((h, i) => (h.talk?.length ? [i + 1] : []));
    expect(talked.length).toBeGreaterThan(0);

    const r = new ReplayDriver(recording);
    await r.jumpTo(r.hands);
    while (r.snapshot().view.toAct !== null) await r.step();
    const review = await r.review();
    for (const n of talked) expect(review.hands.find((h) => h.hand === n)?.talk).toEqual(recording.hands[n - 1]!.talk);
  });
});
