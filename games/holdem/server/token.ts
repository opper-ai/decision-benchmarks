// What a table's sealed token holds (the plan's "Architecture: the server deals"), and how a table is rebuilt from it.
// The service keeps no state: every answer carries the whole table, sealed with AES-256-GCM under a key of its own
// (HMAC(SESSION_SECRET, "decision-benchmarks:holdem-table"), kit GameApiCall.seal), so the browser holds it without
// being able to read it. A table is its key plus its actions, so the token is small: the table key, the seats, the mode, the
// actions of every hand in a compact form, the metadata of the hand in play (table talk the models hear, and in play
// mode the reasoning the review shows once the hand is over), when it was issued and when it expires.
//
// The table key never leaves the server before the game is over: it deals every hand to come. The metadata of a finished
// hand went to the browser with the answer that finished it (its review), so it leaves the token.
//
// Node-safe, erasable TypeScript only.
import type { Action, OptionKey } from '../shared/engine.ts';
import { holdemModel } from '../shared/models.ts';
import { isTableKey } from '../shared/rng.ts';
import { MOODS, type FallbackReason, type Mood, type RecordedAction } from '../shared/recording.ts';
import { actSitAndGo, MAX_SEATS, MIN_SEATS, newSitAndGo, nextHand, type SitAndGo } from '../shared/sitngo.ts';
import { finishedHandOf, type ReviewHand } from '../shared/table.ts';

/** 2: the table key (a 256-bit deal) replaced the 31-bit seed; older tokens are refused. */
export const TOKEN_VERSION = 2;
/** A table lasts six hours from its start: a Sit & Go takes 40 to 80 hands (up to about 130 at 6 seats), minutes each at worst. */
export const TABLE_TTL_MS = 6 * 3600_000;

/** One action's metadata, keys kept short (the token goes back and forth with every request). */
export interface CompactMeta {
  /** say, mood, reasoning, probabilities, latency (ms), cost (USD) */
  s?: string;
  m?: Mood;
  r?: string;
  p?: Partial<Record<OptionKey, number>>;
  l?: number;
  c?: number;
}

export interface TableState {
  v: typeof TOKEN_VERSION;
  /** A random id for the logs (and, in v2, a single-use game id). */
  id: string;
  /** The table key (64 hex digits, rng.ts), from the server's cryptographic random source. */
  key: string;
  mode: 'play' | 'watch';
  /** The model id in each seat; null is the human. */
  seats: (string | null)[];
  /** Every hand's actions in compact form (encodeAction), the last one the hand in play. */
  log: string[];
  /** The hand in play's metadata, one per action so far. */
  meta: CompactMeta[];
  /** When this token was issued (ms): a human's think time counts from it. */
  at: number;
  /** When the table expires (ms). */
  exp: number;
}

const CODES: Record<OptionKey, string> = { fold: 'f', check: 'x', call: 'c', small: 's', half: 'h', three_quarters: 't', pot: 'p', allin: 'a' };
const KEYS = Object.fromEntries(Object.entries(CODES).map(([k, c]) => [c, k as OptionKey])) as Record<string, OptionKey>;
const WHY: Record<FallbackReason, string> = { timeout: 't', error: 'e', invalid: 'i', refusal: 'r' };
const WHY_OF = Object.fromEntries(Object.entries(WHY).map(([k, c]) => [c, k as FallbackReason])) as Record<string, FallbackReason>;

/**
 * An action in a few characters: a model's answer or a human's menu option as its letter (f x c s h t p a), the
 * fallback's as the capital letter and why (Xt: checked, the model timed out), a human's raise to an amount as r<to>.
 */
export function encodeAction(x: Pick<RecordedAction, 'key' | 'to' | 'by' | 'why'>): string {
  if (x.key === undefined) return `r${x.to}`;
  if (x.by === 'fallback') return `${CODES[x.key].toUpperCase()}${WHY[x.why ?? 'error']}`;
  return CODES[x.key];
}

/** The action back, for a seat played by a human or a model; null for anything else. */
export function decodeAction(code: string, seat: number, human: boolean): RecordedAction | null {
  const m = /^(?:([fxcshtpa])|([FX])([teir])|r(\d{1,9}))$/.exec(code);
  if (!m) return null;
  if (m[1]) return { seat, key: KEYS[m[1]]!, by: human ? 'human' : 'answer' };
  if (m[2]) return human ? null : { seat, key: KEYS[m[2].toLowerCase()]!, by: 'fallback', why: WHY_OF[m[3]!]! };
  return human ? { seat, to: Number(m[4]), by: 'human' } : null;
}

