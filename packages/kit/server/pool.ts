import type { HttpRequest } from './auth.ts';
import { GAME_WORDS } from '../shared/game-words.ts';

/**
 * The free credits: a public Opper key (OPPER_POOL_API_KEY) that pays for signed-out visitors until the money behind
 * it runs out. The key's organization balance is the pool, so topping up that organization on Opper refills it; there
 * is nothing to manage here. Opper itself stops the key at zero (HTTP 402), so the numbers below only steer the page:
 * the counter, and saying "sign in" before a game fails instead of after.
 */

/** How often the balance is read from Opper (GET /v3/me); in between, each call's cost is subtracted locally. */
export const POOL_REFRESH_MS = 30_000;
/** Largest /api/decide body the pool pays for. A real request is at most ~5 KB (four questions); the cap is 3×. */
export const MAX_POOL_BODY_BYTES = 16 * 1024;
/** Most questions in one pool request: Pac-Man and the four ghosts never ask more than four at once. */
export const MAX_POOL_QUESTIONS = 5;
export const POOL_EMPTY_MESSAGE = 'The free credits are used up. Sign in with Opper to keep playing on your own account.';

export interface PoolStatus {
  /** Whether the pool pays for signed-out play right now. */
  open: boolean;
  /** The balance in USD, or null when Opper doesn't show it to this key (its owner lacks billing:read). */
  remainingUsd: number | null;
}

export interface PoolDeps {
  apiKey: string;
  opperUrl: string;
  fetch: typeof fetch;
  now: () => number;
  log?: (line: string) => void;
  refreshMs?: number;
}

/** What GET /v3/me says about the key's money: blocked means Opper rejects new spend. */
export function statusFromMe(body: unknown): PoolStatus | null {
  if (!body || typeof body !== 'object') return null;
  const me = body as { blocked?: unknown; balance?: { balance_cents?: unknown } };
  const cents = typeof me.balance?.balance_cents === 'number' && Number.isFinite(me.balance.balance_cents) ? me.balance.balance_cents : null;
  const blocked = me.blocked === true;
  return { open: !blocked && (cents === null || cents > 0), remainingUsd: cents === null ? null : Math.max(0, cents) / 100 };
}

export class Pool {
  private status: PoolStatus = { open: true, remainingUsd: null };
  private checkedAt = Number.NEGATIVE_INFINITY;
  private pending: Promise<PoolStatus> | null = null;
  private readonly refreshMs: number;
  // A plain field, not a constructor parameter property: the server runs as stripped TypeScript, which has none.
  private readonly deps: PoolDeps;

  constructor(deps: PoolDeps) {
    this.deps = deps;
    this.refreshMs = deps.refreshMs ?? POOL_REFRESH_MS;
  }

  get apiKey(): string {
    return this.deps.apiKey;
  }

  /** The last known status; starts a background refresh once it is older than refreshMs. */
  current(): PoolStatus {
    if (this.deps.now() - this.checkedAt >= this.refreshMs) void this.refresh();
    return { ...this.status };
  }

  /** Reads the balance from Opper now (one request at a time). A failed read keeps the last status: Opper still stops the key at zero. */
  refresh(): Promise<PoolStatus> {
    this.pending ??= (async () => {
      try {
        const res = await this.deps.fetch(`${this.deps.opperUrl.replace(/\/+$/, '')}/v3/me`, {
          headers: { Authorization: `Bearer ${this.deps.apiKey}` },
          signal: AbortSignal.timeout(5000),
        });
        if (res.status === 401) {
          this.deps.log?.('[pool] OPPER_POOL_API_KEY was rejected by Opper; the free credits are off');
          this.status = { open: false, remainingUsd: 0 };
        } else if (res.ok) {
          const next = statusFromMe(await res.json());
          if (next) this.status = next;
        } else {
          this.deps.log?.(`[pool] reading the balance failed: HTTP ${res.status}`);
        }
      } catch (err) {
        this.deps.log?.(`[pool] reading the balance failed: ${(err as Error)?.message ?? String(err)}`);
      } finally {
        this.checkedAt = this.deps.now();
        this.pending = null;
      }
      return { ...this.status };
    })();
    return this.pending;
  }

