import { describe, expect, it } from 'vitest';
import type { Action } from '../shared/engine';
import { verifyRecording } from '../shared/recording';
import { mulberry32 } from '../shared/rng';
import type { StepResult, TableDriver, TableSnapshot } from '../src/driver';
import { LocalDriver } from '../src/local-driver';

const instant = () => new LocalDriver({ thinkScale: 0, sleep: async () => {} });
const coinFrom = (seed: number) => {
  let s = seed;
  return () => {
    let r: number;
    [r, s] = mulberry32(s);
    return r;
  };
};

/** Plays to the end: AIs by step(), the human (if any) by `human`. */
async function playOut(d: TableDriver, first: TableSnapshot, human: (s: TableSnapshot) => Action): Promise<{ last: TableSnapshot; steps: StepResult[] }> {
  let s = first;
  const steps: StepResult[] = [];
  for (let guard = 0; guard < 20_000; guard++) {
    if (s.view.street === 'done') {
      if (s.over) return { last: s, steps };
      s = await d.nextHand();
      continue;
    }
    const r = s.turn ? await d.act(human(s)) : await d.step();
    steps.push(r);
    s = r.snapshot;
  }
  throw new Error('the Sit & Go did not end');
}

describe('LocalDriver', () => {
  it('watches four AIs play a whole Sit & Go, every card face up, and the recording verifies', async () => {
    const d = instant();
    const first = await d.start({ seed: 42, seats: [{ kind: 'model', id: 'aws/claude-opus-5-5' }, { kind: 'model', id: 'sference/clef' }, { kind: 'bot', id: 'maniac' }, { kind: 'model', id: 'azure:eu/gpt-6.1-sol' }] });
    expect(first.viewer).toBeNull();
    expect(first.turn).toBeNull();
    expect(first.view.players.every((p) => p.cards?.length === 2)).toBe(true);
    const { last, steps } = await playOut(d, first, () => {
      throw new Error('no human here');
    });
    expect(last.over).toBe(true);
    expect([...last.places].sort()).toEqual([1, 2, 3, 4]);
    expect(last.eliminations).toHaveLength(3);
    expect(last.view.players.reduce((a, p) => a + p.stack, 0)).toBe(6000);
    // Chat models talk and pull faces; decision models show probabilities; bots neither.
    const bySeat = (seat: number) => steps.filter((x) => x.seat === seat);
    expect(bySeat(0).every((x) => x.meta.mood && !x.meta.probabilities && x.meta.by === 'answer')).toBe(true);
    expect(bySeat(0).some((x) => x.meta.say)).toBe(true);
    expect(bySeat(1).every((x) => x.meta.probabilities && !x.meta.say && !x.meta.mood)).toBe(true);
    for (const x of bySeat(1)) expect(Object.values(x.meta.probabilities!).reduce((a, b) => a + b!, 0)).toBeCloseTo(1, 1);
    expect(bySeat(2).every((x) => x.meta.by === 'bot' && !x.meta.say && !x.meta.probabilities)).toBe(true);

    const review = await d.review();
    expect(review.recording).not.toBeNull();
    const verdict = verifyRecording(review.recording);
    expect(verdict.ok).toBe(true);
    expect(review.hands).toHaveLength(review.recording!.hands.length);
    expect(review.hands.every((h) => h.runout.length === 5 && h.events.some((e) => e.type === 'end'))).toBe(true);
    expect(review.hands.flatMap((h) => h.actions).filter((a) => a.seat === 0).every((a) => a.reasoning)).toBe(true);
  });

  it('plays a human through a whole Sit & Go: menu keys and slider raises; the human sees only their own cards', async () => {
    const d = instant();
    const coin = coinFrom(7);
    const first = await d.start({ seed: 9, seats: [{ kind: 'model', id: 'typesafe/jev-1.13.0' }, { kind: 'human', id: 'you' }, { kind: 'bot', id: 'station' }] });
    expect(first.viewer).toBe(1);
    let checked = 0;
    const { last } = await playOut(d, first, (s) => {
      if (s.view.street !== 'done' && checked < 50) {
        checked++;
        // Hidden: the others' cards (until a showdown shows them, which the engine's view handles).
        expect(s.view.players[1]!.cards).toHaveLength(2);
        if (!s.events.some((e) => e.type === 'showdown')) expect(s.view.players[0]!.cards).toBeNull();
      }
      const t = s.turn!;
      if (t.raise && coin() < 0.25) return { kind: 'raise', to: t.raise.min + Math.floor(coin() * (t.raise.max - t.raise.min + 1)) };
      // Mostly call or check, so the human lasts a while.
      const passive = t.options.find((o) => o.key === 'check' || o.key === 'call')!;
      return coin() < 0.7 ? { key: passive.key } : { key: t.options[Math.floor(coin() * t.options.length)]!.key };
    });
    expect(last.over).toBe(true);
    const review = await d.review();
    expect(verifyRecording(review.recording).ok).toBe(true);
    expect(review.recording!.hands.flatMap((h) => h.actions).some((a) => a.by === 'human' && a.to !== undefined)).toBe(true);
  });

  it('seats 2 to 6: practice at a table of 5 or 6, the stand-ins playing every AI seat, and the recording verifies', async () => {
    await expect(instant().start({ seats: Array.from({ length: 7 }, () => ({ kind: 'bot' as const, id: 'rock' })) })).rejects.toThrow(/2 to 6/);
    await expect(instant().start({ seats: [{ kind: 'human', id: 'you' }] })).rejects.toThrow(/2 to 6/);
    const models = ['aws/claude-opus-5-5', 'sference/clef', 'azure:eu/gpt-6.1-sol', 'vertexai/gemini-4-argon-eu', 'openai/gpt-6-luna-decisions'];
    for (const n of [5, 6]) {
      const d = instant();
      const coin = coinFrom(n);
      const first = await d.start({ seed: 50 + n, seats: [{ kind: 'human', id: 'you' }, ...models.slice(0, n - 1).map((id) => ({ kind: 'model' as const, id }))] });
      expect(first.view.players).toHaveLength(n);
      expect(first.view.level).toMatchObject({ handsUntilNextLevel: 2 * n });
      expect(d.standIns().slice(1).every((b) => b !== null)).toBe(true);
      const { last } = await playOut(d, first, (s) => {
        const t = s.turn!;
        const passive = t.options.find((o) => o.key === 'check' || o.key === 'call')!;
        return coin() < 0.8 ? { key: passive.key } : { key: t.options[Math.floor(coin() * t.options.length)]!.key };
      });
      expect(last.over).toBe(true);
      expect([...last.places].sort()).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      expect(last.eliminations).toHaveLength(n - 1);
      expect(last.view.players.reduce((a, p) => a + p.stack, 0)).toBe(n * 1500);
      const review = await d.review();
      expect(verifyRecording(review.recording).ok).toBe(true);
      expect(review.hands).toHaveLength(review.recording!.hands.length);
    }
  });

  it('refuses a human action out of turn or against the rules, and an AI step on the human’s turn', async () => {
    const d = instant();
    let s = await d.start({ seed: 3, seats: [{ kind: 'human', id: 'you' }, { kind: 'bot', id: 'rock' }] });
    // Heads-up the button acts first before the flop; step the bot until it is the human's turn.
    while (!s.turn) {
      await expect(d.act({ key: 'fold' })).rejects.toThrow(/not your turn/);
      s = s.view.street === 'done' ? await d.nextHand() : (await d.step()).snapshot;
    }
    await expect(d.step()).rejects.toThrow(/human/);
    const t = s.turn;
    if (t.toCall > 0) await expect(d.act({ key: 'check' })).rejects.toThrow(/not a legal option/);
    else await expect(d.act({ key: 'fold' })).rejects.toThrow(/not a legal option/);
    if (t.raise && t.raise.min < t.raise.max) {
      await expect(d.act({ kind: 'raise', to: t.raise.min - 1 })).rejects.toThrow(/at least/);
      await expect(d.act({ kind: 'raise', to: t.raise.max + 1 })).rejects.toThrow(/at most/);
    }
    // Still the human's turn after the refusals, and a legal action plays.
    const r = await d.act({ key: t.options[0]!.key === 'fold' ? 'call' : 'check' });
    expect(r.meta.by).toBe('human');
    expect(r.seat).toBe(0);
  });

  it('runs the hand to its end before the next deal, and keeps finished hands for the review only', async () => {
    const d = instant();
    let s = await d.start({ seed: 5, seats: [{ kind: 'bot', id: 'rock' }, { kind: 'bot', id: 'station' }] });
    await expect(d.nextHand()).rejects.toThrow(/not over/);
    expect((await d.review()).hands).toHaveLength(0);
    while (s.view.street !== 'done') s = (await d.step()).snapshot;
    await expect(d.step()).rejects.toThrow(/over/);
    expect((await d.review()).hands).toHaveLength(1);
    expect((await d.review()).recording).toBeNull();
    s = await d.nextHand();
    expect(s.hand).toBe(2);
  });

  it('cancels a step that is thinking', async () => {
    const d = new LocalDriver({ thinkScale: 1 });
    await d.start({ seed: 1, seats: [{ kind: 'model', id: 'aws/claude-opus-5-5' }, { kind: 'model', id: 'aws/claude-haiku-5-5-eu' }] });
    const ac = new AbortController();
    const p = d.step(ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow(/cancelled/);
    // The table did not move.
    expect((await d.step()).seat).toBeTypeOf('number');
  });

  it('gives the time bank of the seat to act: chat 20 s, decision 2.5 s', async () => {
    const d = instant();
    const s = await d.start({ seed: 11, seats: [{ kind: 'model', id: 'aws/claude-opus-5-5' }, { kind: 'model', id: 'sference/clef' }] });
    const seat = s.view.toAct!;
    expect(s.timeBankMs).toBe(seat === 0 ? 20_000 : 2_500);
  });
});

describe('practice, once you are out', () => {
  it('watches the rest as a spectator: every card up, the models’ reasoning with each step', async () => {
    // A table where you shove every hand until you are out and the two models play on (the first seed that goes so).
    const reasoned: boolean[] = [];
    for (let seed = 1; seed <= 40 && !reasoned.length; seed++) {
      const d = new LocalDriver({ thinkScale: 0, sleep: async () => {} });
      let s = await d.start({ seed, seats: [{ kind: 'human', id: 'you' }, { kind: 'model', id: 'aws/claude-opus-5-5' }, { kind: 'model', id: 'aws/claude-haiku-5-5-eu' }] });
      while (!s.over) {
        if (s.view.street === 'done') s = await d.nextHand();
        else if (s.turn) s = (await d.act({ key: s.turn.options.some((o) => o.key === 'allin') ? 'allin' : 'call' })).snapshot;
        else {
          const out = s.places[0] !== null;
          const r = await d.step();
          if (out) reasoned.push(r.meta.reasoning !== undefined);
          else expect(r.meta.reasoning).toBeUndefined();
          s = r.snapshot;
        }
        if (s.places[0] !== null) {
          expect(s.spectating).toBe(true);
          expect(s.turn).toBeNull();
          // Every hole card dealt is in the events (in play they are hidden as []).
          const holes = s.events.filter((e) => e.type === 'hole');
          expect(holes.length).toBeGreaterThan(0);
          expect(holes.every((e) => e.type === 'hole' && e.cards.length === 2)).toBe(true);
        } else expect(s.spectating).toBeUndefined();
      }
    }
    expect(reasoned.length).toBeGreaterThan(0);
    expect(reasoned.every(Boolean)).toBe(true);
  });
});
