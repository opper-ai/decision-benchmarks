import { InvalidAnswer, normalise, type Adapter, type Answer } from '../shared/adapter.ts';
import { isMoveId } from '../shared/engine/moves.ts';
import type { Question } from '../shared/question.ts';
import { OPPER_BASE_URL, failure, headersFor, type HttpDeps } from './systemone.ts';

/** The situation as text: OpenAI's Decisions API takes a string input. */
const situation = (q: Question) =>
  Object.entries(q.context)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

export function toDecisions(q: Question, model: string) {
  return {
    model,
    input: situation(q),
    questions: [{ type: 'choice', name: 'move', instructions: q.instructions, choices: q.options.map((o) => ({ value: o.id, description: o.facts })) }],
  };
}

const WARM_UP = {
  input: 'warm-up',
  questions: [{ type: 'choice', name: 'warmup', instructions: 'Pick one.', choices: [{ value: 'a' }, { value: 'b' }] }],
};

/** A decision model through OpenAI's Decisions API (OpenAI itself, or Opper's /v3/compat/decisions). */
export function decisionsAdapter(model: string, deps: HttpDeps): Adapter {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? (() => performance.now());
  const url = deps.endpoint ?? `${(deps.baseUrl ?? OPPER_BASE_URL).replace(/\/+$/, '')}/v3/compat/decisions`;
  const post = (body: unknown, signal: AbortSignal) => f(url, { method: 'POST', headers: headersFor(deps), body: JSON.stringify(body), signal });
  return {
    id: model,
    kind: 'decisions',
    async warmUp() {
      const res = await post({ model, ...WARM_UP }, AbortSignal.timeout(60_000));
      if (!res.ok) throw await failure(res, model);
      await res.text();
    },
    async decide(q: Question, signal: AbortSignal): Promise<Answer> {
      const offered = q.options.map((o) => o.id);
      // The API needs at least two choices; a single legal move needs no call.
      if (offered.length < 2) return { move: offered[0], probabilities: { [offered[0]]: 1 }, latencyMs: 0, costUsd: 0 };
      const started = now();
      const res = await post(toDecisions(q, model), signal);
      if (!res.ok) throw await failure(res, model);
      const json = (await res.json()) as {
        answers?: { type?: string; choice?: unknown; probabilities?: { value?: unknown; probability?: unknown }[] }[];
        usage?: { input_tokens?: number };
      };
      const latencyMs = Math.round(now() - started);
      const a = json.answers?.[0];
      if (a?.type === 'refusal') throw new InvalidAnswer(`${model} declined to answer`);
      const choice = a?.choice;
      if (!isMoveId(choice) || !offered.includes(choice)) throw new InvalidAnswer(`${model} chose ${String(choice)}`);
      const probs = Object.fromEntries((a?.probabilities ?? []).filter((p) => typeof p.value === 'string').map((p) => [p.value as string, Number(p.probability)]));
      const cost = res.headers.get('x-opper-cost');
      return {
        move: choice,
        probabilities: normalise(probs, offered),
        latencyMs,
        costUsd: cost === null ? null : Number(cost),
        inputTokens: json.usage?.input_tokens,
        traceId: res.headers.get('x-opper-trace-id'),
      };
    },
  };
}
