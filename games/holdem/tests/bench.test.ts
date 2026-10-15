// The benchmark: duplicate seating, a model played through a transport (answers, talk, every kind of fallback),
// baselines, verify (round trip and tampering), and the stats behind the leaderboard's extra columns.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBench } from '../../../packages/kit/bench/bench';
import { validateLeaderboard } from '../../../packages/kit/shared/contract';
import { REFUSAL } from '../../../packages/kit/shared/chat';
import type { DecideResponse, SystemOneRequest, Transport } from '../../../packages/kit/shared/systemone';
import game from '../game';
import { CASH, deadlineFor, FIELD, handSpec, HANDS, netByPlayer, playBench, resultOf, seedFor, summarize, verifyBench, type BenchRecording } from '../shared/bench';
import { formatCard } from '../shared/cards';
import { evaluate } from '../shared/evaluator';
import { applyAction, newHand, toAct, type OptionKey } from '../shared/engine';
import { QUESTION } from '../shared/questions';
import { replay, type RecordedAction, type Recording } from '../shared/recording';

const SEED = seedFor(0);
const respond = (answer: unknown, costUsd: number | null = 0.001): DecideResponse => ({ answers: { [QUESTION]: answer }, usage: { input_tokens: 0, output_tokens: 0 }, latencyMs: 5, costUsd, traceId: null });
const keysOf = (body: SystemOneRequest) => Object.keys(body.questions[QUESTION]!.criteria) as OptionKey[];
/** A calling station of a model: call when it can, else check; with probabilities for its tell meter. */
const caller: Transport = async (body) => {
  const keys = keysOf(body);
  const choice = keys.includes('call') ? 'call' : 'check';
  return respond({ type: 'choice', choice, probabilities: { [choice]: 0.8 } });
};

describe('duplicate seating', () => {
  it('plays every deal from every seat, each seat holding the same cards whoever sits there', () => {
    for (let d = 0; d < 30; d++) {
      const hands = [0, 1, 2, 3].map((r) => handSpec(SEED, d * 4 + r));
      const holes = hands.map((h) => newHand({ stacks: [200, 200, 200, 200], button: h.button, sb: 1, bb: 2, deckSeed: h.deckSeed }).seats.map((p) => p.hole.map(formatCard).join(' ')));
      for (const [r, h] of hands.entries()) {
        expect(h.deckSeed).toBe(hands[0]!.deckSeed);
        expect(h.button).toBe(d % 4);
        expect(holes[r]).toEqual(holes[0]);
        // The model in seat r, then rock, station and maniac round the table after it.
        expect(h.seating[r]).toBe(0);
        expect([1, 2, 3].map((k) => h.seating[(r + k) % 4])).toEqual([1, 2, 3]);
      }
      // Over the deal every player sits in every seat once.
      for (let player = 0; player < 4; player++) expect(new Set(hands.map((h) => h.seating.indexOf(player))).size).toBe(4);
    }
    // Deals differ, and so do games.
    expect(new Set(Array.from({ length: 30 }, (_, d) => handSpec(SEED, d * 4).deckSeed)).size).toBe(30);
    expect(handSpec(seedFor(1), 0).deckSeed).not.toBe(handSpec(SEED, 0).deckSeed);
  });
});

