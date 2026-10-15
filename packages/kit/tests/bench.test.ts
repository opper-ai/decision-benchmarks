import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BenchError, runBench } from '../bench/bench';
import { entryFor } from '../bench/results';
import { checkSubmissions } from '../bench/submissions';
import { chatSchema, chatTransport, endpointTransport } from '../bench/transports';
import { warmUp } from '../bench/warm';
import type { ChatFormat } from '../shared/chat';
import { validateLeaderboard } from '../shared/contract';
import { coinDefinition } from './support/test-game';

afterEach(() => vi.unstubAllGlobals());

const quiet = () => {};
/** A model that always calls heads, as a System One endpoint or as Opper's System One API. */
const headsAnswer = (body: { questions: Record<string, unknown> }) => ({ answers: Object.fromEntries(Object.keys(body.questions).map((n) => [n, { type: 'choice', choice: 'heads' }])), usage: { input_tokens: 3, output_tokens: 1 } });

describe('entryFor', () => {
  it("makes a row in the contract shape, with the game's extra numbers", () => {
    const r = (score: number) => ({ score, heads: score, calls: 2, decisions: 4, fallbacks: 1, latencyMsSum: 600, cost: 0.002 });
    const e = entryFor(coinDefinition(), 'opper/kev-4b', 'Kev 4B', [r(1), r(3)], 'systemone');
    expect(e).toEqual({ model: 'opper/kev-4b', name: 'Kev 4B', games: 2, metric: { mean: 2, stdError: 1, best: 3 }, meanLatencyMs: 300, fallbackRate: 0.25, costPerGame: 0.002, via: 'systemone', extra: { meanHeads: 2 } });
    // Lower is better: the best game is the lowest; no cost reported is unknown, not free.
    const lower = entryFor(coinDefinition({ metric: { name: 'Moves', unit: 'moves', higherIsBetter: false } }), 'm', 'M', [{ ...r(1), cost: 0 }, { ...r(3), cost: 0 }], 'chat-adapter');
    expect(lower.metric.best).toBe(1);
    expect(lower.costPerGame).toBeNull();
  });
});

describe('transports', () => {
  it('sends an endpoint only the state and the questions, and reads its answers', async () => {
    const f = vi.fn<typeof fetch>(async (_u, init) => new Response(JSON.stringify({ ...headsAnswer(JSON.parse(init!.body as string)), costUsd: 0.01 })));
    const t = endpointTransport({ url: 'http://model.test/decide', token: 'tok', timeoutMs: 1000, name: 'Mine', fetch: f, now: () => 0 });
    const res = await t({ model: 'x', state: { flips: 1 }, questions: { coin: { type: 'choice', instructions: 'Call it', criteria: { heads: 'H', tails: 'T' } } }, keys: { coin: 'k' } });
    expect(JSON.parse(f.mock.calls[0]![1]!.body as string)).toEqual({ state: { flips: 1 }, questions: { coin: { type: 'choice', instructions: 'Call it', criteria: { heads: 'H', tails: 'T' } } } });
    expect((f.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(res).toMatchObject({ model: 'Mine', answers: { coin: { choice: 'heads' } }, costUsd: 0.01 });
    await expect(endpointTransport({ url: 'http://x', timeoutMs: 10, name: 'n', fetch: async () => new Response('{}') })({ state: {}, questions: {} })).rejects.toThrow(/no answers/);
  });

  it('asks a chat model each question through a JSON schema that forces a choice and probabilities', async () => {
    const f = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"choice":"tails","probabilities":{"heads":0.2,"tails":0.8}}' } }], usage: { prompt_tokens: 50, completion_tokens: 9 } }), { headers: { 'x-opper-cost': '0.0003' } }));
    const t = chatTransport({ url: 'https://api.opper.ai/v3/compat/chat/completions', model: 'openai/gpt-6', timeoutMs: 1000, name: 'GPT-6', fetch: f, now: () => 0 });
    const res = await t({ state: { flips: 1 }, questions: { a: { type: 'choice', instructions: 'Call it', criteria: { heads: 'H', tails: 'T' } }, b: { type: 'choice', instructions: 'Again', criteria: { heads: 'H', tails: 'T' } } } });
    expect(f).toHaveBeenCalledTimes(2);
    const sent = JSON.parse(f.mock.calls[0]![1]!.body as string);
    expect(sent.model).toBe('openai/gpt-6');
    expect(sent.response_format).toEqual(chatSchema(['heads', 'tails']));
    expect(sent.response_format.json_schema.schema.required).toEqual(['choice', 'probabilities']);
    expect(sent.messages[1].content).toContain('heads: H');
    expect(res.answers).toEqual({ a: { type: 'choice', choice: 'tails', probabilities: { heads: 0.2, tails: 0.8 } }, b: { type: 'choice', choice: 'tails', probabilities: { heads: 0.2, tails: 0.8 } } });
    expect(res.usage).toEqual({ input_tokens: 100, output_tokens: 18 });
    expect(res.costUsd).toBeCloseTo(0.0006);
  });

  it('turns a chat answer that is not JSON into no answer (the game falls back), and an HTTP error into an error', async () => {
    const t = chatTransport({ url: 'http://x', model: 'm', timeoutMs: 1000, name: 'm', fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'heads, surely' } }] })) });
    expect((await t({ state: {}, questions: { a: { type: 'choice', instructions: 'i', criteria: { heads: 'H', tails: 'T' } } } })).answers).toEqual({ a: null });
    const down = chatTransport({ url: 'http://x', model: 'm', timeoutMs: 1000, name: 'm', fetch: async () => new Response('nope', { status: 500 }) });
    await expect(down({ state: {}, questions: { a: { type: 'choice', instructions: 'i', criteria: { x: 'X', y: 'Y' } } } })).rejects.toThrow(/HTTP 500/);
  });
});

