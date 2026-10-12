import { InvalidAnswer, normalise, type Adapter, type Answer } from '../shared/adapter.ts';
import { isMoveId, type MoveId } from '../shared/engine/moves.ts';
import { questionText, type Question } from '../shared/question.ts';
import { HttpError, OPPER_BASE_URL, headersFor, type HttpDeps } from './systemone.ts';

const SYSTEM =
  'You are playing a fighting game as one of the fighters. You will get the situation and the legal moves. ' +
  'Answer only with JSON: your move (choice), your confidence that it is the best choice (0 to 1), and up to two other moves with their probabilities.';

/**
 * A short answer: generating a probability for every move costs a second or more of output. The keys
 * sort alphabetically in the order we want them streamed (choice first), because the gateway currently
 * re-sorts schema properties.
 */
export function chatSchema(moves: MoveId[]) {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'fight_move',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['choice', 'confidence', 'others'],
        properties: {
          choice: { type: 'string', enum: moves },
          confidence: { type: 'number' },
          others: {
            type: 'array',
            maxItems: 2,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['move', 'probability'],
              properties: { move: { type: 'string', enum: moves }, probability: { type: 'number' } },
            },
          },
        },
      },
    },
  };
}

/** Resolves when the rest of a streamed answer (probabilities, cost) has been filled in. */
export function answerComplete(a: Answer): Promise<void> {
  return (a as Answer & { [COMPLETE]?: Promise<void> })[COMPLETE] ?? Promise.resolve();
}
const COMPLETE = Symbol('complete');

/**
 * A full distribution from the short answer: the move's confidence, the alternatives' probabilities,
 * and whatever is left spread evenly over the other moves. Null if the confidence is unusable.
 */
export function toDistribution(move: MoveId, confidence: unknown, alternatives: unknown, offered: MoveId[]): Partial<Record<MoveId, number>> | null {
  const c = Number(confidence);
  if (!Number.isFinite(c) || c <= 0) return null;
  const raw: Record<string, number> = { [move]: Math.min(1, c) };
  if (Array.isArray(alternatives)) {
    for (const a of alternatives) {
      const m = (a as { move?: unknown })?.move;
      const p = Number((a as { probability?: unknown })?.probability);
      if (isMoveId(m) && m !== move && offered.includes(m) && Number.isFinite(p) && p > 0) raw[m] = p;
    }
  }
  const given = Object.values(raw).reduce((x, y) => x + y, 0);
  const rest = offered.filter((m) => !(m in raw));
  if (given < 1 && rest.length) for (const m of rest) raw[m] = (1 - given) / rest.length;
  return normalise(raw, offered);
}

/** Any Opper chat model, forced to answer the same question through a JSON schema. */
export function chatAdapter(model: string, deps: HttpDeps & { maxTokens?: number; params?: Record<string, unknown> }): Adapter {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? (() => performance.now());
  const url = deps.endpoint ?? `${(deps.baseUrl ?? OPPER_BASE_URL).replace(/\/+$/, '')}/v3/compat/chat/completions`;
  const post = (body: unknown, signal: AbortSignal) =>
    f(url, {
      method: 'POST',
      headers: headersFor(deps),
      body: JSON.stringify(body),
      signal,
    });
  return {
    id: model,
    kind: 'chat',
    async warmUp() {
      const res = await post({ model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 16 }, AbortSignal.timeout(60_000));
      if (!res.ok) throw new HttpError(res.status, `${model} warm-up returned HTTP ${res.status}`);
      await res.text();
    },
    /**
     * Streams the answer and returns as soon as the move is known; confidence, alternatives and cost
     * are filled into the same Answer when the stream ends (see answerComplete).
     */
    async decide(q: Question, signal: AbortSignal): Promise<Answer> {
      const offered = q.options.map((o) => o.id);
      const started = now();
      const res = await post(
        {
          model,
          messages: [
            { role: 'system', content: `${SYSTEM}\n\n${q.instructions}` },
            { role: 'user', content: questionText(q) },
          ],
          response_format: chatSchema(offered),
          // Room for models that reason before answering.
          max_tokens: deps.maxTokens ?? 1200,
          stream: true,
          stream_options: { include_usage: true },
          ...(deps.params ?? {}),
        },
        signal,
      );
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new HttpError(res.status, `${model} returned HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let cost: number | null = res.headers.get('x-opper-cost') === null ? null : Number(res.headers.get('x-opper-cost'));
      let inputTokens: number | undefined;
      let streamError: string | null = null;
      /** Reads until `until` says stop (or the stream ends). */
      const pump = async (until: () => boolean): Promise<boolean> => {
        for (;;) {
          if (until()) return true;
          const { done, value } = await reader.read();
          if (done) return false;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const chunk = JSON.parse(data) as {
                choices?: { delta?: { content?: string } }[];
                usage?: { prompt_tokens?: number };
                cost?: number;
                error?: { message?: string };
              };
              if (chunk.error) streamError = chunk.error.message ?? 'stream error';
              const d = chunk.choices?.[0]?.delta?.content;
              if (d) content += d;
              if (chunk.usage?.prompt_tokens) inputTokens = chunk.usage.prompt_tokens;
              if (typeof chunk.cost === 'number') cost = chunk.cost;
            } catch {
              // a partial or non-JSON line
            }
          }
        }
      };
      const choiceOf = () => /"choice"\s*:\s*"([a-z_]+)"/.exec(content)?.[1];
      await pump(() => choiceOf() !== undefined);
      if (streamError) throw new HttpError(502, `${model}: ${streamError}`);
      const move = choiceOf();
      const latencyMs = Math.round(now() - started);
      if (!isMoveId(move) || !offered.includes(move)) throw new InvalidAnswer(`${model} chose ${String(move ?? 'nothing')}`);
      const answer: Answer = { move, probabilities: null, latencyMs, costUsd: cost, traceId: res.headers.get('x-opper-trace-id') };
      // The rest arrives in the background; the fighter can act now.
      const rest = pump(() => false)
        .then(() => {
          try {
            const parsed = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, '')) as { confidence?: unknown; others?: unknown };
            answer.probabilities = toDistribution(move, parsed.confidence, parsed.others, offered);
          } catch {
            // keep it uncalibrated
          }
          answer.costUsd = cost;
          if (inputTokens !== undefined) answer.inputTokens = inputTokens;
        })
        .catch(() => {});
      Object.defineProperty(answer, COMPLETE, { value: rest, enumerable: false });
      return answer;
    },
  };
}
