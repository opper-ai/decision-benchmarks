// AI Hold'em's table service (the plan's "Architecture: the server deals" and "Who pays"): POST api/table/start, step,
// act, next and review below the game's path, mounted through the kit's game API (GameServer.api). The server deals and
// asks the models; the browser only ever holds a sealed token (token.ts) and what its seat may see.
//
//   start  { seats, mode }        -> { token, snapshot, finished? }   deal from a fresh table key
//   step   { token }              -> { token, result, finished? }     one AI action: the server asks the model
//   act    { token, action }      -> { token, result, finished? }     the human's action
//   next   { token }              -> { token, snapshot, finished? }   deal the next hand
//   review { token }              -> Review                           the finished hands, face up; the recording once over
//   resume { token }              -> { token, snapshot, finished? }   the table as it stands, after a reload
//
// The shapes are shared/table.ts's, the TableDriver's own, so the page's RemoteDriver passes them on as they are.
//
// What stays hidden in play mode: the table key and the deck (only in the recording, once the game is over), other seats'
// hole cards (only once a showdown shows them, or in the finished hand's review once it is over), and the models'
// reasoning (in the finished hand's review). Watch mode has no human: every card and the reasoning come at once.
// Once the human is out of the game (busted), they can never act again: from the answer that knocks them out on,
// they watch as in watch mode (every card, the reasoning with each step; `snapshot.spectating: true`).
//
// Who pays: a table with a chat model needs a signed-in player (their own Opper credits; 401 asks the page to sign in,
// 402 points to their wallet), or the server's local key in development. A table of decision models only plays on the
// signed-in player's key, else on the free credits (the kit's per-visitor and global limits and hourly budget), else
// the local key. Only the models in shared/models.ts sit down (403 for any other).
//
// Each visitor (their IP address, as the kit counts it for the free credits) may start a new table every 15 seconds
// after a burst of 20, and send 4 of the calls no model answers (act, next, review) a second after a burst of 40: each
// rebuilds the table from its token. A refused call is the kit's 429 with Retry-After (DEFAULT_TABLE_LIMITS).
//
// Known limits (fine for v1, which keeps no public scores):
// - The token is stateless, so a player can send an older token again to take back a decision, or step the same token
//   twice to have an AI decide again (each call is paid, by the player, or on the free credits within the visitor's
//   limits). Replaying a hand after seeing how it ended (fold, read every hole card in the finished hand, then play
//   the old token again) is refused only as far as this server instance remembers the hand ended. It remembers the
//   last hand each table finished until the table closes (its tokens expire), for up to 50,000 tables: more than one
//   visitor can start in six hours, even from a whole IPv6 /48. Past that (many addresses at once) it forgets the
//   tables that finished a hand longest ago early, and logs it. Another instance behind the load balancer, or this one
//   after a restart or deploy, doesn't know the hand ended at all. v2's Humanity vs AI scoreboard needs single-use game
//   ids held in shared storage (the token's `id`), so each token can be played once anywhere.
// The deal can't be guessed from the cards: each table has a 256-bit key from randomBytes, and every hand's deck is
// shuffled from the ChaCha20 keystream under it (shared/rng.ts, sitngo.ts), so the cards a player sees (their own, the
// board, a finished hand's review) say nothing about the cards to come.
//
// Node-safe, erasable TypeScript only (the service runs it as is).
import { createHash, randomBytes } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { handleChat } from '../../../packages/kit/server/chat.ts';
import { handleDecide, type DecideResult } from '../../../packages/kit/server/decide.ts';
import { VisitorLimits, type LimitSettings } from '../../../packages/kit/server/pool.ts';
import type { ApiPayer, GameApi, GameApiCall, GameApiResponse } from '../../../packages/kit/shared/game.ts';
import { isOptionKey, observe, type Action } from '../shared/engine.ts';
import { holdemModel, type HoldemModel } from '../shared/models.ts';
import { chatFormatFor, cleanTalk, MAX_TALK_LINES, QUESTION, readAnswer, requestFor, type TableContext } from '../shared/questions.ts';
import { fallbackKey } from '../shared/bots.ts';
import type { FallbackReason, Player, RecordedAction, TalkLine } from '../shared/recording.ts';
import { actSitAndGo, MAX_SEATS, MIN_SEATS, newSitAndGo, nextHand, type SitAndGo } from '../shared/sitngo.ts';
import { finishedHandOf, recordingOf, snapshotOf, type ActionMeta, type Review, type SnapshotReply, type StepReply } from '../shared/table.ts';
import { compactMeta, encodeAction, MAX_HAND_TALK, parseState, rebuild, TABLE_TTL_MS, TOKEN_VERSION, type Table, type TableState } from './token.ts';