describe('a model played through its transport', () => {
  it('asks only at its turns with the state for its seat, and records its answers, cost and latency', async () => {
    const asked: SystemOneRequest[] = [];
    const { result, recording } = await playBench({ transport: (b, o) => (asked.push(b), caller(b, o)), seed: SEED, model: 'sference/clef' });
    expect(recording.hands).toHaveLength(HANDS);
    expect(recording.players).toEqual([{ kind: 'model', id: 'sference/clef' }, ...FIELD.map((id) => ({ kind: 'bot', id }))]);
    const mine = recording.hands.flatMap((h) => h.actions.filter((x) => h.seating![x.seat] === 0));
    expect(mine.length).toBe(asked.length);
    expect(mine.every((x) => x.by === 'answer' && x.costUsd === 0.001 && x.probabilities !== undefined)).toBe(true);
    expect(result).toMatchObject({ decisions: asked.length, calls: asked.length, fallbacks: 0, hands: HANDS });
    expect(result.cost).toBeCloseTo(0.001 * asked.length);
    // The state is the model's seat's: its own cards are there.
    expect((asked[0]!.state.you as { cards: string }).cards).toMatch(/^[2-9TJQKA][cdhs] [2-9TJQKA][cdhs]$/);
    expect(verifyBench(JSON.parse(JSON.stringify(recording)), SEED)).toMatchObject({ ok: true, result: { score: result.score, decisions: result.decisions } });
    expect(result.score).toBe(Math.round((10000 * result.netChips) / 2 / HANDS) / 100);
  });

  it("keeps a chat model's talk, mood and reasoning", async () => {
    const chat: Transport = async (body) => {
      const keys = keysOf(body);
      return respond({ type: 'choice', choice: keys.includes('check') ? 'check' : 'fold', say: 'Your move.', mood: 'smug', reasoning: 'Nothing worth a chip.' });
    };
    const { recording, result } = await playBench({ transport: chat, seed: SEED, model: 'aws/claude-haiku-5-5-eu', via: 'chat-adapter' });
    const first = recording.hands.flatMap((h) => h.actions).find((x) => x.by === 'answer')!;
    expect(first).toMatchObject({ say: 'Your move.', mood: 'smug', reasoning: 'Nothing worth a chip.' });
    expect(result.stats.vpip).toBe(0);
    expect(verifyBench(recording, SEED).ok).toBe(true);
  });

  it('plays the fallback for a late, failed, refused or invalid answer, and says why', async () => {
    let n = 0;
    const flaky: Transport = (body, opts) => {
      n++;
      const k = n % 6;
      if (k === 1) return new Promise<DecideResponse>((_, reject) => opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')))); // never answers
      if (k === 2) return Promise.reject(new Error('HTTP 502'));
      if (k === 3) return Promise.resolve(respond({ ...REFUSAL }));
      if (k === 4) return Promise.resolve(respond({ type: 'choice', choice: 'shove' }));
      if (k === 5) return Promise.resolve(respond(null));
      return caller(body, opts);
    };
    const errors: string[] = [];
    const { recording, result } = await playBench({ transport: flaky, seed: SEED, model: 'sference/clef', deadlineMs: 15, onError: (m) => errors.push(m) });
    const why = result.stats.why;
    expect(why.timeout).toBeGreaterThan(0);
    expect(why.error).toBeGreaterThan(0);
    expect(why.refusal).toBeGreaterThan(0);
    expect(why.invalid).toBeGreaterThan(0);
    expect(result.fallbacks).toBe(why.timeout + why.error + why.refusal + why.invalid);
    // A failed call says why; a late one is only late.
    expect(errors).toHaveLength(why.error);
    expect(new Set(errors)).toEqual(new Set(['HTTP 502']));
    expect(result.decisions).toBe(n);
    const late = recording.hands.flatMap((h) => h.actions).find((x) => x.why === 'timeout')!;
    expect(late).toMatchObject({ by: 'fallback', latencyMs: 15 });
    // A timed-out call is billed at the mean answered cost; the others at their own.
    const asked = recording.hands.flatMap((h) => h.actions.filter((x) => h.seating![x.seat] === 0));
    const priced = asked.filter((x) => x.costUsd !== undefined);
    expect(result.cost).toBeCloseTo(priced.length * 0.001 + why.timeout * 0.001, 9);
    expect(['check', 'fold']).toContain(late.key);
    // Verify recomputes every fallback: they are the rule's.
    expect(verifyBench(recording, SEED).ok).toBe(true);
    const extra = summarize([result]);
    expect(extra).toMatchObject({ refusals: why.refusal, 'invalid answers': why.invalid, timeouts: why.timeout, errors: why.error });
  });

  it('gives a chat model the 20 s time bank and a decision model 2.5 s', () => {
    expect(deadlineFor('aws/claude-haiku-5-5-eu')).toBe(20_000);
    expect(deadlineFor('my-model', 'chat-adapter')).toBe(20_000);
    expect(deadlineFor('sference/clef', 'systemone')).toBe(2500);
    expect(deadlineFor('my-endpoint')).toBe(2500);
    expect(game.timing).toMatchObject({ decisionTimeoutMs: 2500, chatTimeoutMs: 20_000 });
  });

  it('stops when told to', async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(playBench({ transport: caller, seed: SEED, model: 'm', signal: stop.signal })).rejects.toThrow(/stopped/);
  });
});