/** A game's own chat format: the choice under `pick`, with a remark that rides along. */
const pickFormat: ChatFormat = {
  messages: (state, q) => [{ role: 'user', content: `${JSON.stringify(state)} ${Object.keys(q.criteria).join('/')}` }],
  responseFormat: (q) => ({ type: 'json_schema', json_schema: { name: 'pick', strict: true, schema: { type: 'object', properties: { pick: { type: 'string', enum: Object.keys(q.criteria) } } } } }),
  parse(content, q) {
    try {
      const p = JSON.parse(content) as { pick?: unknown; remark?: unknown };
      return typeof p.pick === 'string' && p.pick in q.criteria ? { type: 'choice', choice: p.pick, remark: p.remark } : null;
    } catch {
      return null;
    }
  },
};

describe("chat transport with a game's own format", () => {
  const question = { a: { type: 'choice' as const, instructions: 'i', criteria: { heads: 'H', tails: 'T' } } };
  const reply = (body: unknown, headers: Record<string, string> = {}) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { headers }));

  it("asks with the game's messages and schema, sends reasoning effort and headers, and keeps what the game parses", async () => {
    const f = reply({ choices: [{ finish_reason: 'stop', message: { content: '{"pick":"heads","remark":"lucky"}' } }], usage: { prompt_tokens: 10, completion_tokens: 4 } }, { 'x-opper-cost': '0.001' });
    const t = chatTransport({ url: 'http://x', model: 'm', timeoutMs: 1000, name: 'M', fetch: f, now: () => 0, format: pickFormat, reasoningEffort: 'low', headers: { 'X-Opper-Project': 'p1' } });
    const res = await t({ state: { flips: 2 }, questions: question });
    const init = f.mock.calls[0]![1]!;
    const sent = JSON.parse(init.body as string);
    expect(sent.messages).toEqual([{ role: 'user', content: '{"flips":2} heads/tails' }]);
    expect(sent.response_format.json_schema.name).toBe('pick');
    expect(sent.reasoning_effort).toBe('low');
    expect((init.headers as Record<string, string>)['X-Opper-Project']).toBe('p1');
    expect(res.answers).toEqual({ a: { type: 'choice', choice: 'heads', remark: 'lucky' } });
    expect(res.costUsd).toBeCloseTo(0.001);
    // Without a reasoning effort none is sent.
    const plain = reply({ choices: [{ message: { content: '{"pick":"tails"}' } }] });
    await chatTransport({ url: 'http://x', model: 'm', timeoutMs: 1000, name: 'M', fetch: plain, format: pickFormat })({ state: {}, questions: question });
    expect(JSON.parse(plain.mock.calls[0]![1]!.body as string)).not.toHaveProperty('reasoning_effort');
  });

  it('answers a refusal as such and a reply the game cannot read as nothing, so the game falls back either way', async () => {
    const refused = chatTransport({ url: 'http://x', model: 'm', timeoutMs: 1000, name: 'M', fetch: reply({ choices: [{ finish_reason: 'refusal', message: { content: '' } }] }), format: pickFormat });
    expect((await refused({ state: {}, questions: question })).answers).toEqual({ a: { type: 'refusal' } });
    const bad = chatTransport({ url: 'http://x', model: 'm', timeoutMs: 1000, name: 'M', fetch: reply({ choices: [{ message: { content: '{"pick":"edge"}' } }] }), format: pickFormat });
    expect((await bad({ state: {}, questions: question })).answers).toEqual({ a: null });
  });
});

