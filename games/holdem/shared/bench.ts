// AI Hold'em's benchmark (the plan's "Benchmark"): duplicate cash hands against the three scripted bots. One game is
// 30 deals x 4 seat rotations = 120 hands, 4-handed, blinds 1/2, every stack reset to 100 big blinds each hand. Deal d
// has its own deck seed and button; rotation r puts the model under test in seat r and the bots round the table after
// it in a fixed order (rock, station, maniac), so over a deal's four hands every player holds every seat's cards once:
// the card luck cancels and what is left is decision quality. Score: big blinds won per 100 hands (bb/100).
//
// The model is asked through `requestFor` (questions.ts) at each of its turns and has DECISION_TIMEOUT_MS (decision
// models) or CHAT_TIMEOUT_MS (chat models) to answer; a late, failed, refused or invalid answer is played by the
// fallback (check if free, else fold) and recorded as such, with why. Bots are recomputed by verify. Isomorphic.
import type { Entry } from '../../../packages/kit/shared/contract.ts';
import type { GameResult, Verdict } from '../../../packages/kit/shared/game.ts';
import type { SystemOneRequest, Transport } from '../../../packages/kit/shared/systemone.ts';
import { botDecide, fallbackKey, isBotName, type BotName } from './bots.ts';
import { evaluate } from './evaluator.ts';
import { applyAction, newHand, observe, potsOf, toAct, type HandState, type OptionKey, type Street } from './engine.ts';
import { CHAT_TIMEOUT_MS, DECISION_TIMEOUT_MS, holdemModel } from './models.ts';
import { readAnswer, requestFor } from './questions.ts';
import { verifyRecording, type FallbackReason, type Player, type RecordedAction, type RecordedHand, type Recording, type ReplayResult } from './recording.ts';
import { deriveSeed, hashText } from './rng.ts';

/** Bump when the rules, the field or the question change: older submissions are then refused. */
export const BENCH_VERSION = 1;
export const DEALS = 30;
export const SEATS = 4;
export const HANDS = DEALS * SEATS;
/** 100 big blinds at 1/2. */
export const CASH = { stack: 200, sb: 1, bb: 2, ante: 0 } as const;
/** The bots the model plays against, in the order they sit after it. */
export const FIELD: readonly BotName[] = ['rock', 'station', 'maniac'];

/** Game i's seed (from 0), as snake's: the golden-ratio multiple of i + 1, as a 31-bit number. */
export const seedFor = (i: number): number => Math.imul(i + 1, 0x9e3779b1) >>> 1;

/** Hand h of a game (from 0): deal h / 4 with its deck seed and button, rotation h % 4 (the model's seat). */
export function handSpec(seed: number, h: number): { deckSeed: number; button: number; seating: number[] } {
  const deal = Math.floor(h / SEATS);
  const rotation = h % SEATS;
  // seat -> player: the model (player 0) in seat `rotation`, then rock, station and maniac round the table after it.
  return { deckSeed: deriveSeed(seed, deal), button: deal % SEATS, seating: Array.from({ length: SEATS }, (_, seat) => (seat - rotation + SEATS) % SEATS) };
}

/** A benchmark game's recording: the duplicate cash hands, and which game it is. */
export interface BenchRecording extends Recording {
  bench: { version: number; seed: number; model: string };
}

/** Numbers summed over a model's hands, from which `summarize` makes its percentages (counts, so games add up). */
export interface HoldemStats {
  hands: number;
  /** Hands it put chips in voluntarily before the flop, and hands it raised before the flop. */
  vpip: number;
  pfr: number;
  /** After the flop: bets and raises (all-ins that raise included), and calls. */
  aggressive: number;
  calls: number;
  /** Times its open raise met a 3-bet with it to act, and how often it folded then. */
  faced3bet: number;
  foldedTo3bet: number;
  /** Hands it saw the flop, went to showdown, and won (some of) the pot at showdown. */
  sawFlop: number;
  showdowns: number;
  wonAtShowdown: number;
  /** River bets and raises plus all-in bets and raises on any street, and those made with a hand that was beaten. */
  bluffSpots: number;
  bluffs: number;
  /** Net chips won from each bot, pot by pot (see netByPlayer); they add up to the model's net. */
  vs: Record<string, number>;
  /** The fallback's moves by reason. */
  why: Record<FallbackReason, number>;
}