describe('baselines', () => {
  it('play each bot (and random) in the model seat, without a call, and verify', async () => {
    const never: Transport = async () => {
      throw new Error('a baseline makes no call');
    };
    const scores: Record<string, number> = {};
    for (const name of Object.keys(game.baselines!)) {
      const { result, recording } = await game.play({ transport: never, seed: SEED, signal: new AbortController().signal, model: `baseline/${name}` });
      expect(recording.players[0]).toEqual({ kind: 'bot', id: name });
      expect(result).toMatchObject({ calls: 0, fallbacks: 0, cost: 0 });
      const v = game.verify(JSON.parse(JSON.stringify(recording)), { seed: SEED });
      expect(v.ok).toBe(true);
      scores[name] = result.score;
    }
    expect(Object.keys(scores)).toEqual(['rock', 'station', 'maniac', 'random']);
    await expect(playBench({ transport: never, seed: SEED, model: 'baseline/shark' })).rejects.toThrow(/no baseline/);
  });
});

describe('verify', () => {
  const played = playBench({ transport: caller, seed: SEED, model: 'typesafe/jev-1.13.0' });
  const copy = async () => structuredClone((await played).recording);

  it('round-trips a recording, gzipped well within the limit', async () => {
    const { recording, result } = await played;
    const v = game.verify(JSON.parse(JSON.stringify(recording)), { seed: SEED });
    expect(v).toMatchObject({ ok: true, result });
    expect(gzipSync(JSON.stringify(recording)).length).toBeLessThan(game.rules.maxRecordingBytes);
  });

  it("names the game by its seed and moves only: the same games under another model's name are the same games", async () => {
    const rec = await copy();
    const renamed = await copy();
    renamed.players[0] = { kind: 'model', id: 'my-model' };
    renamed.bench.model = 'my-model';
    for (const h of renamed.hands) for (const x of h.actions) delete x.latencyMs;
    const [a, b] = [verifyBench(rec, SEED), verifyBench(renamed, SEED)];
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.fingerprint).toBe(a.fingerprint);
    const other = await playBench({ transport: caller, seed: seedFor(1), model: 'typesafe/jev-1.13.0' });
    const c = verifyBench(other.recording, seedFor(1));
    if (a.ok && c.ok) expect(c.fingerprint).not.toBe(a.fingerprint);
  });

  it('refuses another seed, another field, hands off their deal, bot moves and fallbacks not the rules, and a moved result', async () => {
    const cases: [(r: BenchRecording) => void, RegExp][] = [
      [(r) => (r.bench.version = 99), /version/],
      [(r) => (r.bench.seed = 1), /seed/],
      [(r) => ((r.players[1] as { id: string }).id = 'station'), /field/],
      // The benchmark stays 4-handed, though a Sit & Go now seats up to 6.
      [(r) => r.players.push({ kind: 'bot', id: 'rock' }), /field/],
      [(r) => r.players.push({ kind: 'bot', id: 'rock' }, { kind: 'bot', id: 'station' }), /field/],
      [(r) => r.players.pop(), /field/],
      [(r) => Object.assign(r, { mode: 'sitngo' }), /cash hands/],
      [(r) => (r.players[0] = { kind: 'bot', id: 'rock' }), /model under test/],
      [(r) => (r.players[0] = { kind: 'model', id: 'someone-else' }), /as bench.model names it/],
      [(r) => (r.cash = { ...CASH, stack: 400 }), /cash hands/],
      [(r) => r.hands.pop(), /120 hands/],
      [(r) => (r.hands[5]!.seating = [...r.hands[4]!.seating!]), /hand 6 is not deal 2, rotation 2/],
      [(r) => (r.hands[8]!.button = 3), /hand 9 is not deal 3/],
      [(r) => ([r.hands[0], r.hands[4]] = [r.hands[4]!, r.hands[0]!]), /hand 1 is not deal 1/],
      [(r) => (r.result.chips[0]! += 1), /claims/],
    ];
    for (const [edit, message] of cases) {
      const rec = await copy();
      edit(rec);
      expect(verifyBench(rec, SEED), String(message)).toMatchObject({ ok: false, error: expect.stringMatching(message) });
    }
    // A bot's move changed, or a model move marked as the fallback where the fallback plays otherwise.
    const rec = await copy();
    const hand = rec.hands.find((h) => h.actions.some((x) => x.by === 'bot' && x.key === 'fold'))!;
    hand.actions.find((x) => x.by === 'bot' && x.key === 'fold')!.key = 'call';
    expect(verifyBench(rec, SEED).ok).toBe(false);
    const rec2 = await copy();
    const call = rec2.hands.flatMap((h) => h.actions).find((x) => x.by === 'answer' && x.key === 'call')!;
    Object.assign(call, { by: 'fallback', why: 'timeout' });
    expect(verifyBench(rec2, SEED)).toMatchObject({ ok: false, error: expect.stringMatching(/fallback/) });
    expect(verifyBench(null, SEED).ok).toBe(false);
  });
});

