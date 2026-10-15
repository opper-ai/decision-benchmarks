import { describe, expect, it, vi } from 'vitest';
import { CHAT_PATH, handleChat, type ChatDeps } from '../server/chat';
import type { ChatFormat } from '../shared/chat';
import type { ChoiceQuestion } from '../shared/systemone';

const question: ChoiceQuestion = { type: 'choice', instructions: 'Pick a side', criteria: { left: 'Left', right: 'Right' } };
const input = { model: 'aws/claude-haiku-5-5-eu', state: { turn: 1 }, questions: { pick: question } };
/** A game's own way of asking: a pick and a line of talk. */
const format: ChatFormat = {
  messages: (state, q) => [{ role: 'user', content: `${q.instructions} ${JSON.stringify(state)}` }],
  responseFormat: (q) => ({ type: 'json_schema', json_schema: { name: 'pick', strict: true, schema: { enum: Object.keys(q.criteria) } } }),
  parse: (content, q) => {
    try {
      const v = JSON.parse(content) as { pick?: string; say?: string };
      return v.pick && v.pick in q.criteria ? { type: 'choice', choice: v.pick, say: v.say } : null;
    } catch {
      return null;
    }
  },
};
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => vi.fn<typeof fetch>(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }));
const completion = (content: string, extra: Record<string, unknown> = {}) => ({ choices: [{ finish_reason: 'stop', message: { content }, ...extra }], usage: { prompt_tokens: 900, completion_tokens: 40 } });

function deps(f: typeof fetch, over: Partial<ChatDeps> = {}): ChatDeps {
  let t = 0;
  return { apiKey: 'op-key', baseUrl: 'https://api.opper.ai/', fetch: f, now: () => (t += 1200), timeoutMs: 20_000, format, keyMode: 'player', label: 'Haiku 5.5', ...over };
}

describe('handleChat (a chat model asked from the server)', () => {
  it("asks Opper's chat completions in the game's format and answers as /api/decide does: answers, usage, latency, cost", async () => {
    const f = reply(completion('```json\n{"pick":"right","say":"Bold."}\n```'), 200, { 'x-opper-cost': '0.0021', 'x-opper-trace-id': 't-9' });
    const r = await handleChat(input, deps(f, { project: 'p1', callName: 'decision-benchmarks-holdem', reasoningEffort: 'low', maxTokens: 4000 }));
    expect(r).toEqual({ status: 200, body: { model: input.model, answers: { pick: { type: 'choice', choice: 'right', say: 'Bold.' } }, usage: { input_tokens: 900, output_tokens: 40 }, latencyMs: 1200, costUsd: 0.0021, traceId: 't-9' } });
    const [url, init] = f.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`https://api.opper.ai${CHAT_PATH}`);
    expect(init.headers).toMatchObject({ Authorization: 'Bearer op-key', 'Content-Type': 'application/json', 'X-Opper-Name': 'decision-benchmarks-holdem', 'X-Opper-Project': 'p1' });
    expect(JSON.parse(init.body as string)).toEqual({ model: input.model, messages: format.messages(input.state, question), response_format: format.responseFormat(question), max_tokens: 4000, reasoning_effort: 'low' });
  });

  it('answers a refusal as REFUSAL and an unreadable reply as null, for the game to fall back on', async () => {
    expect((await handleChat(input, deps(reply(completion('', { finish_reason: 'refusal' }))))).body).toMatchObject({ answers: { pick: { type: 'refusal' } }, costUsd: null });
    expect((await handleChat(input, deps(reply(completion('left, obviously'))))).body).toMatchObject({ answers: { pick: null } });
  });

  it("maps Opper refusing the key as /api/decide does: the player's sign-in (401, session cleared) or wallet (402), the free credits, the model (403)", async () => {
    expect(await handleChat(input, deps(reply('no', 401)))).toMatchObject({ status: 401, body: { signedOut: true, clearSession: true } });
    expect(await handleChat(input, deps(reply('no', 402)))).toMatchObject({ status: 402, body: { walletUrl: expect.stringMatching(/^https:/) } });
    expect(await handleChat(input, deps(reply('no', 402), { keyMode: 'pool' }))).toMatchObject({ status: 402, body: { poolEmpty: true } });
    expect(await handleChat(input, deps(reply('no', 403)))).toMatchObject({ status: 403, body: { error: 'Haiku 5.5 is not enabled for your Opper account' } });
  });

  it('answers 502 for any other failure and 504 when the model takes longer than its time, without the key in the log', async () => {
    const log = vi.fn();
    const down = await handleChat(input, deps(reply('upstream says op-key is broken', 500), { log }));
    expect(down).toMatchObject({ status: 502, body: { error: expect.stringContaining('HTTP 500') } });
    expect(JSON.stringify(down)).not.toContain('op-key');
    expect(log.mock.calls.flat().join()).not.toContain('op-key');
    const slow = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))));
    expect(await handleChat(input, deps(slow, { timeoutMs: 20 }))).toMatchObject({ status: 504, body: { error: 'Haiku 5.5 timed out after 20 ms' } });
  });

  it("is cancelled with the caller's signal", async () => {
    const ac = new AbortController();
    const slow = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))));
    const pending = handleChat(input, deps(slow, { signal: ac.signal }));
    ac.abort();
    expect(await pending).toMatchObject({ status: 504, body: { error: 'Haiku 5.5 was cancelled' } });
  });

  it('asks exactly one question', async () => {
    expect(await handleChat({ ...input, questions: { a: question, b: question } }, deps(reply(completion('{}'))))).toMatchObject({ status: 400 });
  });
});