/** The token's purpose: sealed under HMAC(SESSION_SECRET, "decision-benchmarks:holdem-table"). */
const PURPOSE = 'table';
/** Largest body read: a token (a long chat hand's reasoning is the most of it, 600 characters an action) and an action. */
export const MAX_TABLE_BODY_BYTES = 128 * 1024;
const CALL_NAME = 'decision-benchmarks-holdem';
const HUMAN_ID = 'you';
/** A human's think time is recorded up to this (the recording's own cap is ten minutes). */
const MAX_HUMAN_MS = 600_000;
/** A line of talk as typed, before cleanTalk cuts it to MAX_SAY: anything longer is refused outright. */
const MAX_RAW_TALK = 500;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const only = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): GameApiResponse => ({ status, body: { error, ...extra } });

/** Dependencies a test may replace: the clock and the table key. */
export interface TableDeps {
  now(): number;
  /** A fresh table key: 32 cryptographically random bytes as 64 hex digits. */
  key(): string;
  /** A monotonic clock for latencies. */
  clock(): number;
}

const DEFAULT_DEPS: TableDeps = { now: () => Date.now(), key: () => randomBytes(32).toString('hex'), clock: () => performance.now() };

const humanSeat = (st: TableState): number | null => {
  const i = st.seats.indexOf(null);
  return i === -1 ? null : i;
};
const viewerOf = (st: TableState): number | null => (st.mode === 'play' ? humanSeat(st) : null);
/** Play mode, once the human is out of the game: they watch from then on, every card and the reasoning shown. */
const spectatorOf = (st: TableState, g: SitAndGo): boolean => {
  const human = viewerOf(st);
  return human !== null && g.places[human] !== null;
};
const timeBankOf = (st: TableState) => (seat: number) => {
  const id = st.seats[seat];
  return id ? (holdemModel(id)?.timeoutMs ?? null) : null;
};
const playersOf = (st: TableState): Player[] => st.seats.map((id) => (id === null ? { kind: 'human', id: HUMAN_ID } : { kind: 'model', id }));

/** Seals the table as it now stands: the hand in play's metadata only (reasoning only in play mode, for its review). */
function seal(call: GameApiCall, t: Table, now: number): string {
  const hand = t.hands[t.hands.length - 1] ?? [];
  const st: TableState = {
    ...t.st,
    log: t.hands.map((actions) => actions.map(encodeAction).join(',')),
    meta: hand.map((x) => compactMeta(x, t.st.mode === 'play')),
    at: now,
  };
  if (t.talk.length) st.t = t.talk.map((x) => [x.after, x.say]);
  else delete st.t;
  return call.seal(PURPOSE, st);
}

/** The table a token stands for, or the answer refusing it. */
function open(call: GameApiCall, token: unknown, now: number, o: { finished?: boolean } = {}): Table | GameApiResponse {
  const st = parseState(call.open(PURPOSE, token));
  if (!st) return fail(400, 'That is not a table this server dealt. Start a new game.', { badToken: true });
  if (now > st.exp) return fail(410, 'This table has closed: it was dealt more than six hours ago. Start a new game.', { expired: true });
  try {
    return rebuild(st, o);
  } catch {
    return fail(400, 'That table no longer replays here. Start a new game.', { badToken: true });
  }
}

const isTable = (v: Table | GameApiResponse): v is Table => 'g' in v;

/** The finished hand to send with an answer whose action (or deal) ended it. */
const finishedOf = (t: Table): { finished?: ReturnType<typeof finishedHandOf> } => (t.g.hand.street === 'done' ? { finished: finishedHandOf(t.g, t.hands[t.g.handIndex] ?? [], t.talk) } : {});

/** The page's ActionMeta for a recorded action: the reasoning only when it may be seen now (watch mode). */
function metaOf(x: RecordedAction, reasoning: boolean): ActionMeta {
  return {
    by: x.by,
    latencyMs: x.latencyMs ?? 0,
    ...(x.why ? { why: x.why } : {}),
    ...(x.say !== undefined ? { say: x.say } : {}),
    ...(x.mood ? { mood: x.mood } : {}),
    ...(x.probabilities ? { probabilities: x.probabilities } : {}),
    ...(reasoning && x.reasoning !== undefined ? { reasoning: x.reasoning } : {}),
    ...(x.costUsd !== undefined ? { costUsd: x.costUsd } : {}),
  };
}