describe('warmUp', () => {
  it('calls until an answer is fast enough, and gives up at once on anything but a timeout', async () => {
    let t = 0;
    const slowThenFast = [3000, 3000, 100];
    const transport = vi.fn(async () => {
      t += slowThenFast.shift()!;
      return { answers: {}, usage: { input_tokens: 0, output_tokens: 0 }, latencyMs: 0, costUsd: null, traceId: null };
    });
    expect(await warmUp(transport, { fastMs: 1800, now: () => t })).toBeNull();
    expect(transport).toHaveBeenCalledTimes(3);
    expect(await warmUp(async () => Promise.reject(new Error('Kev 4B is not enabled for this API key')), { fastMs: 1800 })).toBe('Kev 4B is not enabled for this API key');
  });
});

describe('runBench', () => {
  const paths = () => ({ publicDir: mkdtempSync(join(tmpdir(), 'db-public-')) });

  it('records a submission through an endpoint that the submissions check then accepts', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => new Response(JSON.stringify(headsAnswer(JSON.parse(init.body as string))))));
    const game = coinDefinition();
    const root = mkdtempSync(join(tmpdir(), 'db-bench-'));
    await runBench(game, ['--game', 'coin', '--endpoint', 'http://model.test', '--submit', join(root, 'my-coin'), '--name', 'My Coin', '--by', 'acme'], {}, paths(), quiet);
    const manifest = JSON.parse(readFileSync(join(root, 'my-coin', 'submission.json'), 'utf8'));
    expect(manifest).toMatchObject({ name: 'My Coin', by: 'acme', via: 'systemone', benchVersion: 2, games: game.rules.minGames });
    const { community, refused } = checkSubmissions(game, root, quiet);
    expect(refused).toEqual([]);
    expect(community.entries).toMatchObject([{ model: 'my-coin', name: 'My Coin', games: 2, metric: { mean: 1 } }]);
  });

  it('writes the official leaderboard in the contract shape, warming each model first and skipping one that will not play', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        calls.push(`${body.model}:${Object.keys(body.questions).join(',')}`);
        if (body.model === 'greenpt/metis') return new Response('{"error":"no"}', { status: 403 });
        return new Response(JSON.stringify(headsAnswer(body)), { headers: { 'x-opper-cost': '0.001' } });
      }),
    );
    const p = paths();
    const game = coinDefinition();
    await runBench(game, ['--game', 'coin', '--models', 'opper/kev-4b,greenpt/metis', '--leaderboard'], { OPPER_API_KEY: 'op-test' }, p, quiet);
    const board = JSON.parse(readFileSync(join(p.publicDir, 'leaderboard.json'), 'utf8'));
    expect(validateLeaderboard(board, 'coin')).toEqual([]);
    expect(board.entries).toMatchObject([{ model: 'opper/kev-4b', name: 'Kev 4B', games: game.rules.officialGames, via: 'systemone', costPerGame: 0.001 }]);
    expect(board.skipped).toEqual([{ model: 'greenpt/metis', reason: 'Metis is not enabled for this API key' }]);
    // The warm-up comes first, then one game per seed.
    expect(calls.slice(0, 2)).toEqual(['opper/kev-4b:warmup', 'opper/kev-4b:coin']);
  });

  it("plays a game's baselines without a key or a network call, and keeps them off the official leaderboard", async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const tails = { name: 'Always tails', transport: () => async (body: { questions: Record<string, unknown> }) => ({ answers: Object.fromEntries(Object.keys(body.questions).map((n) => [n, { type: 'choice', choice: 'tails' }])), usage: { input_tokens: 0, output_tokens: 0 }, latencyMs: 0, costUsd: null, traceId: null }) };
    const game = coinDefinition({ baselines: { tails } });
    const p = paths();
    const out = join(p.publicDir, 'baselines.json');
    await runBench(game, ['--game', 'coin', '--models', 'baseline/tails', '--leaderboard', '--out', out], {}, p, quiet);
    const board = JSON.parse(readFileSync(out, 'utf8'));
    expect(validateLeaderboard(board, 'coin')).toEqual([]);
    expect(board.entries).toMatchObject([{ model: 'baseline/tails', name: 'Always tails', games: game.rules.officialGames, metric: { mean: 0 } }]);
    const cases: [string[], RegExp][] = [
      [['--model', 'baseline/heads'], /no baseline baseline\/heads; one of: baseline\/tails/],
      [['--model', 'baseline/tails', '--leaderboard'], /never go on the leaderboard/],
      [['--models', 'baseline/tails,opper/kev-4b', '--leaderboard', '--out', out], /never go on the leaderboard/],
      [['--models', 'baseline/tails,opper/kev-4b'], /OPPER_API_KEY/],
    ];
    for (const [argv, message] of cases) await expect(runBench(game, argv, {}, paths(), quiet)).rejects.toThrow(message);
    expect(f).not.toHaveBeenCalled();
  });

  it('lets the game play a baseline without a transport, with no key, no warm-up and no model call', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const played: string[] = [];
    const game = coinDefinition({
      baselines: { heads: { name: 'Always heads' } },
      async play({ model, seed, transport }) {
        played.push(model);
        // Its transport is a stand-in that throws: the game plays the baseline itself.
        await expect(transport({} as never)).rejects.toThrow(/played by the game itself/);
        return { result: { score: 1, heads: 1, calls: 0, decisions: 1, fallbacks: 0, latencyMsSum: 0, cost: 0 }, recording: { seed, calls: ['heads'] } };
      },
    });
    const p = paths();
    const out = join(p.publicDir, 'baselines.json');
    await runBench(game, ['--game', 'coin', '--models', 'baseline/heads', '--leaderboard', '--out', out, '--games', '3'], {}, p, quiet);
    const board = JSON.parse(readFileSync(out, 'utf8'));
    expect(validateLeaderboard(board, 'coin')).toEqual([]);
    expect(board.entries).toMatchObject([{ model: 'baseline/heads', name: 'Always heads', games: 3, metric: { mean: 1 } }]);
    expect(played).toEqual(['baseline/heads', 'baseline/heads', 'baseline/heads']);
    expect(f).not.toHaveBeenCalled();
    // Without --out they would land in the official leaderboard.json; a model next to them still needs a key.
    await expect(runBench(game, ['--models', 'baseline/heads', '--leaderboard'], {}, p, quiet)).rejects.toThrow(/--out/);
    await expect(runBench(game, ['--models', 'baseline/heads,opper/kev-4b'], {}, p, quiet)).rejects.toThrow(/OPPER_API_KEY/);
    await expect(runBench(game, ['--model', 'baseline/tails'], {}, p, quiet)).rejects.toThrow(/no baseline baseline\/tails; one of: baseline\/heads/);
  });

  it("plays a game's chat models through Opper's chat completions, with their own timeout, format and reasoning effort", async () => {
    const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown>; signal: AbortSignal | null }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string), signal: init.signal ?? null });
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"pick":"heads"}' } }] }), { headers: { 'x-opper-cost': '0.002' } });
      }),
    );
    const vias: unknown[] = [];
    const base = coinDefinition();
    const game = coinDefinition({
      timing: { decisionTimeoutMs: 1000, callTimeoutMs: 1000, chatTimeoutMs: 30_000, maxInFlight: 1 },
      chatModels: [{ id: 'azure:eu/gpt-6-luna', name: 'GPT-6 Luna', reasoningEffort: 'low' }],
      chat: pickFormat,
      play: (o) => {
        vias.push(o.via);
        return base.play(o);
      },
    });
    const p = paths();
    await runBench(game, ['--models', 'chat', '--leaderboard', '--games', '2'], { OPPER_API_KEY: 'op-test', OPPER_PROJECT: 'proj-1' }, p, quiet);
    const board = JSON.parse(readFileSync(join(p.publicDir, 'leaderboard.json'), 'utf8'));
    expect(validateLeaderboard(board, 'coin')).toEqual([]);
    expect(board.entries).toMatchObject([{ model: 'azure:eu/gpt-6-luna', name: 'GPT-6 Luna', via: 'chat-adapter', games: 2, metric: { mean: 1 }, costPerGame: 0.002 }]);
    expect(vias).toEqual(['chat-adapter', 'chat-adapter']);
    // A warm-up, then one call per game, all to the chat endpoint with the game's format and the model's effort.
    expect(seen).toHaveLength(3);
    for (const call of seen) {
      expect(call.url).toBe('https://api.opper.ai/v3/compat/chat/completions');
      expect(call.headers).toMatchObject({ authorization: 'Bearer op-test', 'X-Opper-Project': 'proj-1', 'X-Opper-Name': 'decision-benchmarks-bench-coin' });
      expect(call.body).toMatchObject({ model: 'azure:eu/gpt-6-luna', reasoning_effort: 'low' });
      expect((call.body.response_format as { json_schema: { name: string } }).json_schema.name).toBe('pick');
    }
    // --reasoning-effort overrides the model's; a chat model needs an Opper key, whatever else is set.
    await runBench(game, ['--model', 'azure:eu/gpt-6-luna', '--games', '1', '--reasoning-effort', 'medium'], { OPPER_API_KEY: 'op-test' }, paths(), quiet);
    expect(seen.at(-1)!.body.reasoning_effort).toBe('medium');
    await expect(runBench(game, ['--model', 'azure:eu/gpt-6-luna'], { TYPESAFE_API_KEY: 'ts' }, paths(), quiet)).rejects.toThrow(/OPPER_API_KEY to play chat models/);
    await expect(runBench(coinDefinition(), ['--models', 'chat'], { OPPER_API_KEY: 'k' }, paths(), quiet)).rejects.toThrow(/no chat models/);
    // `all` is the decision models and then the game's chat models, so one official run writes the whole board.
    const before = seen.length;
    await runBench(coinDefinition({ ...game, play: base.play }), ['--models', 'all', '--games', '1'], { OPPER_API_KEY: 'op-test' }, paths(), quiet);
    expect(seen.slice(before).map((c) => c.body.model).filter((m) => m === 'azure:eu/gpt-6-luna')).toHaveLength(2);
    expect(seen.slice(before).some((c) => c.url.endsWith('/v3/compat/v1/systemone'))).toBe(true);
  });

  it('refuses what it cannot do, before calling anything', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const game = coinDefinition();
    const cases: [string[], RegExp][] = [
      [['--endpoint', 'http://x', '--submit', '/tmp/Bad_Name', '--name', 'n', '--by', 'a'], /folder name/],
      [['--endpoint', 'http://x', '--submit', '/tmp/ok-name'], /--name/],
      [['--endpoint', 'http://x', '--submit', '/tmp/ok-name', '--name', 'n', '--by', 'a', '--games', '1'], /at least 2 games/],
      [['--endpoint', 'http://x', '--leaderboard'], /official runs/],
      [['--model', 'openai/gpt-5'], /Unknown model/],
      [['--format', 'chat', '--endpoint', 'http://x'], /--chat-model/],
      [['--seed', '3', '--leaderboard'], /fixed seeds/],
      [['--record', 'x.json', '--games', '2'], /--games 1/],
    ];
    for (const [argv, message] of cases) await expect(runBench(game, argv, { OPPER_API_KEY: 'k' }, paths(), quiet)).rejects.toThrow(message);
    await expect(runBench(game, ['--model', 'opper/kev-4b'], {}, paths(), quiet)).rejects.toBeInstanceOf(BenchError);
    expect(f).not.toHaveBeenCalled();
  });
});
