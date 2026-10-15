import { describe, expect, it } from 'vitest';
import { botDecide, fallbackKey, type BotName } from '../shared/bots';
import { applyAction, legalOptions, newHand, observe, type HandState, type OptionKey } from '../shared/engine';
import { fingerprintOf, replay, verifyRecording, type Player, type Recording } from '../shared/recording';
import { actSitAndGo, newSitAndGo, nextHand, type SitAndGo } from '../shared/sitngo';
import { playDuplicate, playSitAndGo } from './support';

const bot = (id: BotName): Player => ({ kind: 'bot', id });
const MODEL: Player = { kind: 'model', id: 'opper/test-model' };
const HUMAN: Player = { kind: 'human', id: 'you' };
const TABLE: Player[] = [MODEL, bot('rock'), bot('station'), bot('maniac')];

const played = playSitAndGo(TABLE, 42);
const copy = (): Recording => structuredClone(played.recording);

/** The state before action `a` of hand `h` of a Sit & Go recording. */
function stateAt(rec: Recording, h: number, a: number): HandState {
  let g: SitAndGo = newSitAndGo({ seats: rec.players.length, key: rec.sitngo!.key });
  for (let i = 0; i < h; i++) {
    for (const x of rec.hands[i]!.actions) g = actSitAndGo(g, x.key ? { key: x.key } : { kind: 'raise', to: x.to! });
    g = nextHand(g);
  }
  for (const x of rec.hands[h]!.actions.slice(0, a)) g = actSitAndGo(g, x.key ? { key: x.key } : { kind: 'raise', to: x.to! });
  return g.hand;
}

/** The first action matching `pick`, as [hand, action]. */
function find(rec: Recording, pick: (x: Recording['hands'][number]['actions'][number], h: number, a: number) => boolean): [number, number] {
  for (let h = 0; h < rec.hands.length; h++) for (let a = 0; a < rec.hands[h]!.actions.length; a++) if (pick(rec.hands[h]!.actions[a]!, h, a)) return [h, a];
  throw new Error('no such action');
}

describe('replay', () => {
  it('re-plays a Sit & Go to the same events, chips and places', () => {
    const r = replay(copy());
    expect(r.hands.map((h) => h.events)).toEqual(played.events);
    expect(r.chips).toEqual(played.recording.result.chips);
    expect(r.places).toEqual(played.recording.result.places);
    expect(r.chips.reduce((a, b) => a + b, 0)).toBe(6000);
    expect(r.hands.length).toBeGreaterThan(10);
  });

  it('re-plays duplicate cash hands, the same cards to the same seat in every rotation', () => {
    const dup = playDuplicate(TABLE, 3, 7);
    const r = replay(dup.recording);
    expect(r.hands.map((h) => h.events)).toEqual(dup.events);
    expect(r.chips).toEqual(dup.recording.result.chips);
    expect(r.chips.reduce((a, b) => a + b, 0)).toBe(0);
    expect(r.places).toBeNull();
    const holes = (k: number) => dup.events[k]!.filter((e) => e.type === 'hole');
    for (let rot = 1; rot < 4; rot++) expect(holes(rot)).toEqual(holes(0));
    expect(dup.recording.hands.slice(0, 4).map((h) => h.seating)).toEqual([[0, 1, 2, 3], [1, 2, 3, 0], [2, 3, 0, 1], [3, 0, 1, 2]]);
  });

  it('refuses an illegal action', () => {
    const rec = copy();
    const [h, a] = find(rec, (x, h, a) => x.by === 'answer' && !legalOptions(stateAt(rec, h, a)).some((o) => o.key === 'check'));
    rec.hands[h]!.actions[a]!.key = 'check';
    expect(() => replay(rec)).toThrow(/not a legal option/);
  });
});

