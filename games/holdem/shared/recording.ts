// What a played game of AI Hold'em records, how it is replayed, and the rules a recording is checked against (the
// plan's "Benchmark", "Verify"). A recording is the table's config and its deal (a Sit & Go's table key, a cash hand's
// deck seed) plus every action in order: the engine deals the cards from them, so the actions alone replay the game. Each action says who made it: a model's
// answer, the fallback (when the model or human did not answer in time), a bot, or a human. Per-action metadata (table
// talk, mood, reasoning, latency, probabilities) is kept for the review but plays no part in the replay or the
// fingerprint. Isomorphic: verify runs in the bench, the service and the browser alike.
import { botDecide, fallbackKey, isBotName, type BotName } from './bots.ts';
import { applyAction, isOptionKey, legalOptions, newHand, observe, toAct, type Action, type HandEvent, type HandState, type OptionKey } from './engine.ts';
import { hashText, isTableKey } from './rng.ts';
import { actSitAndGo, MAX_SEATS, newSitAndGo, nextHand, type SitAndGo } from './sitngo.ts';

export type PlayerKind = 'model' | 'bot' | 'human';
/** Who plays: a model by its id, a bot by its name (bots.ts), a human by any name. */
export interface Player {
  kind: PlayerKind;
  id: string;
}

export type By = 'answer' | 'fallback' | 'bot' | 'human';
export type Mood = 'relaxed' | 'confident' | 'nervous' | 'annoyed' | 'smug';
/** Why a model's move fell back: no answer in time, a failed call, an answer that was no legal option, or a refusal. */
export type FallbackReason = 'timeout' | 'error' | 'invalid' | 'refusal';
export const FALLBACK_REASONS: readonly FallbackReason[] = ['timeout', 'error', 'invalid', 'refusal'];
export const MOODS: readonly Mood[] = ['relaxed', 'confident', 'nervous', 'annoyed', 'smug'];

export interface RecordedAction {
  seat: number;
  /** A menu option, or (humans only) `to`: a raise to that street total. */
  key?: OptionKey;
  to?: number;
  by: By;
  // Metadata, ignored by the replay and the fingerprint:
  latencyMs?: number;
  /** What the model call cost, in USD, when the model was asked. */
  costUsd?: number;
  /** A fallback only: why the model's move fell back. */
  why?: FallbackReason;
  /** A chat model's table talk. */
  say?: string;
  mood?: Mood;
  /** A chat model's reasoning, shown only after the hand. */
  reasoning?: string;
  /** A decision model's probabilities over the options (its tell meter). */
  probabilities?: Partial<Record<OptionKey, number>>;
}

/** A line of table talk a human typed (a model's talk is its action's `say`): who, after how many of the hand's actions. */
export interface TalkLine {
  seat: number;
  /** The hand's actions played before it was said. */
  after: number;
  say: string;
}

export interface RecordedHand {
  /** Cash only: the hand's deck seed, button, and seating (seat -> index into players). */
  deckSeed?: number;
  button?: number;
  seating?: number[];
  actions: RecordedAction[];
  /** Metadata, ignored by the replay and the fingerprint: what the human said at the table, in order. */
  talk?: TalkLine[];
}

export interface Recording {
  format: 1;
  game: 'holdem';
  /**
   * sitngo: one Sit & Go of 2 to 6, players[i] in seat i. cash: independent hands with stacks reset, e.g. duplicate
   * deals (the benchmark's are 4-handed: bench.ts verifyBench refuses any other field).
   */
  mode: 'sitngo' | 'cash';
  players: Player[];
  /** The table key (64 hex digits, rng.ts) deals every hand of a Sit & Go. */
  sitngo?: { key: string; startingStack: number };
  cash?: { stack: number; sb: number; bb: number; ante: number };
  hands: RecordedHand[];
  /** What the game claims, per player: final chips (sitngo) or net chips won (cash), and places (sitngo). */
  result: { chips: number[]; places?: number[] };
}

export interface HandResult {
  /** seat -> player index. */
  seating: number[];
  events: HandEvent[];
  /** Chips won or lost per seat. */
  net: number[];
}

export interface ReplayResult {
  hands: HandResult[];
  /** Per player: final chips (sitngo) or net chips won (cash). */
  chips: number[];
  /** Per player, sitngo only. */
  places: number[] | null;
}

export type RecordingVerdict = { ok: true; result: ReplayResult; fingerprint: string } | { ok: false; error: string };