export const toEngine = (x: RecordedAction): Action => (x.key !== undefined ? { key: x.key } : { kind: 'raise', to: x.to! });

/** The metadata a recorded action keeps, compacted (only what is there; reasoning only when `reasoning`). */
export function compactMeta(x: RecordedAction, reasoning: boolean): CompactMeta {
  const m: CompactMeta = {};
  if (x.say) m.s = x.say;
  if (x.mood) m.m = x.mood;
  if (reasoning && x.reasoning) m.r = x.reasoning;
  if (x.probabilities) m.p = x.probabilities;
  if (x.latencyMs !== undefined) m.l = x.latencyMs;
  if (x.costUsd !== undefined) m.c = x.costUsd;
  return m;
}

const withMeta = (x: RecordedAction, m: CompactMeta | undefined): RecordedAction => ({
  ...x,
  ...(m?.l !== undefined ? { latencyMs: m.l } : {}),
  ...(m?.c !== undefined ? { costUsd: m.c } : {}),
  ...(m?.s !== undefined ? { say: m.s } : {}),
  ...(m?.m !== undefined ? { mood: m.m } : {}),
  ...(m?.r !== undefined ? { reasoning: m.r } : {}),
  ...(m?.p !== undefined ? { probabilities: m.p } : {}),
});

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);

/** A token's contents, checked: the state, or null for anything this server would not have sealed. */
export function parseState(v: unknown): TableState | null {
  if (!isObj(v) || v.v !== TOKEN_VERSION || typeof v.id !== 'string' || !isTableKey(v.key) || (v.mode !== 'play' && v.mode !== 'watch')) return null;
  if (!isInt(v.at) || !isInt(v.exp) || !Array.isArray(v.log) || !v.log.length || !v.log.every((h) => typeof h === 'string') || !Array.isArray(v.meta) || !v.meta.every(isObj)) return null;
  const seats = v.seats;
  if (!Array.isArray(seats) || seats.length < MIN_SEATS || seats.length > MAX_SEATS || !seats.every((s) => s === null || (typeof s === 'string' && holdemModel(s)))) return null;
  if (seats.filter((s) => s === null).length !== (v.mode === 'play' ? 1 : 0)) return null;
  for (const m of v.meta as Record<string, unknown>[]) if (m.m !== undefined && !MOODS.includes(m.m as Mood)) return null;
  return v as unknown as TableState;
}

/** A table rebuilt from its state: the Sit & Go as it stands, and every hand's actions (the hand in play's with its metadata). */
export interface Table {
  st: TableState;
  g: SitAndGo;
  hands: RecordedAction[][];
  /** With `finished`: every hand played to its end, face up, for the review. */
  finished: ReviewHand[];
}

/** Replays the state's actions from its key; throws if they do not replay (a token from another version of the rules). */
export function rebuild(st: TableState, o: { finished?: boolean } = {}): Table {
  let g = newSitAndGo({ seats: st.seats.length, key: st.key });
  const hands: RecordedAction[][] = [];
  const finished: ReviewHand[] = [];
  st.log.forEach((line, h) => {
    if (h > 0) g = nextHand(g);
    const last = h === st.log.length - 1;
    const actions: RecordedAction[] = [];
    for (const [i, code] of (line ? line.split(',') : []).entries()) {
      const seat = g.hand.toAct;
      if (seat === null) throw new Error(`hand ${h + 1}: an action after the hand ended`);
      const x = decodeAction(code, seat, st.seats[seat] === null);
      if (!x) throw new Error(`hand ${h + 1}: ${code.slice(0, 12)} is no action for seat ${seat}`);
      g = actSitAndGo(g, toEngine(x));
      actions.push(last ? withMeta(x, st.meta[i]) : x);
    }
    if (!last && g.hand.street !== 'done') throw new Error(`hand ${h + 1} stops before it ended`);
    hands.push(actions);
    if (o.finished && g.hand.street === 'done') finished.push(finishedHandOf(g, actions));
  });
  return { st, g, hands, finished };
}
