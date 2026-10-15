import type { HttpRequest } from './auth.ts';

/**
 * The free credits: one Opper key (OPPER_POOL_API_KEY) for every game the service mounts, that pays for signed-out
 * visitors until the money behind it runs out. The key's organization balance is the pool, so topping up that organization on Opper refills it; there
 * is nothing to manage here. Opper itself stops the key at zero (HTTP 402), so the numbers below only steer the page:
 * the counter, and saying "sign in" before a game fails instead of after.
 */

/** How often the balance is read from Opper (GET /v3/me); in between, each call's cost is subtracted locally. */
export const POOL_REFRESH_MS = 30_000;
/** Largest /api/decide body the pool pays for: a game's state and a few questions are a few KB. */
export const MAX_POOL_BODY_BYTES = 16 * 1024;
/** Most questions in one request, for any key: no game asks more at once (Pac-Man's four ghosts and Pac-Man). */
export const MAX_QUESTIONS = 5;
export const POOL_EMPTY_MESSAGE = 'The free credits are used up. Sign in with Opper to keep playing on your own account.';
/** Every visitor together is sending faster than the free credits allow (POOL_GLOBAL_RATE_PER_SEC). */
export const POOL_BUSY_MESSAGE = 'The free credits are busy right now. Sign in with Opper to keep playing on your own account.';
/** Most the free credits may spend in an hour, across every visitor and game, unless POOL_BUDGET_USD_PER_HOUR says otherwise. */
export const DEFAULT_POOL_BUDGET_USD_PER_HOUR = 20;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

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
  /** Most the pool may spend in any hour (counted by the minute); closed above it until older spend ages out. Undefined: no cap. */
  budgetUsdPerHour?: number;
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
  /** Spend per minute (minute number to USD) over the last hour, for the hourly budget. */
  private readonly spentByMinute = new Map<number, number>();
  private overBudget = false;
  // A plain field, not a constructor parameter property: the server runs as stripped TypeScript, which has none.
  private readonly deps: PoolDeps;

  constructor(deps: PoolDeps) {
    this.deps = deps;
    this.refreshMs = deps.refreshMs ?? POOL_REFRESH_MS;
  }

  get apiKey(): string {
    return this.deps.apiKey;
  }

  /**
   * The last known status; starts a background refresh once it is older than refreshMs. Closed, too, while the last
   * hour's spend is at the hourly budget: signed-out visitors are asked to sign in, as when the balance runs out.
   */
  current(): PoolStatus {
    if (this.deps.now() - this.checkedAt >= this.refreshMs) void this.refresh();
    return this.checkBudget() ? { ...this.status } : { ...this.status, open: false };
  }

  /** USD spent in the last hour (by whole minutes), as far as Opper reported each call's cost. */
  spentLastHour(): number {
    const minute = Math.floor(this.deps.now() / MINUTE_MS);
    let sum = 0;
    for (const [m, usd] of this.spentByMinute) {
      if (m <= minute - HOUR_MS / MINUTE_MS) this.spentByMinute.delete(m);
      else sum += usd;
    }
    return sum;
  }

  /** Whether the hourly budget has room; logs once when it fills up and once when it has room again. */
  private checkBudget(): boolean {
    const budget = this.deps.budgetUsdPerHour;
    if (budget === undefined) return true;
    const spent = this.spentLastHour();
    const over = spent >= budget;
    if (over !== this.overBudget) {
      this.overBudget = over;
      this.deps.log?.(
        over
          ? `[pool] spent $${spent.toFixed(2)} in the last hour, the hourly budget of $${budget}: signed-out visitors are asked to sign in until it has room again`
          : `[pool] the hourly budget of $${budget} has room again: signed-out visitors play on the free credits`,
      );
    }
    return !over;
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
    if (costUsd === null || !Number.isFinite(costUsd) || costUsd <= 0) return;
    const minute = Math.floor(this.deps.now() / MINUTE_MS);
    this.spentByMinute.set(minute, (this.spentByMinute.get(minute) ?? 0) + costUsd);
    this.checkBudget();
    if (this.status.remainingUsd === null) return;
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
  const budgetUsdPerHour = positiveFromEnv(env, 'POOL_BUDGET_USD_PER_HOUR', DEFAULT_POOL_BUDGET_USD_PER_HOUR, log);
  const pool = new Pool({ apiKey, opperUrl, fetch, now: () => Date.now(), log, budgetUsdPerHour });
  void pool.refresh();
  return pool;
}

/** A positive number from the environment, else `fallback` (with a warning when the value is not one). */
export function positiveFromEnv(env: Record<string, string | undefined>, name: string, fallback: number, warn: (line: string) => void): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  warn(`[pool] ${name} must be a positive number, got ${JSON.stringify(raw.slice(0, 40))}; using ${fallback}`);
  return fallback;
}

/**
 * Fair use of the pool, per visitor (IP address): a request rate that fits a real game, so a script can't drain it in
 * minutes. One limiter for every game, so a visitor's allowance is the same however many games they open. On top, an
 * IPv6 /48 (what one site is usually given) gets four visitors' worth, and every visitor together shares one global
 * allowance, so many addresses can't drain it either. Kept in memory, so each server counts on its own; the hourly
 * budget and the pool's own balance are the hard limits.
 */
export interface LimitSettings {
  /** Requests per second, sustained, and the burst on top. A game against four AI ghosts makes about four a second. */
  ratePerSec: number;
  burst: number;
}