/**
 * Far above any real game: a Sit & Go takes 40 to 80 hands, a hand a few dozen actions (more only when humans
 * min-raise each other with deep stacks).
 */
const MAX_HANDS = 2000;
const MAX_ACTIONS = 10_000;
const MAX_TOTAL_ACTIONS = 200_000;
const MAX_LATENCY_MS = 600_000;
const MAX_SAY = 200;
/** A human's lines in one hand, far above what anyone types. */
const MAX_TALK = 500;
const MAX_REASONING = 4000;
const ACTION_FIELDS = ['seat', 'key', 'to', 'by', 'latencyMs', 'costUsd', 'why', 'say', 'mood', 'reasoning', 'probabilities'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min = -(2 ** 31), max = 2 ** 31 - 1): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const within = (v: unknown, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;

/** Why a recorded action is malformed, or null. */
function actionProblem(x: unknown): string | null {
  if (!isObj(x)) return 'not an object';
  if (Object.keys(x).some((k) => !ACTION_FIELDS.includes(k))) return 'unknown fields';
  if (!isInt(x.seat, 0, 9)) return 'seat must be 0 to 9';
  if (x.by !== 'answer' && x.by !== 'fallback' && x.by !== 'bot' && x.by !== 'human') return 'by must be answer, fallback, bot or human';
  if ((x.key === undefined) === (x.to === undefined)) return 'an action needs a key or a raise to an amount, not both';
  if (x.key !== undefined && !isOptionKey(x.key)) return `key must be one of fold, check, call, small, half, three_quarters, pot, allin`;
  if (x.to !== undefined && (x.by !== 'human' || !isInt(x.to, 1))) return 'only a human raises to an amount of its own, in whole chips';
  if (x.latencyMs !== undefined && !within(x.latencyMs, MAX_LATENCY_MS)) return 'a negative or impossible latency';
  if (x.costUsd !== undefined && !within(x.costUsd, 1)) return 'a call costs 0 to 1 USD';
  if (x.why !== undefined && (x.by !== 'fallback' || !FALLBACK_REASONS.includes(x.why as FallbackReason))) return `why is for a fallback only: one of ${FALLBACK_REASONS.join(', ')}`;
  if (x.say !== undefined && !(typeof x.say === 'string' && x.say.length <= MAX_SAY)) return `say must be text of at most ${MAX_SAY} characters`;
  if (x.mood !== undefined && !MOODS.includes(x.mood as Mood)) return `mood must be one of ${MOODS.join(', ')}`;
  if (x.reasoning !== undefined && !(typeof x.reasoning === 'string' && x.reasoning.length <= MAX_REASONING)) return `reasoning must be text of at most ${MAX_REASONING} characters`;
  if (x.probabilities !== undefined && !(isObj(x.probabilities) && Object.entries(x.probabilities).every(([k, p]) => isOptionKey(k) && within(p, 1)))) return 'probabilities must map option keys to 0 to 1';
  return null;
}

/** Why a recording's shape is wrong, or null (the replay checks the rest). */
function shapeProblem(r: Record<string, unknown>): string | null {
  if (r.format !== 1 || r.game !== 'holdem') return "not a format 1 AI Hold'em recording";
  if (r.mode !== 'sitngo' && r.mode !== 'cash') return 'mode must be sitngo or cash';
  const players = r.players;
  const most = r.mode === 'sitngo' ? MAX_SEATS : 10;
  if (!Array.isArray(players) || players.length < 2 || players.length > most) return `players must list 2 to ${most} players`;
  for (let i = 0; i < players.length; i++) {
    const p: unknown = players[i];
    if (!isObj(p) || (p.kind !== 'model' && p.kind !== 'bot' && p.kind !== 'human')) return `player ${i + 1}: kind must be model, bot or human`;
    if (typeof p.id !== 'string' || !p.id || p.id.length > 120) return `player ${i + 1}: id must be text`;
    if (p.kind === 'bot' && !isBotName(p.id)) return `player ${i + 1}: ${p.id.slice(0, 20)} is not a bot`;
  }
  if (r.mode === 'sitngo') {
    const c = r.sitngo;
    if (!isObj(c) || !isTableKey(c.key)) return 'sitngo.key must be a table key: 64 lowercase hex digits';
    if (!isInt(c.startingStack, 1, 1e9)) return 'sitngo.startingStack must be a whole number of chips';
  } else {
    const c = r.cash;
    if (!isObj(c) || !isInt(c.stack, 1, 1e9) || !isInt(c.sb, 1, 1e9) || !isInt(c.bb, 1, 1e9) || c.sb > c.bb || !isInt(c.ante, 0, 1e9)) return 'cash must give a stack, blinds (small at most big) and an ante in whole chips';
  }
  if (!Array.isArray(r.hands) || r.hands.length < 1 || r.hands.length > MAX_HANDS) return `hands must list 1 to ${MAX_HANDS} hands`;
  if (r.hands.reduce((a: number, h: unknown) => a + (isObj(h) && Array.isArray(h.actions) ? h.actions.length : 0), 0) > MAX_TOTAL_ACTIONS) return `a recording holds at most ${MAX_TOTAL_ACTIONS} actions`;
  for (let h = 0; h < r.hands.length; h++) {
    const hand: unknown = r.hands[h];
    if (!isObj(hand) || !Array.isArray(hand.actions) || hand.actions.length > MAX_ACTIONS) return `hand ${h + 1}: actions must list at most ${MAX_ACTIONS} actions`;
    if (r.mode === 'cash') {
      if (!isInt(hand.deckSeed) || !isInt(hand.button, 0, players.length - 1)) return `hand ${h + 1}: a cash hand needs a deck seed and a button seat`;
      const s = hand.seating;
      if (!Array.isArray(s) || s.length !== players.length || !s.every((p) => isInt(p, 0, players.length - 1)) || new Set(s).size !== s.length) return `hand ${h + 1}: seating must place every player once`;
    } else if (hand.deckSeed !== undefined || hand.button !== undefined || hand.seating !== undefined) return `hand ${h + 1}: a Sit & Go hand takes no seeds or seating of its own`;
    for (let a = 0; a < hand.actions.length; a++) {
      const problem = actionProblem(hand.actions[a]);
      if (problem) return `hand ${h + 1}, action ${a + 1}: ${problem}`;
    }
    if (hand.talk !== undefined) {
      const talk = hand.talk;
      if (!Array.isArray(talk) || talk.length > MAX_TALK || !talk.every((x: unknown) => isObj(x) && isInt(x.seat, 0, players.length - 1) && isInt(x.after, 0, (hand.actions as unknown[]).length) && typeof x.say === 'string' && x.say.length <= MAX_SAY)) {
        return `hand ${h + 1}: talk must list { seat, after, say } lines of at most ${MAX_SAY} characters`;
      }
    }
  }
  const res = r.result;
  if (!isObj(res) || !Array.isArray(res.chips) || (r.mode === 'sitngo' && !Array.isArray(res.places))) return 'result must give chips (and, for a Sit & Go, places) per player';
  if (r.mode === 'cash' && res.places !== undefined) return 'cash hands have no places';
  return null;
}

const toEngine = (x: RecordedAction): Action => (x.key !== undefined ? { key: x.key } : { kind: 'raise', to: x.to! });

/**
 * Plays one recorded hand from its state, each action through `step` (which returns the hand after it). With
 * `strict`, also checks who made each move: a bot seat's moves must be the bot's own, a fallback must be what the
 * fallback rule gives, and an answer must come from a model.
 */
function playHand(start: HandState, step: (a: Action) => HandState, actions: readonly RecordedAction[], players: readonly Player[], seating: readonly number[], h: number, strict: boolean): HandState {
  let s = start;
  actions.forEach((x, a) => {
    const where = `hand ${h + 1}, action ${a + 1}`;
    const seat = toAct(s);
    if (seat === null) throw new Error(`${where} comes after the hand ended`);
    if (x.seat !== seat) throw new Error(`${where}: seat ${x.seat} acted, but seat ${seat} is to act`);
    if (strict) {
      const player = players[seating[seat]!]!;
      if (player.kind === 'bot' && x.by !== 'bot') throw new Error(`${where}: seat ${seat} is a bot, so its moves are the bot's`);
      if (player.kind === 'model' && x.by !== 'answer' && x.by !== 'fallback') throw new Error(`${where}: seat ${seat} is a model, so a move is its answer or the fallback`);
      if (player.kind === 'human' && x.by !== 'human' && x.by !== 'fallback') throw new Error(`${where}: seat ${seat} is a human, so a move is theirs or the fallback`);
      if (x.by === 'bot') {
        const key = botDecide(player.id as BotName, observe(s, seat));
        if (x.key !== key) throw new Error(`${where}: the bot plays ${key} there, not ${x.key ?? `a raise to ${x.to}`}`);
      }
      if (x.by === 'fallback') {
        const key = fallbackKey(legalOptions(s));
        if (x.key !== key) throw new Error(`${where} is marked as the fallback, but the fallback plays ${key} there, not ${x.key ?? `a raise to ${x.to}`}`);
      }
    }
    try {
      s = step(toEngine(x));
    } catch (e) {
      throw new Error(`${where}: ${(e as Error).message}`);
    }
  });
  if (toAct(s) !== null) throw new Error(`hand ${h + 1} stops before it ended`);
  return s;
}

function simulate(rec: Recording, strict: boolean): ReplayResult {
  const n = rec.players.length;
  const hands: HandResult[] = [];
  if (rec.mode === 'cash') {
    const c = rec.cash!;
    const chips = rec.players.map(() => 0);
    rec.hands.forEach((hand, h) => {
      const seating = hand.seating!;
      let s = newHand({ stacks: seating.map(() => c.stack), button: hand.button!, sb: c.sb, bb: c.bb, ante: c.ante, deckSeed: hand.deckSeed! });
      const end = playHand(s, (a) => (s = applyAction(s, a)), hand.actions, rec.players, seating, h, strict);
      const net = end.seats.map((p) => p.stack - p.start);
      net.forEach((x, seat) => (chips[seating[seat]!]! += x));
      hands.push({ seating: [...seating], events: end.events, net });
    });
    return { hands, chips, places: null };
  }
  const seating = Array.from({ length: n }, (_, i) => i);
  let g: SitAndGo = newSitAndGo({ seats: n, key: rec.sitngo!.key, startingStack: rec.sitngo!.startingStack });
  rec.hands.forEach((hand, h) => {
    if (g.over && h > 0) throw new Error(`hand ${h + 1} comes after the Sit & Go ended`);
    if (h > 0) g = nextHand(g);
    // Played through the Sit & Go, which also settles the places.
    const end = playHand(g.hand, (a) => (g = actSitAndGo(g, a)).hand, hand.actions, rec.players, seating, h, strict);
    hands.push({ seating: [...seating], events: end.events, net: end.seats.map((p) => p.stack - p.start) });
  });
  if (!g.over) throw new Error(`the Sit & Go stops after ${rec.hands.length} hands, before it ended`);
  return { hands, chips: g.hand.seats.map((p) => p.stack), places: g.places as number[] };
}

/** Re-plays a recording with the engine: every hand's events, and the chips and places. Throws on an illegal action. */
export function replay(rec: Recording): ReplayResult {
  return simulate(rec, false);
}

/** A name for the game played: its config, seeds, seating and moves, not its metadata or timings. */
export function fingerprintOf(rec: Recording): string {
  const config = rec.mode === 'sitngo' ? `sitngo:${rec.sitngo!.key}:${rec.sitngo!.startingStack}` : `cash:${rec.cash!.stack}:${rec.cash!.sb}:${rec.cash!.bb}:${rec.cash!.ante}`;
  const players = JSON.stringify(rec.players.map((p) => [p.kind, p.id]));
  const hands = rec.hands.map((h) => `${h.deckSeed ?? ''}:${h.button ?? ''}:${(h.seating ?? []).join(',')}:${h.actions.map((x) => `${x.seat}${x.key ?? `=${x.to}`}`).join(' ')}`);
  return hashText([config, players, ...hands].join('|'));
}

const same = (a: readonly number[], b: unknown) => Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Checks a recording: its shape; every action legal and made by the seat to act; every bot move the bot's own; every
 * fallback the fallback rule's; every hand played to its end and the game too; the claimed result the replay's.
 */
export function verifyRecording(raw: unknown): RecordingVerdict {
  if (!isObj(raw)) return { ok: false, error: "not a format 1 AI Hold'em recording" };
  const problem = shapeProblem(raw);
  if (problem) return { ok: false, error: problem };
  const rec = raw as unknown as Recording;
  let result: ReplayResult;
  try {
    result = simulate(rec, true);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (!same(result.chips, rec.result.chips) || (result.places && !same(result.places, rec.result.places))) {
    const claimed = `${JSON.stringify(rec.result.chips)}${rec.result.places ? ` and places ${JSON.stringify(rec.result.places)}` : ''}`;
    return { ok: false, error: `the replay ends with chips ${JSON.stringify(result.chips)}${result.places ? ` and places ${JSON.stringify(result.places)}` : ''}; the recording claims ${claimed}` };
  }
  return { ok: true, result, fingerprint: fingerprintOf(rec) };
}