/** A cash recording of hands with the model in seat 0 and the given moves for every seat (no strict checks: replay). */
function handBuilt(hands: { deckSeed: number; moves: OptionKey[] }[]): Recording {
  const rec: Recording = {
    format: 1,
    game: 'holdem',
    mode: 'cash',
    players: [{ kind: 'model', id: 'm' }, ...FIELD.map((id) => ({ kind: 'bot' as const, id }))],
    cash: { ...CASH },
    hands: hands.map((h) => {
      let s = newHand({ stacks: [200, 200, 200, 200], button: 3, sb: 1, bb: 2, deckSeed: h.deckSeed });
      const actions: RecordedAction[] = h.moves.map((key) => {
        const seat = toAct(s)!;
        s = applyAction(s, { key });
        return { seat, key, by: 'answer' };
      });
      return { deckSeed: h.deckSeed, button: 3, seating: [0, 1, 2, 3], actions };
    }),
    result: { chips: [0, 0, 0, 0] },
  };
  rec.result.chips = replay(rec).chips;
  return rec;
}

/** The first deck seed whose hands, each seat's on the full board, pass `test`. */
function deckWhere(test: (values: number[]) => boolean): number {
  for (let seed = 1; ; seed++) {
    const s = newHand({ stacks: [200, 200, 200, 200], button: 3, sb: 1, bb: 2, deckSeed: seed });
    const board = s.deck.slice(8, 13);
    if (test(s.seats.map((p) => evaluate([...p.hole, ...board])))) return seed;
  }
}