describe('verify', () => {
  it('accepts a genuine recording, with the same fingerprint every time, whatever its metadata', () => {
    const v = verifyRecording(copy());
    expect(v).toMatchObject({ ok: true, result: { chips: played.recording.result.chips } });
    const retold = copy();
    for (const h of retold.hands) for (const x of h.actions) if (x.by === 'answer') Object.assign(x, { latencyMs: 1, say: 'Something else.', mood: 'nervous', reasoning: 'Other words.' });
    const w = verifyRecording(retold);
    expect(v.ok && w.ok && v.fingerprint === w.fingerprint).toBe(true);
    expect(v.ok && v.fingerprint).toBe(fingerprintOf(copy()));
    const other = verifyRecording(playSitAndGo(TABLE, 43).recording);
    expect(v.ok && other.ok && v.fingerprint !== other.fingerprint).toBe(true);
  });

  it('accepts humans with slider raises, models with fallbacks, and short tables', () => {
    expect(verifyRecording(playSitAndGo([HUMAN, MODEL, bot('random')], 5).recording).ok).toBe(true);
    expect(verifyRecording(playSitAndGo([MODEL, bot('maniac')], 9).recording).ok).toBe(true);
    expect(verifyRecording(playDuplicate([MODEL, bot('rock'), bot('station')], 2, 3).recording).ok).toBe(true);
  });

  it("refuses a changed answer: another option changes the game, so the claimed result no longer holds", () => {
    const rec = copy();
    const [h, a] = find(rec, (x, h, a) => x.by === 'answer' && legalOptions(stateAt(rec, h, a)).some((o) => o.key !== x.key && o.key !== 'fold'));
    const other = legalOptions(stateAt(rec, h, a)).find((o) => o.key !== rec.hands[h]!.actions[a]!.key && o.key !== 'fold')!.key;
    rec.hands[h]!.actions[a]!.key = other;
    expect(verifyRecording(rec).ok).toBe(false);
  });

  it("refuses a bot move that is not the bot's", () => {
    const rec = copy();
    const [h, a] = find(rec, (x) => x.by === 'bot');
    const s = stateAt(rec, h, a);
    const x = rec.hands[h]!.actions[a]!;
    expect(botDecide((TABLE[x.seat]!.id) as BotName, observe(s, x.seat))).toBe(x.key);
    x.key = legalOptions(s).find((o) => o.key !== x.key)!.key;
    expect(verifyRecording(rec)).toMatchObject({ ok: false, error: expect.stringMatching(/the bot plays/) });
    // Nor can a bot seat's move pass as a model's answer, or a model's as a bot's.
    const asAnswer = copy();
    asAnswer.hands[h]!.actions[a]!.by = 'answer';
    expect(verifyRecording(asAnswer)).toMatchObject({ ok: false, error: expect.stringMatching(/bot/) });
    const asBot = copy();
    const [h2, a2] = find(asBot, (y) => y.by === 'answer');
    asBot.hands[h2]!.actions[a2]!.by = 'bot';
    expect(verifyRecording(asBot)).toMatchObject({ ok: false, error: expect.stringMatching(/model/) });
  });

  it("refuses a fallback that is not the rule's", () => {
    const rec = copy();
    const [h, a] = find(rec, (x, h, a) => x.by === 'answer' && x.key !== fallbackKey(legalOptions(stateAt(rec, h, a))));
    rec.hands[h]!.actions[a]!.by = 'fallback';
    expect(verifyRecording(rec)).toMatchObject({ ok: false, error: expect.stringMatching(/fallback/) });
  });

  it('refuses a wrong claimed result', () => {
    const chips = copy();
    chips.result.chips[0]! += 10;
    chips.result.chips[1]! -= 10;
    expect(verifyRecording(chips)).toMatchObject({ ok: false, error: expect.stringMatching(/claims/) });
    const places = copy();
    places.result.places = [...places.result.places!].reverse();
    expect(verifyRecording(places)).toMatchObject({ ok: false, error: expect.stringMatching(/claims/) });
  });

  it('refuses a game cut short, actions after the end, the wrong seat, and malformed recordings', () => {
    const short = copy();
    short.hands.pop();
    expect(verifyRecording(short)).toMatchObject({ ok: false, error: expect.stringMatching(/before it ended/) });
    const cut = copy();
    cut.hands[0]!.actions.pop();
    expect(verifyRecording(cut).ok).toBe(false);
    const long = copy();
    long.hands.push({ actions: [] });
    expect(verifyRecording(long)).toMatchObject({ ok: false, error: expect.stringMatching(/after the Sit & Go ended/) });
    const extra = copy();
    extra.hands[0]!.actions.push({ ...extra.hands[0]!.actions[0]! });
    expect(verifyRecording(extra).ok).toBe(false);
    const seat = copy();
    seat.hands[0]!.actions[0]!.seat = (seat.hands[0]!.actions[0]!.seat + 1) % 4;
    expect(verifyRecording(seat)).toMatchObject({ ok: false, error: expect.stringMatching(/not its turn|to act/) });
    const cases: [(r: Recording) => void, RegExp][] = [
      [(r) => ((r.hands[0]!.actions[0] as { key: string }).key = 'shove'), /key/],
      [(r) => ((r.hands[0]!.actions[0] as { by: string }).by = 'magic'), /by/],
      [(r) => (r.hands[0]!.actions[0]!.latencyMs = -5), /latency/],
      [(r) => (r.hands[0]!.actions[0]!.costUsd = 2), /costs 0 to 1/],
      [(r) => Object.assign(r.hands[0]!.actions[0]!, { by: 'answer', why: 'timeout' }), /why is for a fallback only/],
      [(r) => Object.assign(r.hands[0]!.actions[0]!, { by: 'fallback', why: 'bored' }), /why is for a fallback only/],
      [(r) => ((r.hands[0]!.actions[0] as { mood: string }).mood = 'furious'), /mood/],
      [(r) => (r.hands[0]!.actions[0]!.say = 'x'.repeat(1000)), /say/],
      [(r) => ((r.hands[0]!.actions[0] as unknown as Record<string, unknown>).extra = 1), /unknown fields/],
      [(r) => (r.hands[0]!.talk = [{ seat: r.players.length, after: 0, say: 'from nowhere' }]), /talk/],
      [(r) => (r.hands[0]!.talk = [{ seat: 0, after: 9999, say: 'later' }]), /talk/],
      [(r) => Object.assign(r.hands[0]!.actions[0]!, { to: 100 }), /key or a raise/],
      [(r) => ((r.players[1] as { id: string }).id = 'shark'), /bot/],
      [(r) => ((r.players[0] as { kind: string }).kind = 'alien'), /kind/],
      [(r) => (r.sitngo!.key = 'not a key'), /table key/],
      [(r) => Object.assign(r.sitngo!, { key: undefined, seed: 7 }), /table key/],
      [(r) => ((r as { mode: string }).mode = 'tournament'), /mode/],
    ];
    for (const [edit, message] of cases) {
      const rec = copy();
      edit(rec);
      expect(verifyRecording(rec), String(message)).toMatchObject({ ok: false, error: expect.stringMatching(message) });
    }
    expect(verifyRecording(null).ok).toBe(false);
    expect(verifyRecording({ format: 1, game: 'snake' }).ok).toBe(false);
  });

  it('accepts a long hand of slider raises, and refuses places claimed for cash hands', () => {
    // Two humans with deep stacks min-raise each other 300 times, then one calls.
    const cash = { stack: 1_000_000, sb: 1, bb: 2, ante: 0 };
    let s = newHand({ stacks: [cash.stack, cash.stack], button: 0, sb: 1, bb: 2, deckSeed: 3 });
    const actions: Recording['hands'][number]['actions'] = [];
    for (let i = 0; i < 300; i++) {
      const to = observe(s, s.toAct!).minRaiseTo!;
      actions.push({ seat: s.toAct!, to, by: 'human' });
      s = applyAction(s, { kind: 'raise', to });
    }
    actions.push({ seat: s.toAct!, key: 'call', by: 'human' });
    s = applyAction(s, { key: 'call' });
    while (s.toAct !== null) {
      actions.push({ seat: s.toAct, key: 'check', by: 'human' });
      s = applyAction(s, { key: 'check' });
    }
    const rec: Recording = { format: 1, game: 'holdem', mode: 'cash', players: [HUMAN, { kind: 'human', id: 'friend' }], cash, hands: [{ deckSeed: 3, button: 0, seating: [0, 1], actions }], result: { chips: s.seats.map((p) => p.stack - p.start) } };
    expect(verifyRecording(rec)).toMatchObject({ ok: true });
    expect(verifyRecording({ ...rec, result: { ...rec.result, places: [1, 2] } })).toMatchObject({ ok: false, error: expect.stringMatching(/places/) });
  });

  it('checks duplicate cash hands too: seating, a changed bot move, a wrong result', () => {
    const dup = playDuplicate(TABLE, 2, 11).recording;
    expect(verifyRecording(dup).ok).toBe(true);
    const seating = structuredClone(dup);
    seating.hands[0]!.seating = [0, 0, 1, 2];
    expect(verifyRecording(seating)).toMatchObject({ ok: false, error: expect.stringMatching(/seating/) });
    const result = structuredClone(dup);
    result.result.chips[0]! += 1;
    expect(verifyRecording(result).ok).toBe(false);
    const moved = structuredClone(dup);
    const [h, a] = find(moved, (x) => x.by === 'bot');
    const hand = moved.hands[h]!;
    let s = newHand({ stacks: hand.seating!.map(() => moved.cash!.stack), button: hand.button!, sb: moved.cash!.sb, bb: moved.cash!.bb, ante: moved.cash!.ante, deckSeed: hand.deckSeed! });
    for (const x of hand.actions.slice(0, a)) s = applyAction(s, x.key ? { key: x.key } : { kind: 'raise', to: x.to! });
    hand.actions[a]!.key = legalOptions(s).find((o) => o.key !== hand.actions[a]!.key)!.key as OptionKey;
    expect(verifyRecording(moved)).toMatchObject({ ok: false, error: expect.stringMatching(/the bot plays/) });
  });
});
