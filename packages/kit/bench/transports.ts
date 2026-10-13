import { handleDecide } from '../server/decide.ts';
import type { Target } from '../server/systemone.ts';
import type { ChoiceQuestion, DecideResponse, SystemOneRequest, Transport } from '../shared/systemone.ts';

/**
 * How the bench reaches a model: Opper's (or TypeSafe's) System One API with a key, or the submitter's own endpoint,
 * speaking System One ({ state, questions } in, { answers } out) or OpenAI chat completions through an adapter.
 * Each returns a Transport bound to one model, which is what a game's `play` gets.
 */

/** A listed decision model through Opper (or jev through TypeSafe), with the key from the environment. */
export function systemOneTransport(model: string, target: Target | undefined, timeoutMs: number, callName = 'decision-benchmarks-bench'): Transport {
  return async (body) => {
    const r = await handleDecide({ ...body, model }, { apiKey: target?.apiKey, baseUrl: target?.baseUrl ?? '', provider: target?.provider, fetch, now: () => performance.now(), timeoutMs, callName });
    if (r.status !== 200) throw new Error((r.body as { error?: string }).error ?? `HTTP ${r.status}`);
    return r.body as DecideResponse;
  };
}

export interface EndpointOptions {
  url: string;
  /** Sent as a bearer token when set (BENCH_ENDPOINT_TOKEN). */
  token?: string;
  timeoutMs: number;
  /** The name the run goes by, reported as the model in responses. */
  name: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const authHeaders = (token?: string): Record<string, string> => ({ 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) });

/**
 * A model behind the submitter's own HTTP endpoint, speaking System One: it gets { state, questions } (no model, no
 * keys: those are for our server) and answers { answers: { <question>: { type: 'choice', choice, probabilities? } },
 * usage?, costUsd? }.
 */
export function endpointTransport(o: EndpointOptions): Transport {
  const f = o.fetch ?? fetch;
  const now = o.now ?? (() => performance.now());
  return async (body) => {
    const t0 = now();
    const res = await f(o.url, { method: 'POST', headers: authHeaders(o.token), body: JSON.stringify({ state: body.state, questions: body.questions }), signal: AbortSignal.timeout(o.timeoutMs) });
    if (!res.ok) throw new Error(`endpoint answered ${res.status}`);
    const out = (await res.json()) as { answers?: unknown; usage?: DecideResponse['usage']; costUsd?: number };
    if (!out.answers || typeof out.answers !== 'object') throw new Error('endpoint answer has no answers object');
    return {
      model: o.name,
      answers: out.answers as DecideResponse['answers'],
      usage: out.usage ?? { input_tokens: 0, output_tokens: 0 },
      latencyMs: Math.round(now() - t0),
      costUsd: typeof out.costUsd === 'number' ? out.costUsd : null,
      traceId: null,
    };
  };
}

/**
 * The JSON schema a chat model must answer one question with: a choice among the criteria keys, and a probability for
 * each. Every key is required, so a strict schema can hold them.
 */
export function chatSchema(options: readonly string[]) {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'decision',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['choice', 'probabilities'],
        properties: {
          choice: { type: 'string', enum: options },
          probabilities: {
            type: 'object',
            additionalProperties: false,
            required: [...options],
            properties: Object.fromEntries(options.map((o) => [o, { type: 'number' }])),
          },
        },
      },
    },
  };
}

const SYSTEM = 'You make one decision in a game. You get the game state as JSON, your instructions and the options. Answer only with JSON: your choice (one of the options) and a probability for each option.';

/** The user message for one question: the state, the instructions, and each option with what it means. */
export function chatPrompt(state: unknown, q: ChoiceQuestion): string {
  const options = Object.entries(q.criteria).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  return `State:\n${JSON.stringify(state)}\n\nInstructions:\n${q.instructions}\n\nOptions:\n${options}`;
}

export interface ChatOptions extends EndpointOptions {
  /** The model name the chat completions endpoint expects. */
  model: string;
  /** Room for models that reason before they answer. */
  maxTokens?: number;
}

/**
 * Any OpenAI-compatible chat completions endpoint (Opper's /v3/compat/chat/completions, a local server), forced
 * through a JSON schema to answer each question as System One would. One call per question, in parallel; a request's
 * latency is the slowest, its cost the sum (from x-opper-cost, when the endpoint sends it).
 */
export function chatTransport(o: ChatOptions): Transport {
  const f = o.fetch ?? fetch;
  const now = o.now ?? (() => performance.now());
  const ask = async (state: unknown, q: ChoiceQuestion, signal: AbortSignal) => {
    const options = Object.keys(q.criteria);
    const res = await f(o.url, {
      method: 'POST',
      headers: authHeaders(o.token),
      body: JSON.stringify({
        model: o.model,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: chatPrompt(state, q) },
        ],
        response_format: chatSchema(options),
        max_tokens: o.maxTokens ?? 1200,
      }),
      signal,
    });
    if (!res.ok) throw new Error(`${o.model} returned HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const cost = res.headers.get('x-opper-cost');
    let answer: unknown = null;
    try {
      const content = (data.choices?.[0]?.message?.content ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '');
      const parsed = JSON.parse(content) as { choice?: unknown; probabilities?: unknown };
      answer = { type: 'choice', choice: parsed.choice, probabilities: parsed.probabilities };
    } catch {
      // not JSON: the game's fallback decides
    }
    return { answer, usage: { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0 }, cost: cost === null ? null : Number(cost) };
  };
  return async (body: SystemOneRequest) => {
    const t0 = now();
    const signal = AbortSignal.timeout(o.timeoutMs);
    const names = Object.keys(body.questions);
    const results = await Promise.all(names.map((n) => ask(body.state, body.questions[n]!, signal)));
    const known = results.filter((r) => r.cost !== null && Number.isFinite(r.cost));
    return {
      model: o.name,
      answers: Object.fromEntries(names.map((n, i) => [n, results[i]!.answer])),
      usage: { input_tokens: results.reduce((a, r) => a + r.usage.input_tokens, 0), output_tokens: results.reduce((a, r) => a + r.usage.output_tokens, 0) },
      latencyMs: Math.round(now() - t0),
      costUsd: known.length ? known.reduce((a, r) => a + (r.cost as number), 0) : null,
      traceId: null,
    };
  };
}