  /** A call the pool paid for: keeps the counter moving between refreshes, and asks Opper again once it reaches zero. */
  spent(costUsd: number | null): void {
    if (costUsd === null || !Number.isFinite(costUsd) || costUsd <= 0 || this.status.remainingUsd === null) return;
    this.status = { ...this.status, remainingUsd: Math.max(0, this.status.remainingUsd - costUsd) };
    if (this.status.remainingUsd === 0) void this.refresh();
  }

  /** Opper refused a call for money (402): closed until the next refresh finds a top-up. */
  exhausted(): void {
    this.status = { open: false, remainingUsd: 0 };
    this.checkedAt = this.deps.now();
  }
}

export function poolFromEnv(env: Record<string, string | undefined>, opperUrl: string, log: (line: string) => void): Pool | undefined {
  const apiKey = env.OPPER_POOL_API_KEY?.trim();
  if (!apiKey) return undefined;
  const pool = new Pool({ apiKey, opperUrl, fetch, now: () => Date.now(), log });
  void pool.refresh();
  return pool;
}

/**
 * Fair use of the pool, per visitor (IP address): a request rate that fits a real game, so a script can't drain it in
 * minutes. Kept in memory, so each server counts on its own; the pool's own balance is the hard limit.
 */
export interface LimitSettings {
  /** Requests per second, sustained, and the burst on top. A game against four AI ghosts makes about four a second. */
  ratePerSec: number;
  burst: number;
}

export const DEFAULT_LIMITS: LimitSettings = { ratePerSec: 8, burst: 40 };
export type LimitVerdict = 'ok' | 'rate';
const MAX_TRACKED = 50_000;

export class VisitorLimits {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  private readonly settings: LimitSettings;
  private readonly now: () => number;

  constructor(settings: LimitSettings = DEFAULT_LIMITS, now: () => number = () => Date.now()) {
    this.settings = settings;
    this.now = now;
  }

  /** Takes one request from the visitor's allowance, or says it is sending too fast. */
  take(visitor: string): LimitVerdict {
    const now = this.now();
    const key = visitorKey(visitor);
    const b = this.buckets.get(key) ?? { tokens: this.settings.burst, at: now };
    b.tokens = Math.min(this.settings.burst, b.tokens + ((now - b.at) / 1000) * this.settings.ratePerSec);
    b.at = now;
    // Most recently seen last (a Map keeps insertion order), so a full table drops the visitors idle longest, not all.
    this.buckets.delete(key);
    this.buckets.set(key, b);
    for (const old of this.buckets.keys()) {
      if (this.buckets.size <= MAX_TRACKED) break;
      this.buckets.delete(old);
    }
    if (b.tokens < 1) return 'rate';
    b.tokens -= 1;
    return 'ok';
  }
}

/**
 * Who a rate limit counts: an IPv4 address as is, an IPv6 address by its /64 network (one connection usually holds a
 * whole /64, so counting addresses one by one would give each of them a fresh allowance).
 */