export interface HoldemResult extends GameResult {
  /** Net chips won over the game's hands, and the hands. */
  netChips: number;
  hands: number;
  stats: HoldemStats;
}

const emptyStats = (): HoldemStats => ({ hands: 0, vpip: 0, pfr: 0, aggressive: 0, calls: 0, faced3bet: 0, foldedTo3bet: 0, sawFlop: 0, showdowns: 0, wonAtShowdown: 0, bluffSpots: 0, bluffs: 0, vs: Object.fromEntries(FIELD.map((b) => [b, 0])), why: { timeout: 0, error: 0, invalid: 0, refusal: 0 } });

/**
 * Chips that went from each player to each other one in a finished hand, pot by pot: a pot's winners take each
 * contributor's chips in it in proportion to their shares (the uncalled bet went back before). Returns, for `seat`,
 * the net chips won from every other seat; their sum is the seat's net for the hand.
 */
export function netByPlayer(s: HandState, seat: number): number[] {
  const committed = s.seats.map((p) => p.committed);
  const awards = s.events.flatMap((e) => (e.type === 'award' ? [e] : []));
  const showdown = s.events.some((e) => e.type === 'showdown');
  // The pots as the engine built them: potsOf's levels at a showdown, one pot of everything otherwise.
  let levels: number[];
  if (showdown) {
    levels = [...new Set(s.seats.filter((p) => p.status === 'allin').map((p) => p.committed))];
    levels.push(Math.max(...committed));
    levels = [...new Set(levels)].sort((a, b) => a - b);
  } else levels = [Math.max(...committed)];
  const contributions: number[][] = [];
  let prev = 0;
  for (const level of levels) {
    const share = committed.map((c) => Math.min(c, level) - Math.min(c, prev));
    if (share.some((x) => x > 0)) contributions.push(share);
    prev = level;
  }
  if (showdown && contributions.length !== potsOf(s).length) throw new Error('pot split does not match the engine');
  const net = s.seats.map(() => 0);
  for (const a of awards) {
    const from = contributions[a.pot]!;
    a.winners.forEach((w, k) => {
      const part = a.shares[k]! / a.amount;
      from.forEach((c, i) => {
        if (i === w) return;
        if (w === seat) net[i]! += c * part;
        if (i === seat) net[w]! -= c * part;
      });
    });
  }
  return net;
}

/** Plays one recorded hand through the engine, adding the model's numbers (player 0) to `st`. Returns the end state. */
function analyseHand(spec: RecordedHand, rec: Recording, st: HoldemStats): HandState {
  let s = newHand({ stacks: spec.seating!.map(() => rec.cash!.stack), button: spec.button!, sb: rec.cash!.sb, bb: rec.cash!.bb, ante: rec.cash!.ante, deckSeed: spec.deckSeed! });
  const me = spec.seating!.indexOf(0);
  const live = s.seats.filter((p) => p.status !== 'empty').length;
  const board = s.deck.slice(2 * live, 2 * live + 5);
  let vpip = false;
  let pfr = false;
  let opened = false;
  let faced = false;
  let foldStreet: Street | null = null;
  for (const x of spec.actions) {
    const seat = toAct(s)!;
    if (seat === me) {
      const street = s.street as Street;
      const raises = x.key !== undefined && x.key !== 'fold' && x.key !== 'check' && x.key !== 'call' && (x.key !== 'allin' || s.seats[me]!.bet + s.seats[me]!.stack > s.currentBet);
      if (street === 'preflop') {
        if (opened && !faced && s.raises === 2) {
          faced = true;
          st.faced3bet += 1;
          if (x.key === 'fold') st.foldedTo3bet += 1;
        }
        if (x.key === 'call' || raises) vpip = true;
        if (raises) {
          pfr = true;
          if (s.raises === 0) opened = true;
        }
      } else if (raises) st.aggressive += 1;
      else if (x.key === 'call') st.calls += 1;
      if (raises && (street === 'river' || x.key === 'allin')) {
        st.bluffSpots += 1;
        const mine = evaluate([...s.seats[me]!.hole, ...board]);
        if (s.seats.some((p, i) => i !== me && (p.status === 'active' || p.status === 'allin') && evaluate([...p.hole, ...board]) > mine)) st.bluffs += 1;
      }
      if (x.key === 'fold') foldStreet = street;
      if (x.by === 'fallback' && x.why) st.why[x.why] += 1;
    }
    s = applyAction(s, x.key !== undefined ? { key: x.key } : { kind: 'raise', to: x.to! });
  }
  st.hands += 1;
  if (vpip) st.vpip += 1;
  if (pfr) st.pfr += 1;
  if (s.events.some((e) => e.type === 'street' && e.street === 'flop') && foldStreet !== 'preflop') st.sawFlop += 1;
  const shown = s.events.find((e) => e.type === 'showdown');
  if (shown && shown.type === 'showdown' && shown.hands.some((h) => h.seat === me)) {
    st.showdowns += 1;
    if (s.events.some((e) => e.type === 'award' && e.winners.includes(me))) st.wonAtShowdown += 1;
  }
  netByPlayer(s, me).forEach((n, seat) => {
    if (seat === me) return;
    const name = rec.players[spec.seating![seat]!]!.id;
    st.vs[name] = (st.vs[name] ?? 0) + n;
  });
  return s;
}

