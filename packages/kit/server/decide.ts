import { clearSessionCookie, crossSite, header, json, sessionFrom, WALLET_URL, type AuthConfig, type HttpRequest, type HttpResponse } from './auth.ts';
import { signAnswers } from './answers.ts';
import { endpointFor, TYPESAFE_USD_PER_INPUT_TOKEN, upstreamModel, type Provider, type Target } from './systemone.ts';
import { clientIp, MAX_QUESTIONS, POOL_EMPTY_MESSAGE, type Pool, type VisitorLimits } from './pool.ts';
import type { SessionData } from './session.ts';
import type { GameServer } from '../shared/game.ts';
import { DEFAULT_MODEL, isModelId, modelName } from '../shared/models.ts';
import { WARM_UP_REQUEST, type SystemOneRequest } from '../shared/systemone.ts';

/** Whose key pays: a signed-in player's, the free credits' (signed out), or the local one from .env. */
export type KeyMode = 'player' | 'pool' | 'dev';

/** The free credits and their fair-use limits, when OPPER_POOL_API_KEY is set: one of each for every game. */
export interface PoolAccess {
  pool: Pool;
  limits: VisitorLimits;
  trustedProxies: number;
}

/** The answer that tells the page the free credits can't pay (any more): sign in to play on your own account. */
const poolEmpty = (status: number): DecideResult => ({ status, body: { error: POOL_EMPTY_MESSAGE, signedOut: true, poolEmpty: true } });

export interface DecideDeps {
  apiKey: string | undefined;
  baseUrl: string;
  fetch: typeof fetch;
  now: () => number;
  timeoutMs?: number;
  log?: (line: string) => void;
  keyMode?: KeyMode;
  /** Which System One API `baseUrl` points at (default Opper). */
  provider?: Provider;
  /** Sent to Opper as X-Opper-Name, so traces show which game called. */
  callName?: string;
}

export interface DecideResult {
  status: number;
  body: unknown;
}

function isDecideInput(v: unknown): v is SystemOneRequest {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o.state !== undefined && !!o.questions && typeof o.questions === 'object' && Object.keys(o.questions).length > 0;
}

function upstreamMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // not JSON; use the raw text
  }
  return text.slice(0, 200);
}

/**
 * One System One call: checks the model against the list (the default when the request names none), calls it with
 * the key in `deps`, and maps the upstream answer for the page. Used by the server and by the bench.
 */