/** Plays `x` for the seat to act and answers with the table after it. */
function played(call: GameApiCall, t: Table, x: RecordedAction, now: number, said: readonly TalkLine[] = []): GameApiResponse {
  const g = actSitAndGo(t.g, x.key !== undefined ? { key: x.key } : { kind: 'raise', to: x.to! });
  const hands = t.hands.map((h, i) => (i === t.hands.length - 1 ? [...h, x] : h));
  const next: Table = { ...t, g, hands };
  const reply: StepReply = {
    token: seal(call, next, now),
    result: { seat: x.seat, key: x.key ?? null, meta: metaOf(x, t.st.mode === 'watch' || spectatorOf(t.st, g)), snapshot: snapshotOf(g, viewerOf(t.st), timeBankOf(t.st)), ...(said.length ? { talk: [...said] } : {}) },
    ...finishedOf(next),
  };
  return { status: 200, body: reply };
}

/** Who pays for a seat's model, or the answer when nobody can (chat models: never the free credits). */
function payerFor(call: GameApiCall, models: readonly HoldemModel[]): ApiPayer | GameApiResponse {
  const chat = models.some((m) => m.kind === 'chat');
  const payer = call.payer({ pool: !chat });
  if (!payer) return chat ? call.unpaid({ pool: false, error: 'Sign in with Opper to play the chat models: they play on your own Opper credits.' }) : call.unpaid();
  if (chat && payer.provider !== 'opper') return fail(403, 'The chat models play through Opper: set OPPER_API_KEY to play them locally.');
  return payer;
}
const isPayer = (v: ApiPayer | GameApiResponse): v is ApiPayer => 'apiKey' in v;

/** The players' names and this hand's table talk, for the model's state. */
function contextOf(t: Table): TableContext {
  // The hand's talk in the order it was said: the human's lines said after k actions come before action k's own line.
  const actions = t.hands[t.hands.length - 1] ?? [];
  const talk: { seat: number; say: string; human?: boolean }[] = [];
  for (let i = 0; i <= actions.length; i++) {
    for (const x of t.talk) if (x.after === i) talk.push({ seat: x.seat, say: x.say, human: true });
    const say = actions[i]?.say;
    if (say) talk.push({ seat: actions[i]!.seat, say });
  }
  return { names: t.st.seats.map((id) => (id === null ? 'Human' : (holdemModel(id)?.name ?? id))), talk };
}

/**
 * Asks the model in the seat to act, within its time (2.5 s decision, 20 s chat): its move, or the fallback's (check
 * if free, else fold) with why when it is late, fails, refuses or answers no option. A refused key (the player's
 * sign-in or wallet, the free credits, a model their key may not use) is no move: its answer goes back to the page.
 */
