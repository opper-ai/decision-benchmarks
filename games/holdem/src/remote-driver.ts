// The service's table (POST api/table/*, server/table.ts) as a TableDriver: the server deals and asks the models, and
// the browser keeps only the sealed token it is handed back each time, and the finished hands. The answers already
// have the driver's shapes (shared/table.ts), so this passes them on; what it adds is the hand review's memory:
// - each finished hand comes, face up, with the answer that finished it (play mode: the models' reasoning with it);
// - in watch mode the reasoning came with each step, so it is put back into the finished hand's actions;
// - review() asks the server (the finished hands replayed, and the recording with its seed once the game is over)
//   and lays the remembered table talk, moods, tells and reasoning over it, which the stateless server no longer has.
// Refusals come back as TableError, typed so the page can ask the player to sign in, top up or slow down.
//
// Bad connections (a phone between cells, an SSH tunnel that drops): a request that fails for a passing reason (no
// answer, the driver's own per-attempt timeout, 502/503/504, 429 too fast) is sent again, the same token and body, with
// a growing pause (0.5, 1, 2, 4, 8, 8... s) for up to two minutes; onConnection tells the page ('reconnecting', then
// 'ok'). A refusal (400, 401, 402, 403, 409, 410, 422, a 429 for the free credits) is never retried. Sending the same
// request again is safe: the table is the token, so act, next, review and resume give the same table again; a step
// whose answer was lost asks the model again (a decision the player never saw); and the request that finished a hand,
// which the server's replay guard would refuse a second time, is answered with the answer it got the first time
// (server/table.ts). A start that is retried may leave a table nobody plays: harmless.
//
// Resume: the latest token, the seats, the mode and the finished hands (with what the models said and why) are kept in
// localStorage (STORAGE_KEY) after every answer, so a reload or a dropped page can sit back down: RemoteDriver.saved()
// says what can be resumed, resume() asks the server for the table as that token has it (POST api/table/resume).
// Cleared when the game is over or the player leaves (forget()).
//
// Trash talk: say(text) queues a line (cleaned and capped as the server does); the next request the driver sends anyway
// (step, act or next) carries up to MAX_TALK_LINES of them as `talk`, and the server adds them to the hand's table talk
// before it asks the model, so the next model hears them. onSaid gets the lines back as the server placed them, and
// step and act results carry them (result.talk). A request that fails keeps its lines in front of the queue for the
// next one, which goes from the same token, so a line is said once however often it is sent. resume() starts with an
// empty queue: lines typed but not yet sent before a reload are gone.
import { appPath } from '../../../packages/kit/client/paths.ts';
import type { Action } from '../shared/engine.ts';
import { cleanTalk, MAX_TALK_LINES } from '../shared/questions.ts';
import type { RecordedAction, TalkLine } from '../shared/recording.ts';
import type { ActionMeta, Review, ReviewHand, SeatConfig, SnapshotReply, StepReply, StepResult, TableErrorBody, TableSnapshot, TalkRefused } from '../shared/table.ts';
import type { TableConfig, TableDriver } from './driver.ts';

/**
 * What went wrong at the table, for the page to act on:
 * - signin: sign in with Opper (a chat model's seat, or the free credits need it), 401;
 * - wallet: the player's Opper wallet is empty (walletUrl), 402;
 * - pool: the free credits are spent or busy (sign in to play on), 402/429;
 * - rate: too many requests (wait a moment), 429;
 * - forbidden: a model this table does not seat, or the key may not use, 403;
 * - expired: the table is gone (expired, or a token this server can't read): start again, 400/410;
 * - refused: not now (not your turn, the hand is over, an illegal action), 409/422;
 * - failed: anything else (the server or the network).
 */
export type TableErrorKind = 'signin' | 'wallet' | 'pool' | 'rate' | 'forbidden' | 'expired' | 'refused' | 'failed';

export class TableError extends Error {
  readonly kind: TableErrorKind;
  readonly status: number;
  readonly walletUrl?: string;

  constructor(kind: TableErrorKind, status: number, message: string, walletUrl?: string) {
    super(message);
    this.name = 'TableError';
    this.kind = kind;
    this.status = status;
    if (walletUrl) this.walletUrl = walletUrl;
  }
}

/** The kind of a refused request, from its status and body. */
export function errorKind(status: number, body: Partial<TableErrorBody> & { badToken?: boolean; expired?: boolean }): TableErrorKind {
  if (status === 401) return 'signin';
  if (status === 402) return body.walletUrl ? 'wallet' : 'pool';
  if (status === 429) return body.poolEmpty ? 'pool' : 'rate';
  if (status === 403) return 'forbidden';
  if (status === 410 || (status === 400 && (body.badToken || body.expired))) return 'expired';
  if (status === 409 || status === 422) return 'refused';
  return 'failed';
}

