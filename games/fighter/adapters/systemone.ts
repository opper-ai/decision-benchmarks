import { InvalidAnswer, normalise, type Adapter, type Answer } from '../shared/adapter.ts';
import { isMoveId } from '../shared/engine/moves.ts';
import { toSystemOne, type Question } from '../shared/question.ts';

export interface HttpDeps {
  apiKey: string;
  baseUrl?: string;
  /** The full URL to call, overriding baseUrl and the usual path (custom endpoints). */
  endpoint?: string;
  /** Send Opper's X-Opper-Name tracing header (default true; other hosts may refuse it in CORS). */
  tag?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
}

export const OPPER_BASE_URL = 'https://api.opper.ai';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const WARM_UP = {
  state: { note: 'warm-up' },
  questions: { warmup: { type: 'choice', instructions: 'Pick one.', criteria: { a: 'Option A', b: 'Option B' } } },
};

export async function failure(res: Response, model: string): Promise<HttpError> {
  const text = await res.text().catch(() => '');
  let msg = text.slice(0, 300);
  try {
    const j = JSON.parse(text) as { error?: unknown };
    if (typeof j.error === 'string') msg = j.error;
    else if (j.error && typeof j.error === 'object' && 'message' in j.error) msg = String((j.error as { message: unknown }).message);
  } catch {
    // not JSON
  }
  return new HttpError(res.status, `${model} returned HTTP ${res.status}: ${msg}`);
}

export function headersFor(deps: HttpDeps): Record<string, string> {
  return {
    ...(deps.apiKey ? { Authorization: `Bearer ${deps.apiKey}` } : {}),
    'Content-Type': 'application/json',
    ...(deps.tag === false ? {} : { 'X-Opper-Name': 'jev-fighter-decide' }),
  };
}

/** A System One decision model (jev, kev, clef, laya) through Opper's /v3/compat/v1/systemone. */
export function systemOneAdapter(model: string, deps: HttpDeps): Adapter {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? (() => performance.now());
  const url = deps.endpoint ?? `${(deps.baseUrl ?? OPPER_BASE_URL).replace(/\/+$/, '')}/v3/compat/v1/systemone`;
  const post = (body: unknown, signal: AbortSignal) =>
    f(url, {
      method: 'POST',
      headers: headersFor(deps),
      body: JSON.stringify(body),
      signal,
    });
  return {
    id: model,
    kind: 'systemone',
    async warmUp() {
      const res = await post({ model, ...WARM_UP }, AbortSignal.timeout(60_000));
      if (!res.ok) throw await failure(res, model);
      await res.text();
    },
    async decide(q: Question, signal: AbortSignal): Promise<Answer> {
      const started = now();
      const res = await post(toSystemOne(q, model), signal);
      if (!res.ok) throw await failure(res, model);
      const json = (await res.json()) as { answers?: { move?: { choice?: unknown; probabilities?: unknown } }; usage?: { input_tokens?: number } };
      const latencyMs = Math.round(now() - started);
      const offered = q.options.map((o) => o.id);
      const choice = json.answers?.move?.choice;
      if (!isMoveId(choice) || !offered.includes(choice)) throw new InvalidAnswer(`${model} chose ${String(choice)}`);
      const cost = res.headers.get('x-opper-cost');
      return {
        move: choice,
        probabilities: normalise(json.answers?.move?.probabilities, offered),
        latencyMs,
        costUsd: cost === null ? null : Number(cost),
        inputTokens: json.usage?.input_tokens,
        traceId: res.headers.get('x-opper-trace-id'),
      };
    },
  };
}