async function ask(call: GameApiCall, t: Table, model: HoldemModel, payer: ApiPayer, deps: TableDeps): Promise<RecordedAction | GameApiResponse> {
  const seat = t.g.hand.toAct!;
  const o = observe(t.g.hand, seat);
  const keys = o.options.map((x) => x.key);
  const context = contextOf(t);
  const request = requestFor(o, context);
  const common = { apiKey: payer.apiKey, baseUrl: payer.baseUrl, keyMode: payer.mode, ...(payer.project ? { project: payer.project } : {}), fetch: call.fetch, now: deps.clock, timeoutMs: model.timeoutMs, signal: call.signal, callName: CALL_NAME, log: call.log };
  const started = deps.clock();
  const r: DecideResult =
    model.kind === 'decision'
      ? await handleDecide({ model: model.id, ...request }, { ...common, provider: payer.provider })
      : await handleChat({ model: model.id, ...request }, { ...common, format: chatFormatFor(context), label: model.name, ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}), ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}) });
  const latencyMs = Math.min(model.timeoutMs, Math.max(0, Math.round(deps.clock() - started)));
  const body = (isObj(r.body) ? r.body : {}) as { answers?: Record<string, unknown>; costUsd?: unknown; error?: string; signedOut?: boolean; poolEmpty?: boolean; walletUrl?: string; clearSession?: boolean };
  const cost = typeof body.costUsd === 'number' && Number.isFinite(body.costUsd) && body.costUsd > 0 ? Math.min(1, body.costUsd) : undefined;
  if (payer.mode === 'pool') call.poolSpent(cost ?? null, r.status === 402 && body.poolEmpty === true);
  if (call.signal.aborted) return fail(499, 'The table was left while the model was thinking');
  if (r.status === 401 || r.status === 402 || r.status === 403) {
    const { clearSession, ...rest } = body;
    return { status: r.status, body: { ...rest, error: rest.error ?? 'The model could not be asked' }, ...(clearSession ? { clearSession: true } : {}) };
  }
  const fallback = (why: FallbackReason): RecordedAction => ({ seat, key: fallbackKey(o.options), by: 'fallback', why, latencyMs, ...(cost ? { costUsd: cost } : {}) });
  if (r.status === 504) return fallback('timeout');
  if (r.status !== 200) {
    call.log(`table ${t.st.id}: ${model.id} failed (HTTP ${r.status}), the fallback plays: ${String(body.error ?? '').slice(0, 200)}`);
    return fallback('error');
  }
  const read = readAnswer(body.answers?.[QUESTION], keys);
  if ('why' in read) return fallback(read.why);
  return {
    seat,
    key: read.key,
    by: 'answer',
    latencyMs,
    ...(cost ? { costUsd: cost } : {}),
    ...(read.probabilities ? { probabilities: read.probabilities } : {}),
    ...(read.say ? { say: read.say } : {}),
    ...(read.mood ? { mood: read.mood } : {}),
    ...(read.reasoning ? { reasoning: read.reasoning } : {}),
  };
}

/** The token from a body that holds it (and, for act, the action), or the answer refusing the body. */
function tokenOf(body: unknown, extra: readonly string[] = []): string | GameApiResponse {
  if (!isObj(body) || !only(body, ['token', ...extra]) || typeof body.token !== 'string') return fail(400, `Send { token${extra.map((k) => `, ${k}`).join('')} }`);
  return body.token;
}

/** A human's action from the body: a menu option, or a raise to a whole number of chips. */
function actionOf(v: unknown): Action | null {
  if (!isObj(v)) return null;
  if (only(v, ['key']) && isOptionKey(v.key)) return { key: v.key };
  if (only(v, ['kind', 'to']) && v.kind === 'raise' && Number.isSafeInteger(v.to) && (v.to as number) > 0) return { kind: 'raise', to: v.to as number };
  return null;
}

/** Per-visitor limits on the table's free calls, and how many tables the replay guard remembers. */
export interface TableLimits {
  /** New tables (start): each one that finishes a hand takes a place in the replay guard until it closes. */
  starts: LimitSettings;
  /** The calls no model answers (act, next, review, resume): each rebuilds the table from its token. */
  moves: LimitSettings;
  /** Steps (a model asked, or refused at once, after the table is rebuilt from its token): above a fast watch's pace. */
  steps: LimitSettings;
  /** The human's lines of table talk (each line takes one): banter, not a flood into the models' prompts. */
  talk: LimitSettings;
  /** Most tables whose last finished hand this instance remembers at once. */
  remember: number;
}

/**
 * A new table every 15 seconds after a burst of 20 (a person starts one every few minutes), so one visitor starts at
 * most 1,460 tables in a token's six hours, 5,840 from a whole IPv6 /48: well inside `remember`. A person acts about
 * once a second at most; 4 a second after 40 leaves room for the page's own calls (next, review) on top.
 */
export const DEFAULT_TABLE_LIMITS: TableLimits = { starts: { ratePerSec: 1 / 15, burst: 20 }, moves: { ratePerSec: 4, burst: 40 }, steps: { ratePerSec: 10, burst: 60 }, talk: { ratePerSec: 0.5, burst: 9 }, remember: 50_000 };

/** Tables whose answer to the request that finished their last hand is kept for a retry (see `answers`). */
const REMEMBERED_ANSWERS = 2000;
/** How long such an answer is kept: past the page's two minutes of retries (RemoteDriver RETRY_FOR_MS). */
export const ANSWER_TTL_MS = 5 * 60_000;

/** No limit across visitors: a flood from many addresses must not keep everybody else from starting a table. */
const UNLIMITED: LimitSettings = { ratePerSec: Number.POSITIVE_INFINITY, burst: Number.POSITIVE_INFINITY };