/** The connection, as the page may show it: retrying a request (attempt n failed, the next in `nextInMs`), or fine again. */
export type ConnectionEvent = { state: 'reconnecting'; attempt: number; nextInMs: number; error: string } | { state: 'ok' };

/** What localStorage gives (tests pass a Map-backed one). */
export type TableStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface RemoteDriverOptions {
  /** Tests pass their own; else the page's fetch. */
  fetch?: typeof fetch;
  /** Where api/table/* lives; else below the game's path. */
  url?: (route: string) => string;
  /** Told when a request is being retried, and when the table answers again (also settable as driver.onConnection). */
  onConnection?: (e: ConnectionEvent) => void;
  /** Told when the player's queued lines of table talk reached the table (also settable as driver.onSaid). */
  onSaid?: (lines: TalkLine[]) => void;
  /** Told when queued lines will never be said (also settable as driver.onTalkRefused): see TalkNotSaid. */
  onTalkRefused?: (lines: string[], why: TalkNotSaid) => void;
  /** How long one call keeps retrying before it gives up (default two minutes). */
  retryForMs?: number;
  /** One attempt's own timeout: past a chat model's 20 s and the server's own work (default 45 s). */
  attemptTimeoutMs?: number;
  /** Waits between attempts; rejects with an AbortError when `signal` aborts. Tests pass one that returns at once. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Where the table is kept for a resume: the page's localStorage by default; null keeps nothing. */
  storage?: TableStorage | null;
}

/**
 * Why lines of the player's talk were not said: over the visitor's talk allowance ('busy'), past what a hand holds
 * ('full'), the request they went with was refused ('refused'), or the game is over ('over').
 */
export type TalkNotSaid = 'busy' | 'full' | 'refused' | 'over';

/** The pauses between attempts, the last repeated. */
export const RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000, 8000];
export const RETRY_FOR_MS = 120_000;
export const ATTEMPT_TIMEOUT_MS = 45_000;
/** The localStorage key of the table kept for a resume. */
export const STORAGE_KEY = 'holdem:table';
/** A kept table past this is gone (the server's tokens last six hours from the start). */
export const RESUMABLE_MS = 6 * 3600_000;
/** The kept table's size cap (characters): the oldest finished hands go first past it. */
export const MAX_SAVED_CHARS = 400_000;
/** Lines of talk the driver holds for the next request; past it, say() returns null. */
export const MAX_QUEUED_TALK = 6;

/** A table kept for a resume. */
export interface SavedTable {
  v: 1;
  token: string;
  mode: 'play' | 'watch';
  seats: SeatConfig[];
  /** The hand in play when it was kept, from 1. */
  hand: number;
  finished: ReviewHand[];
  /** The hand in play's actions as they came. */
  metas: ActionMeta[];
  savedAt: number;
}

/** What the lobby needs to offer a resume: who sits where, how far the game got, and how long ago. */
export interface Resumable {
  mode: 'play' | 'watch';
  seats: SeatConfig[];
  hand: number;
  savedAt: number;
  ageMs: number;
}