export function visitorKey(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1]!;
  if (!ip.includes(':')) return ip;
  const [head = '', tail = ''] = ip.split('%')[0]!.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${full.slice(0, 4).map((h) => h.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * The visitor's IP address. Behind proxies that each append to X-Forwarded-For (on Opper's ECS: CloudFront, then the
 * load balancer), the address the first trusted proxy saw is `trustedProxies` entries from the end; anything before it
 * was sent by the client and can be made up. With no trusted proxies, the connection's own address.
 */
export function clientIp(req: HttpRequest, trustedProxies: number): string {
  if (trustedProxies > 0) {
    const raw = req.headers['x-forwarded-for'];
    const hops = (Array.isArray(raw) ? raw.join(',') : (raw ?? '')).split(',').map((s) => s.trim()).filter(Boolean);
    const ip = hops[hops.length - trustedProxies];
    if (ip) return ip;
  }
  return req.remoteAddress ?? 'unknown';
}

/** JEV_TRUSTED_PROXIES, else 2 in production (CloudFront and the load balancer), else 0. */
export function trustedProxiesFromEnv(env: Record<string, string | undefined>): number {
  const n = Number(env.JEV_TRUSTED_PROXIES);
  if (env.JEV_TRUSTED_PROXIES !== undefined && env.JEV_TRUSTED_PROXIES.trim() !== '' && Number.isInteger(n) && n >= 0) return n;
  return env.NODE_ENV === 'production' ? 2 : 0;
}

const QUESTION_NAMES = new Set(['pacman', 'pacman_escape', 'blinky', 'pinky', 'inky', 'clyde']);
const DIRS = new Set(['up', 'down', 'left', 'right']);
const MAZE_ROW = /^[#\-. oFPBKICbkice_|=]{1,40}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Text made only of the game's own words, numbers and punctuation: what the game's questions are written in. */
export function gameText(text: unknown, max: number): boolean {
  // Printable ASCII only (and the dash in "FRUIT —"): other scripts would slip words past the vocabulary.
  if (typeof text !== 'string' || text.length > max || /[^\x20-\x7E\u2014]/.test(text)) return false;
  for (const w of text.toLowerCase().match(/[a-z][a-z'-]*/g) ?? []) if (!GAME_WORDS.has(w.replace(/^[-']+|[-']+$/g, '')) && !GAME_WORDS.has(w.replace(/'s$/, ''))) return false;
  return true;
}

/** The state's other fields: numbers, flags, game words, or small objects of those (positions, the fruit). */
function stateValue(v: unknown, depth = 0): boolean {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return true;
  if (typeof v === 'string') return gameText(v, 300);
  if (depth >= 3) return false;
  if (Array.isArray(v)) return v.length <= 16 && v.every((x) => stateValue(x, depth + 1));
  return isObj(v) && Object.keys(v).length <= 16 && Object.entries(v).every(([k, x]) => k.length <= 32 && stateValue(x, depth + 1));
}

/**
 * Whether a decide body is what the game sends (the pool pays only for that): at most five questions named for
 * Pac-Man or a ghost, each a choice between directions, worded in the game's own words, about a maze state. So the
 * shared key can't be used to ask a model anything else.
 */
export function poolAcceptsBody(raw: string): boolean {
  if (Buffer.byteLength(raw, 'utf8') > MAX_POOL_BODY_BYTES) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!isObj(parsed) || Object.keys(parsed).some((k) => !['model', 'state', 'questions', 'keys'].includes(k))) return false;
  const { questions, state, keys } = parsed;
  if (!isObj(questions) || Object.keys(questions).length === 0 || Object.keys(questions).length > MAX_POOL_QUESTIONS) return false;
  for (const [name, q] of Object.entries(questions)) {
    if (!QUESTION_NAMES.has(name) || !isObj(q) || q.type !== 'choice' || !gameText(q.instructions, 1500) || !isObj(q.criteria)) return false;
    const criteria = Object.entries(q.criteria);
    if (criteria.length < 2 || criteria.length > 4) return false;
    if (!criteria.every(([dir, text]) => DIRS.has(dir) && typeof text === 'string' && text.startsWith(`Go ${dir}: `) && gameText(text, 700))) return false;
  }
  if (!isObj(state) || !Array.isArray(state.maze) || state.maze.length > 40 || !state.maze.every((row) => typeof row === 'string' && MAZE_ROW.test(row))) return false;
  if (!Object.entries(state).every(([k, v]) => k === 'maze' || (k.length <= 32 && stateValue(v)))) return false;
  if (keys !== undefined && (!isObj(keys) || Object.keys(keys).length > MAX_POOL_QUESTIONS || !Object.values(keys).every((k) => typeof k === 'string' && k.length <= 64 && /^[\x21-\x7E]+$/.test(k)))) return false;
  return true;
}