export const DEFAULT_LIMITS: LimitSettings = { ratePerSec: 8, burst: 40 };
/** Every signed-out visitor together: about ten games against four AI ghosts at once. */
export const DEFAULT_GLOBAL_LIMITS: LimitSettings = { ratePerSec: 400, burst: 1200 };
/** An IPv6 /48 gets this many visitors' allowance. */
export const NETWORK_FACTOR = 4;
/** `rate`: this visitor (or their network) sends too fast; `busy`: every visitor together does. */
export type LimitVerdict = 'ok' | 'rate' | 'busy';
const MAX_TRACKED = 50_000;

type Bucket = { tokens: number; at: number };

/** POOL_GLOBAL_RATE_PER_SEC and POOL_GLOBAL_BURST, else DEFAULT_GLOBAL_LIMITS. */
export function globalLimitsFromEnv(env: Record<string, string | undefined>, warn: (line: string) => void): LimitSettings {
  return {
    ratePerSec: positiveFromEnv(env, 'POOL_GLOBAL_RATE_PER_SEC', DEFAULT_GLOBAL_LIMITS.ratePerSec, warn),
    burst: positiveFromEnv(env, 'POOL_GLOBAL_BURST', DEFAULT_GLOBAL_LIMITS.burst, warn),
  };
}

export class VisitorLimits {
  private readonly buckets = new Map<string, Bucket>();
  private readonly global: Bucket;
  private globalBusy = false;

  private readonly settings: LimitSettings;
  private readonly network: LimitSettings;
  private readonly globalSettings: LimitSettings;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(settings: LimitSettings = DEFAULT_LIMITS, now: () => number = () => Date.now(), globalSettings: LimitSettings = DEFAULT_GLOBAL_LIMITS, log: (line: string) => void = () => {}) {
    this.settings = settings;
    this.network = { ratePerSec: settings.ratePerSec * NETWORK_FACTOR, burst: settings.burst * NETWORK_FACTOR };
    this.globalSettings = globalSettings;
    this.now = now;
    this.log = log;
    this.global = { tokens: globalSettings.burst, at: now() };
  }

  /** The tracked bucket for `key`, refilled to now and moved to the end (most recently seen). */
  private bucket(key: string, settings: LimitSettings, now: number): Bucket {
    const b = this.buckets.get(key) ?? { tokens: settings.burst, at: now };
    refill(b, settings, now);
    // Most recently seen last (a Map keeps insertion order), so a full table drops the visitors idle longest, not all.
    this.buckets.delete(key);
    this.buckets.set(key, b);
    for (const old of this.buckets.keys()) {
      if (this.buckets.size <= MAX_TRACKED) break;
      this.buckets.delete(old);
    }
    return b;
  }

  /**
   * Takes one request (or `cost` of them, all or none) from the visitor's allowance, their /48's and the global one, or
   * says which is spent. A refused request takes nothing, so one visitor sending too fast does not use up everybody
   * else's allowance.
   */
  take(visitor: string, cost = 1): LimitVerdict {
    const now = this.now();
    const own = this.bucket(visitorKey(visitor), this.settings, now);
    const net = networkKey(visitor);
    const shared = net === null ? null : this.bucket(net, this.network, now);
    if (own.tokens < cost || (shared && shared.tokens < cost)) return 'rate';
    refill(this.global, this.globalSettings, now);
    if (this.global.tokens < cost) {
      if (!this.globalBusy) this.log(`[pool] every visitor together is above ${this.globalSettings.ratePerSec} requests a second: signed-out visitors are asked to sign in`);
      this.globalBusy = true;
      return 'busy';
    }
    if (this.globalBusy) this.log('[pool] the global request rate is back under its limit');
    this.globalBusy = false;
    own.tokens -= cost;
    if (shared) shared.tokens -= cost;
    this.global.tokens -= cost;
    return 'ok';
  }
}

function refill(b: Bucket, settings: LimitSettings, now: number): void {
  b.tokens = Math.min(settings.burst, b.tokens + (Math.max(0, now - b.at) / 1000) * settings.ratePerSec);
  b.at = now;
}

/** An IPv6 address's eight groups, without leading zeros, or null for anything else. */
function ipv6Groups(ip: string): string[] | null {
  if (!ip.includes(':') || /^(?:::ffff:)?\d{1,3}(?:\.\d{1,3}){3}$/i.test(ip)) return null;
  const [head = '', tail = ''] = ip.split('%')[0]!.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return full.map((h) => h.replace(/^0+(?=.)/, ''));
}

/** The /48 network an IPv6 address is in, e.g. `2001:db8:1::/48`; null for IPv4. */
export function networkKey(ip: string): string | null {
  const groups = ipv6Groups(ip);
  return groups ? `${groups.slice(0, 3).join(':')}::/48` : null;
}

/**
 * Who a rate limit counts: an IPv4 address as is, an IPv6 address by its /64 network (one connection usually holds a
 * whole /64, so counting addresses one by one would give each of them a fresh allowance).
 */
export function visitorKey(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1]!;
  const groups = ipv6Groups(ip);
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : ip;
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

/** TRUSTED_PROXIES, else 2 in production (CloudFront and the load balancer), else 0. */
export function trustedProxiesFromEnv(env: Record<string, string | undefined>): number {
  const n = Number(env.TRUSTED_PROXIES);
  if (env.TRUSTED_PROXIES !== undefined && env.TRUSTED_PROXIES.trim() !== '' && Number.isInteger(n) && n >= 0) return n;
  return env.NODE_ENV === 'production' ? 2 : 0;
}