describe('the stats', () => {
  // Button 3: seat 0 is the small blind, 1 the big blind, 2 UTG acts first before the flop; seat 0 first after it.
  it('count VPIP, PFR, fold to a 3-bet, aggression, showdowns and bluffs as defined', () => {
    const loses = deckWhere((v) => v[0]! < v[1]! && v[0]! > v[2]! && v[0]! > v[3]!);
    const wins = deckWhere((v) => v[0]! > Math.max(v[1]!, v[2]!, v[3]!));
    const rec = handBuilt([
      // 1. UTG and the button fold, seat 0 opens, the big blind 3-bets, seat 0 folds: VPIP, PFR, a 3-bet faced and folded to.
      { deckSeed: 1, moves: ['fold', 'fold', 'small', 'pot', 'fold'] },
      // 2. Seat 0 completes; to the river checked; seat 0 bets the river with the worse hand and the big blind calls:
      //    VPIP, saw the flop, a river bet that is a bluff, a showdown lost.
      { deckSeed: loses, moves: ['fold', 'fold', 'call', 'check', 'check', 'check', 'check', 'check', 'pot', 'call'] },
      // 3. The best hand: seat 0 bets the flop and the river and is called: two bets, a river value bet, a showdown won.
      { deckSeed: wins, moves: ['fold', 'fold', 'call', 'check', 'pot', 'call', 'check', 'check', 'half', 'call'] },
      // 4. Seat 0 folds its small blind: nothing but a hand.
      { deckSeed: 7, moves: ['fold', 'fold', 'fold'] },
    ]);
    const r = resultOf(rec, replay(rec));
    expect(r.stats).toMatchObject({ hands: 4, vpip: 3, pfr: 1, faced3bet: 1, foldedTo3bet: 1, sawFlop: 2, showdowns: 2, wonAtShowdown: 1, bluffSpots: 2, bluffs: 1, aggressive: 3, calls: 0 });
    const extra = summarize([r, r]);
    expect(extra).toMatchObject({ hands: 8, 'VPIP %': 75, 'PFR %': 25, 'Fold to 3-bet %': 100, 'Went to showdown %': 100, 'Won at showdown %': 50, 'Bluff rate %': 50, 'Aggression factor': '∞', 'Fallback %': 0 });
    // bb/100 against each bot adds up to the score.
    const parts = FIELD.reduce((a, b) => a + (extra[`bb/100 vs ${b}`] as number), 0);
    expect(parts).toBeCloseTo(r.score, 1);
  });

  it('split every hand of a game into chips won from each player, adding up to the net', async () => {
    const { recording, result } = await playBench({ transport: caller, seed: seedFor(2), model: 'm' });
    for (const hand of recording.hands) {
      let s = newHand({ stacks: [200, 200, 200, 200], button: hand.button!, sb: 1, bb: 2, deckSeed: hand.deckSeed! });
      for (const x of hand.actions) s = applyAction(s, { key: x.key! });
      for (let seat = 0; seat < 4; seat++) {
        const parts = netByPlayer(s, seat);
        expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(s.seats[seat]!.stack - s.seats[seat]!.start, 6);
      }
    }
    const fromBots = Object.values(result.stats.vs).reduce((a, b) => a + b, 0);
    expect(fromBots).toBeCloseTo(result.netChips, 6);
  });
});

describe('through the bench', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("plays a chat model through Opper's chat completions with the game's schema, and writes its row with the extra columns", async () => {
    const bodies: { model: string; reasoning_effort?: string; response_format: { json_schema: { schema: { properties: { action: { enum: string[] } } } } } }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe('https://api.opper.ai/v3/compat/chat/completions');
        const body = JSON.parse(init.body as string);
        bodies.push(body);
        const keys = body.response_format.json_schema.schema.properties.action.enum as string[];
        const action = keys.includes('call') ? 'call' : keys.includes('check') ? 'check' : keys[0];
        const content = JSON.stringify({ action, say: 'I call.', mood: 'relaxed', reasoning: 'Cheap enough.' });
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 900, completion_tokens: 60 } }), { headers: { 'x-opper-cost': '0.0002' } });
      }),
    );
    const publicDir = mkdtempSync(join(tmpdir(), 'holdem-bench-'));
    const lines: string[] = [];
    await runBench(game as never, ['--model', 'aws/claude-haiku-5-5-eu', '--games', '1', '--leaderboard', '--out', join(publicDir, 'leaderboard.json')], { OPPER_API_KEY: 'op-test' }, { publicDir }, (l) => lines.push(l));
    const board = JSON.parse(readFileSync(join(publicDir, 'leaderboard.json'), 'utf8'));
    expect(validateLeaderboard(board, 'holdem')).toEqual([]);
    const [entry] = board.entries;
    expect(entry).toMatchObject({ model: 'aws/claude-haiku-5-5-eu', name: 'Haiku 5.5', via: 'chat-adapter', games: 1, fallbackRate: 0 });
    expect(entry.extra).toMatchObject({ hands: 120, 'Fallback %': 0, refusals: 0 });
    expect(entry.extra['VPIP %']).toBeGreaterThan(50);
    // The warm-up, then one call per decision, each at low reasoning effort.
    expect(bodies.length).toBeGreaterThan(100);
    expect(bodies.every((b) => b.model === 'aws/claude-haiku-5-5-eu' && b.reasoning_effort === 'low')).toBe(true);
    expect(entry.costPerGame).toBeCloseTo(0.0002 * (bodies.length - 1), 4);
  });
});