export function tableApi(deps: TableDeps = DEFAULT_DEPS, limits: Partial<TableLimits> = {}): GameApi {
  const { starts, moves, steps, talk: talkRate, remember } = { ...DEFAULT_TABLE_LIMITS, ...limits };
  const talkLimits = new VisitorLimits(talkRate, deps.now, UNLIMITED);
  /**
   * The human's lines that come with a request (step, act, next): `talk`, at most MAX_TALK_LINES, each made safe
   * (cleanTalk) and held to the visitor's talk allowance. Play mode only: watch mode has no human to speak.
   */
  const talkOf = (call: GameApiCall, st: TableState): string[] | GameApiResponse => {
    const raw = (call.body as Record<string, unknown>).talk;
    if (raw === undefined) return [];
    if (st.mode !== 'play') return fail(400, 'Only a player at the table can talk: watch mode has none');
    if (!Array.isArray(raw) || raw.length > MAX_TALK_LINES || !raw.every((x) => typeof x === 'string' && x.length <= MAX_RAW_TALK)) return fail(400, `talk is at most ${MAX_TALK_LINES} lines of text`);
    const lines: string[] = (raw as string[]).map(cleanTalk).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (talkLimits.take(call.visitor) !== 'ok') return { status: 429, body: { error: 'Too much table talk for now: give the others a moment' }, headers: retryAfter(talkRate) };
    }
    return lines;
  };
  /** The table with the human's new lines said now (after the hand's actions so far), and the lines as said. */
  const withTalk = (t: Table, lines: readonly string[]): { t: Table; said: TalkLine[] } => {
    if (!lines.length) return { t, said: [] };
    const human = t.st.seats.indexOf(null);
    const after = (t.hands[t.hands.length - 1] ?? []).length;
    const said = lines.map((say) => ({ seat: human, after, say }));
    if (t.talk.length + said.length > MAX_HAND_TALK) return { t, said: [] };
    return { t: { ...t, talk: [...t.talk, ...said] }, said };
  };
  const startLimits = new VisitorLimits(starts, deps.now, UNLIMITED);
  const moveLimits = new VisitorLimits(moves, deps.now, UNLIMITED);
  const stepLimits = new VisitorLimits(steps, deps.now, UNLIMITED);
  const retryAfter = (s: LimitSettings) => ({ 'Retry-After': String(Math.max(1, Math.ceil(1 / s.ratePerSec))) });
  /** The kit's 429 when the visitor is past its allowance (the limiters have no global one, so never 'busy'), else null. */
  const tooFast = (call: GameApiCall, l: VisitorLimits, s: LimitSettings, error: string): GameApiResponse | null =>
    l.take(call.visitor) === 'ok' ? null : { status: 429, body: { error }, headers: retryAfter(s) };
  const moveTooFast = (call: GameApiCall) => tooFast(call, moveLimits, moves, 'Too many requests from your address; slow down a little');
  const stepTooFast = (call: GameApiCall) => tooFast(call, stepLimits, steps, 'Too many requests from your address; slow down a little');

  /**
   * Table id -> the last hand (from 0) it finished here, and when the table closes: a token from inside that hand is
   * stale. Kept until the table closes (no token of it opens after), in the order each table first finished a hand,
   * which is nearly the order they close in (a table closes six hours after it starts); past `remember`, the oldest go.
   */
  const ended = new Map<string, { hand: number; exp: number }>();
  let full = false;
  const markEnded = (call: GameApiCall, t: Table, now: number) => {
    const had = ended.get(t.st.id);
    if (had) had.hand = Math.max(had.hand, t.g.handIndex);
    else ended.set(t.st.id, { hand: t.g.handIndex, exp: t.st.exp });
    for (const [id, e] of ended) {
      if (e.exp >= now) break;
      ended.delete(id);
    }
    const over = ended.size > remember;
    if (over && !full) call.log(`the replay guard holds ${remember} open tables: forgetting the ones that finished a hand longest ago before they close`);
    full = over;
    for (const id of ended.keys()) {
      if (ended.size <= remember) break;
      ended.delete(id);
    }
  };
  /** A token from inside a hand this table has already finished (with another token): replayed, to play it again knowing the cards. */
  const stale = (t: Table) => t.g.hand.street !== 'done' && (ended.get(t.st.id)?.hand ?? -1) >= t.g.handIndex;
  const STALE = fail(409, 'That hand is already over: this table has moved on. Play on from the latest table.', { stale: true });

  /**
   * Retries. The page sends a request again, with the same token, when its answer was lost (a dropped connection, a
   * phone between cells): act, next and review are pure (the same token and action give the same table), and a step
   * whose answer never arrived asks the model again (a decision the player never saw). The one request a plain re-run
   * can't answer is the one that finished a hand: the replay guard now refuses its token, and re-running a step would
   * let a player who did read the answer (every hole card, in `finished`) have the AI decide again. So the answer that
   * finished a table's hand is kept, by table, with the exact request (route and body) that got it: the same request
   * again gets the same answer, any other on that token stays refused. One answer per table (the latest), compressed
   * (at most about 18 KB), for ANSWER_TTL_MS (a retry comes within the page's two minutes), and at most
   * `REMEMBERED_ANSWERS` tables (the oldest go first): about 36 MB at worst.
   */
  // Kept compressed (a finished hand's answer is tens of KB of JSON) for ANSWER_TTL_MS, in the order kept, so the
  // expired ones are at the front; the token that sent the request is kept as its hash, for resume.
  const answers = new Map<string, { request: string; token: string; at: number; reply: Buffer }>();
  const hash = (text: string) => createHash('sha256').update(text).digest('base64url');
  const requestKey = (route: string, body: unknown) => hash(`${route}\n${JSON.stringify(body)}`);
  const pruneAnswers = (now: number) => {
    for (const [id, a] of answers) {
      if (answers.size > REMEMBERED_ANSWERS || now - a.at > ANSWER_TTL_MS) answers.delete(id);
      else break;
    }
  };
  const keepAnswer = (id: string, token: string, request: string, reply: GameApiResponse, now: number) => {
    answers.delete(id);
    answers.set(id, { request, token: hash(token), at: now, reply: deflateRawSync(JSON.stringify(reply)) });
    pruneAnswers(now);
  };
  /** The kept answer of a table, while it lasts. */
  const keptAnswer = (t: Table): { request: string; token: string; reply: () => GameApiResponse } | null => {
    pruneAnswers(deps.now());
    const kept = answers.get(t.st.id);
    return kept ? { request: kept.request, token: kept.token, reply: () => JSON.parse(inflateRawSync(kept.reply).toString('utf8')) as GameApiResponse } : null;
  };
  /** The kept answer to this exact request, if it is the one that finished the hand. */
  const answered = (t: Table, request: string): GameApiResponse | null => {
    const kept = keptAnswer(t);
    return kept && kept.request === request ? kept.reply() : null;
  };
  /**
   * Identical steps in flight (a retry sent while the first is still asking the model): one model call answers them
   * all, so a retry gets the same answer, and firing the same step many times gets one decision, not many. The call is
   * cancelled only once every caller has gone.
   */
  const inFlight = new Map<string, { reply: Promise<GameApiResponse>; callers: number; controller: AbortController }>();
  const joinStep = (call: GameApiCall, request: string, work: (call: GameApiCall) => Promise<GameApiResponse>): Promise<GameApiResponse> => {
    let flight = inFlight.get(request);
    if (!flight) {
      const controller = new AbortController();
      const reply = work({ ...call, signal: controller.signal }).finally(() => inFlight.delete(request));
      flight = { reply, callers: 0, controller };
      inFlight.set(request, flight);
    }
    const f = flight;
    f.callers++;
    const leave = () => {
      f.callers--;
      if (f.callers === 0) f.controller.abort();
    };
    if (call.signal.aborted) leave();
    else call.signal.addEventListener('abort', leave, { once: true });
    return f.reply.finally(() => call.signal.removeEventListener('abort', leave));
  };
  /** Plays an action and remembers the hand when it ends, with the answer for a retry of the same request. */
  const play = (call: GameApiCall, t: Table, x: RecordedAction, now: number, token: string, request: string, said: readonly TalkLine[] = []): GameApiResponse => {
    const r = played(call, t, x, now, said);
    if ((r.body as StepReply).finished) {
      markEnded(call, t, now);
      keepAnswer(t.st.id, token, request, r, now);
    }
    return r;
  };
  const start = async (call: GameApiCall): Promise<GameApiResponse> => {
    const b = call.body;
    if (!isObj(b) || !only(b, ['seats', 'mode']) || (b.mode !== 'play' && b.mode !== 'watch') || !Array.isArray(b.seats)) return fail(400, "Send { seats: [{ kind: 'human' | 'model', id }], mode: 'play' | 'watch' }");
    if (b.seats.length < MIN_SEATS || b.seats.length > MAX_SEATS) return fail(400, `A table seats ${MIN_SEATS} to ${MAX_SEATS} players`);
    const seats: (string | null)[] = [];
    for (const s of b.seats as unknown[]) {
      if (!isObj(s) || !only(s, ['kind', 'id']) || (s.kind !== 'human' && s.kind !== 'model') || typeof s.id !== 'string') return fail(400, "Each seat is { kind: 'human' | 'model', id }");
      if (s.kind === 'human') seats.push(null);
      else if (!holdemModel(s.id)) return fail(403, `AI Hold'em does not seat ${s.id.slice(0, 80)}`);
      else seats.push(s.id);
    }
    const humans = seats.filter((s) => s === null).length;
    if (b.mode === 'play' && humans !== 1) return fail(400, 'Play mode seats exactly one human');
    if (b.mode === 'watch' && humans !== 0) return fail(400, 'Watch mode seats no human: the models play each other');
    const payer = payerFor(call, seats.flatMap((id) => (id ? [holdemModel(id)!] : [])));
    if (!isPayer(payer)) return payer;
    const refused = tooFast(call, startLimits, starts, 'Too many new tables from your address for now; play on at one you have, or try again in a little while');
    if (refused) return refused;
    const now = deps.now();
    const st: TableState = { v: TOKEN_VERSION, id: randomBytes(6).toString('base64url'), key: deps.key(), mode: b.mode, seats, log: [''], meta: [], at: now, exp: now + TABLE_TTL_MS };
    const g: SitAndGo = newSitAndGo({ seats: seats.length, key: st.key });
    const t: Table = { st, g, hands: [[]], talk: [], finished: [] };
    call.log(`table ${st.id}: ${st.mode} ${seats.map((s) => s ?? 'human').join(', ')} (${payer.mode})`);
    const reply: SnapshotReply = { token: seal(call, t, now), snapshot: snapshotOf(g, viewerOf(st), timeBankOf(st)), ...finishedOf(t) };
    return { status: 200, body: reply };
  };

  const step = async (call: GameApiCall): Promise<GameApiResponse> => {
    const refused = stepTooFast(call);
    if (refused) return refused;
    const token = tokenOf(call.body, ['talk']);
    if (typeof token !== 'string') return token;
    const request = requestKey('step', call.body);
    return joinStep(call, request, (shared) => stepOnce(shared, token, request));
  };

  /** One step, for every identical request in flight (joinStep). */
  const stepOnce = async (call: GameApiCall, token: string, request: string): Promise<GameApiResponse> => {
    const opened = open(call, token, deps.now());
    if (!isTable(opened)) return opened;
    let t = opened;
    if (t.g.over) return fail(409, 'The game is over');
    const seat = t.g.hand.toAct;
    if (seat === null) return fail(409, 'The hand is over: deal the next one');
    const id = t.st.seats[seat];
    if (id === null || id === undefined) return fail(409, 'It is your turn: the AIs wait for you');
    if (stale(t)) return answered(t, request) ?? STALE;
    // The human's lines come first: the model hears them in this very step.
    const lines = talkOf(call, t.st);
    if (!Array.isArray(lines)) return lines;
    const talked = withTalk(t, lines);
    t = talked.t;
    const model = holdemModel(id)!;
    const payer = payerFor(call, [model]);
    if (!isPayer(payer)) return payer;
    if (payer.mode === 'pool') {
      const refused = call.takePool();
      if (refused) return refused;
    }
    const x = await ask(call, t, model, payer, deps);
    if (!('seat' in x)) return x;
    // Another request on this token (another instance's retry, a different body) ended the hand meanwhile.
    if (stale(t)) return answered(t, request) ?? STALE;
    call.log(`table ${t.st.id}: hand ${t.g.handIndex + 1}, seat ${seat} ${model.id} (${payer.mode}) ${x.key}${x.by === 'fallback' ? ` [fallback: ${x.why}]` : ''} in ${x.latencyMs} ms${x.costUsd !== undefined ? `, $${Number(x.costUsd.toPrecision(3))}` : ''}`);
    return play(call, t, x, deps.now(), token, request, talked.said);
  };

  const act = async (call: GameApiCall): Promise<GameApiResponse> => {
    const refused = moveTooFast(call);
    if (refused) return refused;
    const token = tokenOf(call.body, ['action', 'talk']);
    if (typeof token !== 'string') return token;
    const action = actionOf((call.body as Record<string, unknown>).action);
    if (!action) return fail(400, "The action is { key: 'fold' | 'check' | 'call' | 'small' | 'half' | 'three_quarters' | 'pot' | 'allin' } or { kind: 'raise', to }");
    const now = deps.now();
    const opened = open(call, token, now);
    if (!isTable(opened)) return opened;
    let t = opened;
    if (t.g.over) return fail(409, 'The game is over');
    const seat = t.g.hand.toAct;
    if (seat === null) return fail(409, 'The hand is over: deal the next one');
    if (t.st.seats[seat] !== null) return fail(409, 'It is not your turn');
    const request = requestKey('act', call.body);
    if (stale(t)) return answered(t, request) ?? STALE;
    try {
      actSitAndGo(t.g, action);
    } catch (e) {
      return fail(422, `Not a legal action: ${(e as Error).message}`);
    }
    const lines = talkOf(call, t.st);
    if (!Array.isArray(lines)) return lines;
    const talked = withTalk(t, lines);
    t = talked.t;
    const latencyMs = Math.min(MAX_HUMAN_MS, Math.max(0, now - t.st.at));
    const x: RecordedAction = 'key' in action ? { seat, key: action.key, by: 'human', latencyMs } : { seat, to: action.to, by: 'human', latencyMs };
    return play(call, t, x, now, token, request, talked.said);
  };

  const next = async (call: GameApiCall): Promise<GameApiResponse> => {
    const refused = moveTooFast(call);
    if (refused) return refused;
    const token = tokenOf(call.body, ['talk']);
    if (typeof token !== 'string') return token;
    const now = deps.now();
    const t = open(call, token, now);
    if (!isTable(t)) return t;
    if (t.g.over) return fail(409, 'The game is over');
    if (t.g.hand.street !== 'done') return fail(409, 'The hand in play is not over');
    const lines = talkOf(call, t.st);
    if (!Array.isArray(lines)) return lines;
    const g = nextHand(t.g);
    // The lines that come with the deal are said at the start of the new hand.
    const { t: dealt, said } = withTalk({ ...t, g, hands: [...t.hands, []], talk: [] }, lines);
    const reply: SnapshotReply = { token: seal(call, dealt, now), snapshot: snapshotOf(g, viewerOf(t.st), timeBankOf(t.st)), ...finishedOf(dealt), ...(said.length ? { talk: said } : {}) };
    return { status: 200, body: reply };
  };

  const review = async (call: GameApiCall): Promise<GameApiResponse> => {
    const refused = moveTooFast(call);
    if (refused) return refused;
    const token = tokenOf(call.body);
    if (typeof token !== 'string') return token;
    const t = open(call, token, deps.now(), { finished: true });
    if (!isTable(t)) return t;
    const players = playersOf(t.st);
    const body: Review = { players, hands: t.finished, recording: t.g.over ? recordingOf(t.g, players, t.hands, t.hands.map((_, h) => (h === t.hands.length - 1 ? t.talk : undefined))) : null };
    return { status: 200, body };
  };

  /**
   * Back at the table after a reload or a dropped page: the table as the token's seat may see it (the same secrecy as
   * every answer). A token from inside a hand this table has finished is stale, unless it is the token of the request
   * that finished it, whose answer was lost: then the table as that answer left it.
   */
  const resume = async (call: GameApiCall): Promise<GameApiResponse> => {
    const refused = moveTooFast(call);
    if (refused) return refused;
    const token = tokenOf(call.body);
    if (typeof token !== 'string') return token;
    const t = open(call, token, deps.now());
    if (!isTable(t)) return t;
    if (stale(t)) {
      const kept = keptAnswer(t);
      if (!kept || kept.token !== hash(token)) return STALE;
      const r = kept.reply().body as StepReply;
      const reply: SnapshotReply = { token: r.token, snapshot: r.result.snapshot, ...(r.finished ? { finished: r.finished } : {}) };
      return { status: 200, body: reply };
    }
    const reply: SnapshotReply = { token, snapshot: snapshotOf(t.g, viewerOf(t.st), timeBankOf(t.st)), ...finishedOf(t) };
    return { status: 200, body: reply };
  };

  return {
    routes: { '/api/table/resume': resume, '/api/table/start': start, '/api/table/step': step, '/api/table/act': act, '/api/table/next': next, '/api/table/review': review },
    maxBodyBytes: MAX_TABLE_BODY_BYTES,
  };
}
