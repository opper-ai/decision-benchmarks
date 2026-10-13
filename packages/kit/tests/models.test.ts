import { describe, expect, it, vi } from 'vitest';
import { diffModels, fetchEvaluationModels } from '../bench/models';
import { handleDecide, type DecideDeps } from '../server/decide';
import { upstreamModel } from '../server/systemone';
import { DECISION_MODELS, DEFAULT_MODEL, isModelId, modelMaker, modelName } from '../shared/models';

const body = { state: { flips: 1 }, questions: { coin: { type: 'choice', instructions: 'Call it', criteria: { heads: 'Heads', tails: 'Tails' } } } };
const answers = { coin: { type: 'choice', choice: 'heads', confidence: 0.9, probabilities: { heads: 0.9, tails: 0.1 } } };
const ok = () =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ answers, usage: { input_tokens: 5, output_tokens: 2 } }), { status: 200, headers: { 'x-opper-cost': '0.00002' } }));
const deps = (fetchImpl: DecideDeps['fetch'], over: Partial<DecideDeps> = {}): DecideDeps => ({ apiKey: 'k', baseUrl: 'https://api.opper.ai', fetch: fetchImpl, now: () => 0, ...over });
const sentModel = (f: ReturnType<typeof ok>) => JSON.parse((f.mock.calls[0][1] as RequestInit).body as string).model;

describe('decision models', () => {
  it("lists Opper's decision model routes (GET /v3/models?type=evaluation), Jev first and default", () => {
    expect(DECISION_MODELS.map((m) => m.id)).toEqual([
      'typesafe/jev-1.13.0',
      'sference/clef',
      'cloudflare:global/clef-flash',
      'opper/kev-4b',
      'berget/convaiinnovations/laya',
      'openai/gpt-6-luna-decisions',
      'azure:global/microsoft-decision-1',
      'empiriolabs/aplomb-1',
      'greenpt/metis',
    ]);
    expect(DEFAULT_MODEL).toBe('typesafe/jev-1.13.0');
    expect(isModelId('opper/kev-4b')).toBe(true);
    expect(isModelId('opper/clef')).toBe(false); // retired by Opper (2026-10-08)
    expect(modelName('cloudflare:global/clef-flash')).toBe('Clef Flash');
    expect(modelMaker('greenpt/metis')).toBe('GreenPT');
    expect(modelName('someone/else')).toBe('someone/else');
  });

  it('maps a model to the id each provider expects; TypeSafe only serves Jev', () => {
    expect(upstreamModel('opper', 'opper/kev-4b')).toBe('opper/kev-4b');
    expect(upstreamModel('opper', 'azure:global/microsoft-decision-1')).toBe('azure:global/microsoft-decision-1');
    expect(upstreamModel('typesafe', 'typesafe/jev-1.13.0')).toBe('jev-1.13.0');
    expect(upstreamModel('typesafe', 'opper/kev-4b')).toBeNull();
    expect(upstreamModel('opper', 'openai/gpt-5')).toBeNull();
  });
});

describe('handleDecide with a model', () => {
  it('sends the requested model, defaulting to Jev, and names it in the answer', async () => {
    const f1 = ok();
    const res = await handleDecide({ ...body, model: 'sference/clef' }, deps(f1));
    expect(sentModel(f1)).toBe('sference/clef');
    expect((res.body as { model: string }).model).toBe('sference/clef');
    const f2 = ok();
    await handleDecide(body, deps(f2));
    expect(sentModel(f2)).toBe('typesafe/jev-1.13.0');
  });

  it('refuses models outside the list, and other models than Jev on a TypeSafe key', async () => {
    const f = ok();
    expect((await handleDecide({ ...body, model: 'openai/gpt-5' }, deps(f))).status).toBe(400);
    expect((await handleDecide({ ...body, model: { toString: 1 } }, deps(f))).status).toBe(400);
    expect((await handleDecide({ ...body, model: '__proto__' }, deps(f))).status).toBe(400);
    const ts = await handleDecide({ ...body, model: 'opper/kev-4b' }, deps(f, { provider: 'typesafe', baseUrl: 'https://api.typesafe.ai' }));
    expect(ts.status).toBe(400);
    expect((ts.body as { error: string }).error).toMatch(/TypeSafe key only/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("the models API (the bench's --list-models)", () => {
  it('reads the live list and says what it adds and drops, without the network', async () => {
    const f = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ id: 'typesafe/jev-1.13.0', name: 'Jev 1.13' }, { id: 'acme/decider', display_name: 'Decider' }, { name: 'no id' }] })));
    const live = await fetchEvaluationModels(f);
    expect(String(f.mock.calls[0][0])).toBe('https://api.opper.ai/v3/models?type=evaluation');
    expect(live).toEqual([{ id: 'typesafe/jev-1.13.0', name: 'Jev 1.13' }, { id: 'acme/decider', name: 'Decider' }]);
    const { added, gone } = diffModels(live);
    expect(added).toEqual([{ id: 'acme/decider', name: 'Decider' }]);
    expect(gone).toContain('greenpt/metis');
    expect(gone).not.toContain('typesafe/jev-1.13.0');
    await expect(fetchEvaluationModels(vi.fn<typeof fetch>(async () => new Response('', { status: 503 })))).rejects.toThrow(/503/);
  });
});