/**
 * What the model's calls cost: the answered calls' own costs, and a timed-out call (cancelled, so its cost is unknown,
 * though it is billed) at the mean of those, as snake bills a cancelled call.
 */
function costOf(asked: readonly RecordedAction[]): number {
  const known = asked.filter((x) => x.costUsd !== undefined);
  const sum = known.reduce((a, x) => a + x.costUsd!, 0);
  const late = asked.filter((x) => x.why === 'timeout').length;
  return known.length ? sum + (late * sum) / known.length : 0;
}

/** A benchmark recording's result for the model (player 0), from the recording and its replay. */
export function resultOf(rec: Recording, replayed: ReplayResult): HoldemResult {
  const stats = emptyStats();
  for (const hand of rec.hands) analyseHand(hand, rec, stats);
  const mine = rec.hands.flatMap((hand) => hand.actions.filter((x) => hand.seating![x.seat] === 0));
  const asked = mine.filter((x) => x.by === 'answer' || x.by === 'fallback');
  const netChips = replayed.chips[0]!;
  return {
    score: Math.round((10000 * netChips) / rec.cash!.bb / rec.hands.length) / 100,
    calls: asked.length,
    latencyMsSum: asked.reduce((a, x) => a + (x.latencyMs ?? 0), 0),
    cost: costOf(asked),
    decisions: mine.length,
    fallbacks: mine.filter((x) => x.by === 'fallback').length,
    netChips,
    hands: rec.hands.length,
    stats,
  };
}

/** The model's side of one decision: its move, or the fallback's, with what the call took and cost. */
interface Settled {
  action: Omit<RecordedAction, 'seat'>;
}

/** Asks the model about the seat to act, waiting at most `deadlineMs`; anything but a legal answer in time is the fallback's. */
export async function askModel(transport: Transport, s: HandState, deadlineMs: number, now: () => number, onError?: (message: string) => void): Promise<Settled> {
  const seat = toAct(s)!;
  const o = observe(s, seat);
  const keys = o.options.map((x) => x.key);
  const fallback = (why: FallbackReason, latencyMs: number, costUsd?: number): Settled => ({ action: { key: fallbackKey(o.options), by: 'fallback', why, latencyMs, ...(costUsd ? { costUsd } : {}) } });
  const body: SystemOneRequest = requestFor(o);
  const controller = new AbortController();
  const started = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('late');
    }, deadlineMs);
  });
  try {
    const res = await Promise.race([transport(body, { signal: controller.signal }), late]);
    const latencyMs = Math.min(deadlineMs, Math.max(0, Math.round(now() - started)));
    if (res === 'late') return fallback('timeout', deadlineMs);
    const costUsd = typeof res.costUsd === 'number' && Number.isFinite(res.costUsd) && res.costUsd > 0 ? Math.min(1, res.costUsd) : undefined;
    const read = readAnswer(res.answers[Object.keys(body.questions)[0]!], keys);
    if ('why' in read) return fallback(read.why, latencyMs, costUsd);
    return { action: { key: read.key, by: 'answer', latencyMs, ...(costUsd ? { costUsd } : {}), ...(read.probabilities ? { probabilities: read.probabilities } : {}), ...(read.say !== undefined ? { say: read.say } : {}), ...(read.mood ? { mood: read.mood } : {}), ...(read.reasoning !== undefined ? { reasoning: read.reasoning } : {}) } };
  } catch (err) {
    const latencyMs = Math.min(deadlineMs, Math.max(0, Math.round(now() - started)));
    if (controller.signal.aborted) return fallback('timeout', latencyMs);
    onError?.(String((err as Error)?.message ?? err).slice(0, 300));
    return fallback('error', latencyMs);
  } finally {
    clearTimeout(timer);
  }
}

