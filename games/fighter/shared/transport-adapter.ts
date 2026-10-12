// A decision model through the kit's Transport: the page's /api/decide (packages/kit/client/transport.ts) or the
// bench's transports (Opper, your endpoint, a chat model through the adapter). Isomorphic.
import { parseChoice, type Transport } from '../../../packages/kit/shared/systemone.ts';
import { InvalidAnswer, normalise, type Adapter, type Answer } from './adapter.ts';
import type { Question } from './question.ts';
import { QUESTION_NAME, toSystemOne } from './request.ts';

export interface TransportAdapterOptions {
  now?: () => number;
  /** Wakes the model up before a match (the page's /api/warm); the bench warms models itself. */
  warmUp?: () => Promise<void>;
}

/**
 * `model` as a fighter: each question goes out as one System One request naming the model, and the answer must pick one
 * of the offered moves (else InvalidAnswer, and the match's fallback plays). Latency is measured here, around the call.
 */
export function transportAdapter(model: string, transport: Transport, o: TransportAdapterOptions = {}): Adapter {
  const now = o.now ?? (() => performance.now());
  return {
    id: model,
    kind: 'systemone',
    warmUp: o.warmUp ?? (async () => {}),
    async decide(q: Question): Promise<Answer> {
      const started = now();
      const res = await transport(toSystemOne(q, model));
      const offered = q.options.map((o) => o.id);
      const parsed = parseChoice(res.answers[QUESTION_NAME], offered);
      if (!parsed) throw new InvalidAnswer(`${model} did not pick one of the offered moves`);
      return {
        move: parsed.choice,
        probabilities: normalise(parsed.probabilities, offered),
        latencyMs: Math.round(now() - started),
        costUsd: res.costUsd,
        ...(res.usage ? { inputTokens: res.usage.input_tokens } : {}),
        traceId: res.traceId,
      };
    },
  };
}