const TRANSIENT = new Set([502, 503, 504]);

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('The request was cancelled', 'AbortError'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('The request was cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** The page's localStorage, or null where there is none (or it is blocked). */
function pageStorage(): TableStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** A kept table read back, checked; null for anything else. */
function readSaved(storage: TableStorage | null): SavedTable | null {
  if (!storage) return null;
  try {
    const v = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null') as Partial<SavedTable> | null;
    if (!v || v.v !== 1 || typeof v.token !== 'string' || (v.mode !== 'play' && v.mode !== 'watch') || !Array.isArray(v.seats) || !Array.isArray(v.finished) || !Array.isArray(v.metas) || typeof v.savedAt !== 'number' || typeof v.hand !== 'number') return null;
    if (!v.seats.every((s) => isObj(s) && (s.kind === 'human' || s.kind === 'model') && typeof s.id === 'string')) return null;
    return v as SavedTable;
  } catch {
    return null;
  }
}

function removeSaved(storage: TableStorage | null): void {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // blocked storage: nothing kept anyway
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An action's metadata from a step result, as the recording keeps it. */
const recordedMeta = (m: ActionMeta): Partial<RecordedAction> => ({
  ...(m.say !== undefined ? { say: m.say } : {}),
  ...(m.mood ? { mood: m.mood } : {}),
  ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
  ...(m.probabilities ? { probabilities: m.probabilities } : {}),
});

export class RemoteDriver implements TableDriver {
  /** Told when a request is being retried, and when the table answers again. */
  onConnection: ((e: ConnectionEvent) => void) | null;
  /** Told when the player's queued lines of table talk reached the table, as the server placed them. */
  onSaid: ((lines: TalkLine[]) => void) | null;
  /** Told when queued lines will never be said, in the order they were queued, and why. */
  onTalkRefused: ((lines: string[], why: TalkNotSaid) => void) | null;
  /** The game is over: no more talk. */
  private ended = false;
  /** Lines the player typed, waiting for the next request (cleanTalk'd). */
  private talkQueue: string[] = [];
  private readonly fetch: typeof fetch;
  private readonly url: (route: string) => string;
  private readonly retryForMs: number;
  private readonly attemptTimeoutMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly storage: TableStorage | null;
  private token: string | null = null;
  private mode: 'play' | 'watch' = 'play';
  private seats: SeatConfig[] = [];
  /** The finished hands so far, by hand number, as the server sent them (metadata included). */
  private finished = new Map<number, ReviewHand>();
  /** The hand in play's actions as they came (watch mode: with their reasoning). */
  private metas: ActionMeta[] = [];
  /** Aborts every request in flight when the player leaves (forget). */
  private leaving = new AbortController();

  constructor(o: RemoteDriverOptions = {}) {
    this.fetch = o.fetch ?? ((input, init) => fetch(input, init));
    this.url = o.url ?? ((route) => appPath(`/api/table/${route}`));
    this.onConnection = o.onConnection ?? null;
    this.onSaid = o.onSaid ?? null;
    this.onTalkRefused = o.onTalkRefused ?? null;
    this.retryForMs = o.retryForMs ?? RETRY_FOR_MS;
    this.attemptTimeoutMs = o.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
    this.sleep = o.sleep ?? defaultSleep;
    this.now = o.now ?? (() => Date.now());
    this.storage = o.storage === undefined ? pageStorage() : o.storage;
  }

  /** The table kept in this browser that can be resumed, or null (none, unreadable, or too old: then it is cleared). */
  static saved(o: { storage?: TableStorage | null; now?: () => number } = {}): Resumable | null {
    const storage = o.storage === undefined ? pageStorage() : o.storage;
    const saved = readSaved(storage);
    if (!saved) return null;
    const ageMs = Math.max(0, (o.now ?? Date.now)() - saved.savedAt);
    if (ageMs > RESUMABLE_MS) {
      removeSaved(storage);
      return null;
    }
    return { mode: saved.mode, seats: saved.seats.map((s) => ({ ...s })), hand: saved.hand, savedAt: saved.savedAt, ageMs };
  }

  private emit(e: ConnectionEvent): void {
    try {
      this.onConnection?.(e);
    } catch {
      // the page's listener must not break the table
    }
  }

  /**
   * One request, retried while it fails for a passing reason (see the top of this file) for up to retryForMs, with the
   * same body each time. A refusal throws its TableError at once; giving up throws TableError 'failed'.
   */
  private async post<T>(route: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const started = this.now();
    const payload = JSON.stringify(body);
    // The page's signal (a step it gave up on) and the player leaving the table both stop the request and its retries.
    signal = signal ? AbortSignal.any([signal, this.leaving.signal]) : this.leaving.signal;
    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) throw new DOMException('The request was cancelled', 'AbortError');
      let status = 0;
      let why = 'no answer';
      let retryAfterMs = 0;
      try {
        const timeout = AbortSignal.timeout(this.attemptTimeoutMs);
        const res = await this.fetch(this.url(route), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        status = res.status;
        let data: unknown = null;
        try {
          data = await res.json();
        } catch (e) {
          if (signal?.aborted) throw e;
        }
        if (res.ok && isObj(data)) {
          if (attempt > 1) this.emit({ state: 'ok' });
          return data as T;
        }
        const b = (isObj(data) ? data : {}) as Partial<TableErrorBody> & { badToken?: boolean; expired?: boolean };
        const kind = errorKind(res.status, b);
        if (!(TRANSIENT.has(res.status) || kind === 'rate' || (res.ok && !isObj(data)))) {
          throw new TableError(kind, res.status, typeof b.error === 'string' ? b.error : `The table answered HTTP ${res.status}`, typeof b.walletUrl === 'string' ? b.walletUrl : undefined);
        }
        why = res.ok ? 'an unreadable answer' : `HTTP ${res.status}`;
        const after = Number(res.headers.get('retry-after'));
        if (Number.isFinite(after) && after > 0) retryAfterMs = after * 1000;
      } catch (e) {
        if (e instanceof TableError) throw e;
        if (signal?.aborted) throw (e as Error)?.name === 'AbortError' ? e : new DOMException('The request was cancelled', 'AbortError');
        why = (e as Error)?.name === 'TimeoutError' ? `no answer in ${Math.round(this.attemptTimeoutMs / 1000)} s` : 'no connection';
      }
      const nextInMs = Math.max(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1]!, retryAfterMs);
      if (this.now() - started + nextInMs > this.retryForMs) {
        throw new TableError('failed', status, "Couldn't reach the table. Check your connection and try again.");
      }
      this.emit({ state: 'reconnecting', attempt, nextInMs, error: why });
      await this.sleep(nextInMs, signal);
    }
  }

  private tokenOrThrow(): string {
    if (!this.token) throw new TableError('refused', 0, 'The table has not started');
    return this.token;
  }

  /** Keeps a finished hand, its actions' metadata filled in from the steps when the server left it out (watch). */
  private keep(hand: ReviewHand | undefined): void {
    if (!hand) return;
    const actions = hand.actions.map((x, i) => ({ ...recordedMeta(this.metas[i] ?? { by: x.by, latencyMs: 0 }), ...x }));
    this.finished.set(hand.hand, { ...hand, actions });
  }

  /** Keeps the table in this browser for a resume (cleared once the game is over), within MAX_SAVED_CHARS. */
  private save(snapshot: TableSnapshot): void {
    if (!this.storage || !this.token || this.leaving.signal.aborted) return;
    if (snapshot.over) return removeSaved(this.storage);
    const finished = [...this.finished.values()].sort((a, b) => a.hand - b.hand);
    try {
      for (;;) {
        const saved: SavedTable = { v: 1, token: this.token, mode: this.mode, seats: this.seats, hand: snapshot.hand, finished, metas: this.metas, savedAt: this.now() };
        const text = JSON.stringify(saved);
        if (text.length <= MAX_SAVED_CHARS || !finished.length) return this.storage.setItem(STORAGE_KEY, text);
        // Too big: the oldest finished hands go (the server's review still has their cards and moves).
        finished.splice(0, Math.max(1, Math.ceil(finished.length / 4)));
      }
    } catch {
      // full or blocked storage: the game goes on, it just can't be resumed
    }
  }

  /**
   * The player left the table: nothing is kept for a resume, and requests still in flight are cancelled (they reject
   * with an AbortError) so no late answer keeps the table again. A start or resume afterwards opens a new table.
   */
  forget(): void {
    this.leaving.abort();
    removeSaved(this.storage);
  }

  /** A new table (start, resume): the driver keeps it again. */
  private reopen(): void {
    if (this.leaving.signal.aborted) this.leaving = new AbortController();
    this.ended = false;
    this.talkQueue = [];
  }

  async start(config: TableConfig): Promise<TableSnapshot> {
    if (config.seats.some((s) => s.kind === 'bot')) throw new TableError('forbidden', 0, 'The table seats models and you, not bots');
    const mode = config.seats.some((s) => s.kind === 'human') ? 'play' : 'watch';
    const seats = config.seats.map((s) => ({ kind: s.kind, id: s.id }));
    this.reopen();
    const r = await this.post<SnapshotReply>('start', { mode, seats });
    this.token = r.token;
    this.mode = mode;
    this.seats = seats;
    this.finished.clear();
    this.metas = [];
    this.keep(r.finished);
    this.save(r.snapshot);
    return r.snapshot;
  }

  /**
   * Sits back down at the table kept in this browser (RemoteDriver.saved()): the table as its token has it. Throws
   * TableError 'refused' when there is none; when the server refuses it (expired, stale, unreadable) it is cleared.
   */
  async resume(): Promise<TableSnapshot> {
    const saved = readSaved(this.storage);
    if (!saved) throw new TableError('refused', 0, 'There is no table to go back to');
    this.reopen();
    let r: SnapshotReply;
    try {
      r = await this.post<SnapshotReply>('resume', { token: saved.token });
    } catch (e) {
      if (e instanceof TableError && e.kind !== 'failed' && e.kind !== 'rate') this.forget();
      throw e;
    }
    this.token = r.token;
    this.mode = saved.mode;
    this.seats = saved.seats;
    this.finished = new Map(saved.finished.map((h) => [h.hand, h]));
    // The hand in play's actions as they came, unless the table moved on (the answer that ended the hand was lost).
    this.metas = r.snapshot.hand === saved.hand ? saved.metas : [];
    this.ended = r.snapshot.over;
    this.keep(r.finished);
    this.save(r.snapshot);
    return r.snapshot;
  }

  /**
   * The player says something at the table: the line, cleaned and capped as the server will (cleanTalk), queued for the
   * next request. Returns the line as it will be said, or null when there is nothing to say, no table to play at (watch
   * mode has no human, the game is over), or MAX_QUEUED_TALK lines are already waiting.
   */
  say(text: string): string | null {
    const line = cleanTalk(text);
    if (!line || !this.token || this.ended || this.mode !== 'play' || this.talkQueue.length >= MAX_QUEUED_TALK) return null;
    this.talkQueue.push(line);
    return line;
  }

  private tell<A extends unknown[]>(f: ((...a: A) => void) | null, ...a: A): void {
    try {
      f?.(...a);
    } catch {
      // the page's listener must not break the table
    }
  }

  /**
   * Sends a request with the queued talk. The answer says which lines were said (onSaid) and which not (onTalkRefused,
   * after the said ones: the server places a batch's lines in order). A request that could not get through (no
   * connection, too fast) keeps its lines in front of the queue for the next one, which goes from the same token; one
   * the table refused takes its lines with it (onTalkRefused 'refused'). Once the game is over, what still waits is not
   * said ('over').
   */
  private async withTalk<T extends { talk?: TalkLine[]; talkRefused?: TalkRefused; result?: { talk?: TalkLine[]; snapshot: TableSnapshot }; snapshot?: TableSnapshot }>(route: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const talk = this.talkQueue.splice(0, MAX_TALK_LINES);
    let r: T;
    try {
      r = await this.post<T>(route, talk.length ? { ...body, talk } : body, signal);
    } catch (e) {
      if (e instanceof TableError && e.kind !== 'failed' && e.kind !== 'rate') {
        if (talk.length) this.tell(this.onTalkRefused, talk, 'refused');
      } else if ((e as Error)?.name !== 'AbortError') this.talkQueue.unshift(...talk);
      throw e;
    }
    const said = r.result?.talk ?? r.talk;
    if (said?.length) this.tell(this.onSaid, said);
    if (r.talkRefused?.lines.length) this.tell(this.onTalkRefused, r.talkRefused.lines, r.talkRefused.why);
    if ((r.result?.snapshot ?? r.snapshot)?.over) this.end();
    return r;
  }

  /** The game is over: nothing more is said, and what still waits never will be. */
  private end(): void {
    this.ended = true;
    const left = this.talkQueue.splice(0);
    if (left.length) this.tell(this.onTalkRefused, left, 'over');
  }

  private played(r: StepReply): StepResult {
    this.token = r.token;
    this.metas.push(r.result.meta);
    this.keep(r.finished);
    this.save(r.result.snapshot);
    return r.result;
  }

  async step(signal?: AbortSignal): Promise<StepResult> {
    return this.played(await this.withTalk<StepReply>('step', { token: this.tokenOrThrow() }, signal));
  }

  async act(action: Action): Promise<StepResult> {
    return this.played(await this.withTalk<StepReply>('act', { token: this.tokenOrThrow(), action }));
  }

  async nextHand(): Promise<TableSnapshot> {
    const r = await this.withTalk<SnapshotReply>('next', { token: this.tokenOrThrow() });
    this.token = r.token;
    this.metas = [];
    this.keep(r.finished);
    this.save(r.snapshot);
    return r.snapshot;
  }

  async review(): Promise<Review> {
    const r = await this.post<Review>('review', { token: this.tokenOrThrow() });
    // The server replays the hands; the talk, moods, tells and reasoning of past hands are only here.
    const hands = r.hands.map((h) => this.finished.get(h.hand) ?? h);
    const recording = r.recording && {
      ...r.recording,
      hands: r.recording.hands.map((h, i) => {
        const kept = this.finished.get(i + 1);
        const known = kept?.actions;
        const talk = h.talk ?? kept?.talk;
        const withTalk = talk?.length ? { ...h, talk } : h;
        return known && known.length === h.actions.length ? { ...withTalk, actions: h.actions.map((x, k) => ({ ...known[k], ...x })) } : withTalk;
      }),
    };
    return { players: r.players, hands, recording };
  }
}