export async function handleDecide(input: unknown, deps: DecideDeps): Promise<DecideResult> {
  const apiKey = deps.apiKey;
  const redact = (s: string): string => (apiKey ? s.split(apiKey).join('[redacted]') : s);
  const rawLog = deps.log ?? (() => {});
  const log = (line: string): void => rawLog(redact(line));
  const provider = deps.provider ?? 'opper';
  const tag = `[${['decide', deps.keyMode, provider === 'typesafe' ? 'typesafe' : undefined].filter(Boolean).join(' ')}]`;
  const timeoutMs = deps.timeoutMs ?? 2000;
  if (!deps.apiKey) return { status: 500, body: { error: 'No TYPESAFE_API_KEY or OPPER_API_KEY in .env: every decision is a fallback' } };
  if (!isDecideInput(input)) return { status: 400, body: { error: 'Expected { state, questions } with at least one question' } };
  const requested = input.model ?? DEFAULT_MODEL;
  if (!isModelId(requested)) return { status: 400, body: { error: `Unknown decision model: ${typeof requested === 'string' ? requested.slice(0, 80) : typeof requested}` } };
  const model = upstreamModel(provider, requested);
  const label = modelName(requested);
  if (model === null) return { status: 400, body: { error: `A TypeSafe key only reaches ${modelName(DEFAULT_MODEL)}; ${label} needs an Opper key` } };

  const actors = `${Object.keys(input.questions).join(',')}${requested === DEFAULT_MODEL ? '' : ` (${requested})`}`;
  const started = deps.now();
  try {
    const res = await deps.fetch(endpointFor({ provider, baseUrl: deps.baseUrl }), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        'Content-Type': 'application/json',
        ...(provider === 'opper' ? { 'X-Opper-Name': deps.callName ?? 'decision-benchmarks' } : {}),
      },
      body: JSON.stringify({ model, state: input.state, questions: input.questions }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const latencyMs = Math.round(deps.now() - started);
    if (!res.ok) {
      const error = redact(`${label} returned HTTP ${res.status}: ${upstreamMessage(redact(text))}`);
      log(`${tag} ${actors} failed after ${latencyMs} ms: ${error}`);
      if (deps.keyMode === 'player') {
        if (res.status === 401) return { status: 401, body: { error: 'Your Opper sign-in has expired. Sign in again to keep playing.', signedOut: true, clearSession: true } };
        if (res.status === 402) return { status: 402, body: { error: 'Your Opper wallet is empty. Top it up to keep playing.', walletUrl: WALLET_URL } };
      }
      // The free credits ran out (or their key was revoked): the page asks the visitor to sign in.
      if (deps.keyMode === 'pool' && (res.status === 401 || res.status === 402)) return poolEmpty(402);
      // The local key: a rejected key or an empty wallet won't fix itself either (no sign-in to redo, though).
      if (deps.keyMode === 'dev' && (res.status === 401 || res.status === 402)) {
        return { status: res.status, body: { error: res.status === 401 ? 'The API key in .env was rejected' : "The API key's Opper wallet is empty" } };
      }
      // Any key can lack access to a listed model; that is not a passing upstream error.
      if (res.status === 403) {
        const whose = deps.keyMode === 'player' ? 'your Opper account' : deps.keyMode === 'pool' ? 'the free credits' : 'this API key';
        return { status: 403, body: { error: `${label} is not enabled for ${whose}` } };
      }
      return { status: 502, body: { error } };
    }
    const json = JSON.parse(text) as { answers?: Record<string, unknown>; usage?: { input_tokens: number; output_tokens: number } };
    const usage = json.usage ?? { input_tokens: 0, output_tokens: 0 };
    if (provider === 'typesafe') {
      // TypeSafe sends no cost header; estimate from its published input-token price.
      const tokens = Number(json.usage?.input_tokens);
      const costUsd = Number.isFinite(tokens) ? tokens * TYPESAFE_USD_PER_INPUT_TOKEN : null;
      const requestId = res.headers.get('x-typesafe-request-id');
      log(`${tag} ${actors} ok in ${latencyMs} ms, cost ${costUsd === null ? '?' : `≈${Number(costUsd.toPrecision(2))}`} USD, request ${requestId ?? '?'}`);
      return { status: 200, body: { model: requested, answers: json.answers ?? {}, usage, latencyMs, costUsd, costEstimated: true, traceId: requestId } };
    }
    const cost = res.headers.get('x-opper-cost');
    const traceId = res.headers.get('x-opper-trace-id');
    log(`${tag} ${actors} ok in ${latencyMs} ms, cost ${cost ?? '?'} USD, trace ${traceId ?? '?'}`);
    return { status: 200, body: { model: requested, answers: json.answers ?? {}, usage, latencyMs, costUsd: cost === null ? null : Number(cost), traceId } };
  } catch (err) {
    const e = err as Error;
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    const error = timedOut ? `${label} timed out after ${timeoutMs} ms` : redact(`${label} request failed: ${e?.message ?? String(err)}`);
    log(`${tag} ${actors} ${error}`);
    return { status: timedOut ? 504 : 502, body: { error } };
  }
}

/**
 * Where a decide call goes: the signed-in player's key (always via Opper), else the free credits while they last,
 * else the server's dev key, else nowhere.
 */
export function resolveKey(session: SessionData | null, devKey: Target | undefined, opperUrl: string, pool?: Pool): (Target & { mode: KeyMode }) | null {
  if (session) return { provider: 'opper', apiKey: session.apiKey, baseUrl: opperUrl, mode: 'player' };
  if (pool?.current().open) return { provider: 'opper', apiKey: pool.apiKey, baseUrl: opperUrl, mode: 'pool' };
  if (devKey) return { ...devKey, mode: 'dev' };
  return null;
}

export interface DecideRequestDeps {
  fetch: typeof fetch;
  now: () => number;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

/** What /api/decide needs to know about the game it serves and the keys it may use. */
export interface DecideContext {
  game: GameServer;
  cfg: AuthConfig;
  devKey?: Target;
  access?: PoolAccess;
  /** The game's answer-signing key (answers.ts). */
  answerKey: Buffer;
}

/**
 * The answer to a /api/decide request that is refused before its body matters, or null to go ahead:
 * 405 for anything but POST, 403 cross-site, 415 unless JSON (a cross-site form can post text/plain
 * without a CORS preflight), and 401 `signedOut` when there is neither a session nor a dev key, or 402 `poolEmpty`
 * when the free credits would have paid but have run out.
 */
export function rejectDecideRequest(req: HttpRequest, cfg: AuthConfig, devKey: Target | undefined, access?: PoolAccess): HttpResponse | null {
  if (req.method !== 'POST') return json(405, { error: 'POST only' }, [], { Allow: 'POST' });
  if (crossSite(req, cfg)) return json(403, { error: 'Cross-site request refused' });
  if (!header(req, 'content-type').toLowerCase().startsWith('application/json')) return json(415, { error: 'Expected application/json' });
  if (!resolveKey(sessionFrom(req, cfg), devKey, cfg.opperUrl, access?.pool)) {
    if (access) {
      const r = poolEmpty(402);
      return json(r.status, r.body);
    }
    return json(401, { error: 'Sign in with Opper to let the AI play', signedOut: true });
  }
  return null;
}

/**
 * Fair use of the free credits, checked once per request before its body is read: 429 when a visitor sends faster
 * than a game does. The limiter is shared by every game.
 */
export function poolLimitRequest(req: HttpRequest, cfg: AuthConfig, devKey: Target | undefined, access: PoolAccess | undefined): HttpResponse | null {
  if (!access || resolveKey(sessionFrom(req, cfg), devKey, cfg.opperUrl, access.pool)?.mode !== 'pool') return null;
  const verdict = access.limits.take(clientIp(req, access.trustedProxies));
  if (verdict === 'rate') return json(429, { error: 'Too many requests for the free credits; slow down a little' }, [], { 'Retry-After': '1' });
  return null;
}

/** A cold Opper-hosted model can take many seconds to answer its first call after being idle. */
export const WARM_TIMEOUT_MS = 15_000; // a warm-up accepted late in the 5 s drain still ends before the 25 s shutdown deadline

/**
 * /api/decide, independent of the HTTP server: picks the key, has the game rebuild or check the request (any key: the
 * service only forwards what its games ask), calls the model, signs the answers with the game's key, and turns
 * `clearSession` into a Set-Cookie. With `warm` it is /api/warm: one fixed tiny call with a long timeout, so a model
 * that has been idle is awake before it has to play; the body only names the model.
 */
export async function handleDecideRequest(ctx: DecideContext, req: HttpRequest, rawBody: string, deps: DecideRequestDeps, opts: { warm?: boolean } = {}): Promise<HttpResponse> {
  const { cfg, devKey, access } = ctx;
  const refused = rejectDecideRequest(req, cfg, devKey, access);
  if (refused) return refused;
  const key = resolveKey(sessionFrom(req, cfg), devKey, cfg.opperUrl, access?.pool)!;
  const redact = (s: string) => [key.apiKey, devKey?.apiKey].reduce<string>((acc, k) => (k ? acc.split(k).join('[redacted]') : acc), s);
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return json(400, { error: 'Bad JSON' });
    }
    let input: SystemOneRequest;
    let keys: Record<string, string> | undefined;
    let as: string | undefined;
    if (opts.warm) {
      const model = parsed && typeof parsed === 'object' ? (parsed as { model?: unknown }).model : undefined;
      input = { ...(model === undefined ? {} : { model: model as string }), ...WARM_UP_REQUEST };
    } else {
      // The game's own check comes first: nothing it would not send reaches a model, whoever pays.
      const verdict = ctx.game.decideRequest(parsed);
      if (!verdict.ok) return json(400, { error: verdict.error });
      const n = Object.keys(verdict.request.questions ?? {}).length;
      if (n < 1 || n > MAX_QUESTIONS || Object.keys(verdict.keys ?? {}).length > MAX_QUESTIONS) return json(400, { error: `One to ${MAX_QUESTIONS} questions a call` });
      ({ request: input, keys, as } = verdict);
    }
    // Only the models the game plays, warm-up included: nothing else reaches upstream, whoever pays.
    const upstream = input.model ?? DEFAULT_MODEL;
    if (ctx.game.models && !ctx.game.models.includes(upstream)) return json(400, { error: `This game does not play ${String(upstream).slice(0, 80)}` });
    const result = await handleDecide(input, {
      apiKey: key.apiKey,
      keyMode: key.mode,
      provider: key.provider,
      baseUrl: key.baseUrl,
      fetch: deps.fetch,
      now: deps.now,
      log: deps.log,
      callName: `decision-benchmarks-${ctx.game.slug}`,
      ...(opts.warm ? { timeoutMs: WARM_TIMEOUT_MS } : {}),
    });
    const { clearSession, ...body } = result.body as Record<string, unknown>;
    // Sign each answer for its key, question, choice and model: a high-score entry may only replay these.
    if (!opts.warm && result.status === 200) {
      const model = as ?? input.model ?? DEFAULT_MODEL;
      body.model = model;
      body.signatures = signAnswers(ctx.answerKey, keys, (body.answers ?? {}) as Record<string, unknown>, model);
      body.signedAs = model;
    }
    if (key.mode === 'pool' && access) {
      if (body.poolEmpty) access.pool.exhausted();
      access.pool.spent(typeof body.costUsd === 'number' ? body.costUsd : null);
    }
    return json(result.status, body, clearSession ? [clearSessionCookie(cfg)] : []);
  } catch (err) {
    deps.logError?.(`[${ctx.game.slug}] /api/${opts.warm ? 'warm' : 'decide'} failure: ${redact((err as Error)?.message ?? String(err))}`);
    return json(500, { error: 'internal error in /api/decide' });
  }
}