/** How long the model may take per decision: a chat model's time bank, else the decision models' 2.5 s. */
export const deadlineFor = (model: string, via?: Entry['via']): number => (via === 'chat-adapter' || holdemModel(model)?.kind === 'chat' ? CHAT_TIMEOUT_MS : DECISION_TIMEOUT_MS);

/**
 * Plays one benchmark game: `model` through `transport`, or, for `baseline/<bot>`, that bot in the model's seat.
 * Resolves with the recording and its result.
 */
export async function playBench(o: { transport: Transport; seed: number; model: string; via?: Entry['via']; signal?: AbortSignal; now?: () => number; deadlineMs?: number; onError?: (message: string) => void }): Promise<{ result: HoldemResult; recording: BenchRecording }> {
  const now = o.now ?? (() => performance.now());
  const baseline = o.model.startsWith('baseline/') ? o.model.slice('baseline/'.length) : null;
  if (baseline !== null && !isBotName(baseline)) throw new Error(`no baseline ${o.model}`);
  const players: Player[] = [baseline ? { kind: 'bot', id: baseline } : { kind: 'model', id: o.model.slice(0, 120) }, ...FIELD.map((id): Player => ({ kind: 'bot', id }))];
  const deadline = o.deadlineMs ?? deadlineFor(o.model, o.via);
  const hands: RecordedHand[] = [];
  const chips = players.map(() => 0);
  for (let h = 0; h < HANDS; h++) {
    if (o.signal?.aborted) throw new Error('the game was stopped');
    const spec = handSpec(o.seed, h);
    let s = newHand({ stacks: spec.seating.map(() => CASH.stack), button: spec.button, sb: CASH.sb, bb: CASH.bb, ante: CASH.ante, deckSeed: spec.deckSeed });
    const actions: RecordedAction[] = [];
    while (toAct(s) !== null) {
      const seat = toAct(s)!;
      const player = players[spec.seating[seat]!]!;
      let action: Omit<RecordedAction, 'seat'>;
      if (player.kind === 'bot') action = { key: botDecide(player.id as BotName, observe(s, seat)), by: 'bot' };
      else action = (await askModel(o.transport, s, deadline, now, o.onError)).action;
      actions.push({ seat, ...action });
      s = applyAction(s, { key: action.key as OptionKey });
    }
    s.seats.forEach((p, seat) => (chips[spec.seating[seat]!]! += p.stack - p.start));
    hands.push({ ...spec, actions });
  }
  const recording: BenchRecording = { format: 1, game: 'holdem', mode: 'cash', players, cash: { ...CASH }, hands, result: { chips }, bench: { version: BENCH_VERSION, seed: o.seed, model: o.model } };
  const verdict = verifyRecording(recording);
  if (!verdict.ok) throw new Error(`the game does not replay: ${verdict.error}`);
  return { recording, result: resultOf(recording, verdict.result) };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Checks a benchmark recording for game `seed`: a valid recording (every action legal, bots and fallbacks recomputed,
 * the result the replay's) of exactly this benchmark: the blinds and stacks, the field, and every hand on its deal,
 * button and seating. Recomputes the result.
 */
export function verifyBench(raw: unknown, seed: number): Verdict<HoldemResult> {
  if (!isObj(raw) || !isObj(raw.bench)) return { ok: false, error: "not an AI Hold'em benchmark recording" };
  const bench = raw.bench;
  if (bench.version !== BENCH_VERSION) return { ok: false, error: `played on benchmark version ${String(bench.version)}, not ${BENCH_VERSION}` };
  if (bench.seed !== seed) return { ok: false, error: `played seed ${String(bench.seed)}, not ${seed}` };
  if (typeof bench.model !== 'string') return { ok: false, error: 'bench.model must name the model' };
  // What this benchmark plays, checked before the replay so a recording of something else says so.
  if (raw.mode !== 'cash' || !sameJson(raw.cash, CASH)) return { ok: false, error: `the benchmark plays cash hands at ${CASH.sb}/${CASH.bb} with ${CASH.stack} chips` };
  const players = Array.isArray(raw.players) ? raw.players : [];
  if (players.length !== SEATS || !sameJson(players.slice(1), FIELD.map((id) => ({ kind: 'bot', id })))) return { ok: false, error: `the field is the model then ${FIELD.join(', ')}` };
  const p0: unknown = players[0];
  const baseline = bench.model.startsWith('baseline/');
  if (!isObj(p0) || (baseline ? !(p0.kind === 'bot' && `baseline/${String(p0.id)}` === bench.model) : !(p0.kind === 'model' && p0.id === bench.model.slice(0, 120)))) return { ok: false, error: 'player 1 must be the model under test, as bench.model names it' };
  const hands = Array.isArray(raw.hands) ? raw.hands : [];
  if (hands.length !== HANDS) return { ok: false, error: `a game is ${HANDS} hands, not ${hands.length}` };
  for (let h = 0; h < HANDS; h++) {
    const want = handSpec(seed, h);
    const hand: unknown = hands[h];
    if (!isObj(hand) || hand.deckSeed !== want.deckSeed || hand.button !== want.button || !sameJson(hand.seating, want.seating)) return { ok: false, error: `hand ${h + 1} is not deal ${Math.floor(h / SEATS) + 1}, rotation ${(h % SEATS) + 1} of seed ${seed}` };
  }
  const v = verifyRecording(raw);
  if (!v.ok) return v;
  const rec = raw as unknown as BenchRecording;
  // The game played is its seed and its moves: no name in it, so the same games sent again under another name are caught.
  const fingerprint = hashText(`holdem-bench:${seed}|${rec.hands.map((h) => h.actions.map((x) => `${x.seat}${x.key}`).join(' ')).join('|')}`);
  return { ok: true, result: resultOf(rec, v.result), fingerprint };
}

const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : 0);

/**
 * A model's games as its leaderboard row's extra numbers. Percentages are of hands unless said: VPIP and PFR; the
 * aggression factor (bets and raises over calls after the flop); fold to a 3-bet (of the times its open raise was
 * re-raised); went to showdown (of hands it saw the flop) and won at showdown (of its showdowns); bluff rate (of its
 * river bets and raises and its all-in bets and raises, those made with a hand that loses to a player still in once
 * the board is run out); bb/100 won from each bot (pot by pot, adding up to the score); and the fallback's share.
 */
export function summarize(results: readonly HoldemResult[]): Record<string, number | string> {
  const t = emptyStats();
  let decisions = 0;
  let fallbacks = 0;
  for (const r of results) {
    const s = r.stats;
    for (const k of ['hands', 'vpip', 'pfr', 'aggressive', 'calls', 'faced3bet', 'foldedTo3bet', 'sawFlop', 'showdowns', 'wonAtShowdown', 'bluffSpots', 'bluffs'] as const) t[k] += s[k];
    for (const [b, n] of Object.entries(s.vs)) t.vs[b] = (t.vs[b] ?? 0) + n;
    for (const k of Object.keys(t.why) as FallbackReason[]) t.why[k] += s.why[k];
    decisions += r.decisions;
    fallbacks += r.fallbacks;
  }
  const bb100 = (chips: number) => (t.hands ? Math.round((10000 * chips) / CASH.bb / t.hands) / 100 : 0);
  return {
    hands: t.hands,
    'VPIP %': pct(t.vpip, t.hands),
    'PFR %': pct(t.pfr, t.hands),
    // Bets and raises with no call to set them against: an endless factor, shown as such.
    'Aggression factor': t.calls ? Math.round((100 * t.aggressive) / t.calls) / 100 : t.aggressive ? '∞' : 0,
    'Fold to 3-bet %': pct(t.foldedTo3bet, t.faced3bet),
    'Went to showdown %': pct(t.showdowns, t.sawFlop),
    'Won at showdown %': pct(t.wonAtShowdown, t.showdowns),
    'Bluff rate %': pct(t.bluffs, t.bluffSpots),
    ...Object.fromEntries(FIELD.map((b) => [`bb/100 vs ${b}`, bb100(t.vs[b] ?? 0)])),
    'Fallback %': pct(fallbacks, decisions),
    refusals: t.why.refusal,
    'invalid answers': t.why.invalid,
    timeouts: t.why.timeout,
    errors: t.why.error,
  };
}
