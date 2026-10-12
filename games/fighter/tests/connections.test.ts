import { describe, expect, it } from 'vitest';
import { decisionsAdapter } from '../adapters/decisions.ts';
import { newGame, step } from '../shared/engine/engine.ts';
import { buildQuestion } from '../shared/question.ts';
import type { Replay } from '../shared/replay.ts';
import { fightersProblem } from '../server/app.ts';
import type { Me } from '../src/api.ts';
import { endpointProblem, endpointUrl } from '../shared/endpoints.ts';
import { MINE, blank, guarded, mask, planFighter, type Connections } from '../src/connections.ts';
import { loadFighters } from '../server/fighters.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const me = (mode: Me['mode']): Me => ({ mode, user: mode === 'player' ? { email: 'a@b.c' } : null, loginAvailable: true, models: [] });
const withKeys = (f: (c: Connections) => void) => {
  const c = blank();
  f(c);
  return c;
};

function question() {
  const s = newGame(7, { passivity: true });
  while (buildQuestion(s, 0, { track: 'assisted' }).options.length < 3) step(s, [null, null]);
  return buildQuestion(s, 0, { track: 'assisted' });
}

describe('which key a fighter uses', () => {
  it('prefers its own key, then the key for all fighters, then the sign-in, then the dev key', () => {
    const both = withKeys((c) => {
      c.opperKey = 'op-global-1111';
      c.fighterKeys[0] = 'op-own-2222';
    });
    expect(planFighter('opper/kev-4b', 0, me('player'), both).source).toBe('fighter');
    expect(planFighter('opper/kev-4b', 1, me('player'), both).source).toBe('key');
    expect(planFighter('opper/kev-4b', 1, me('player'), blank()).source).toBe('login');
    expect(planFighter('opper/kev-4b', 1, me('dev'), blank()).source).toBe('dev');
    const none = planFighter('opper/kev-4b', 1, me('none'), blank());
    expect(none.source).toBe('none');
    expect(none.problem).toBeTruthy();
  });

  it('never shows a key, only its last four characters', () => {
    const k = withKeys((c) => (c.opperKey = 'op-secret-abcd'));
    const p = planFighter('opper/kev-4b', 0, me('none'), k);
    expect(p.note).toContain('····abcd');
    expect(p.note).not.toContain('secret');
    expect(mask('')).toBe('');
  });

  it('lets baselines play with no key at all', () => {
    const p = planFighter('baseline/random', 0, me('none'), blank());
    expect(p.source).toBe('baseline');
    expect(p.problem).toBeNull();
  });

  it('names endpoint fighters in their own namespace, so they never merge with a known model', () => {
    const k = withKeys((c) => c.endpoints.push({ id: 'e1', name: 'Luna', url: 'https://api.openai.com/v1', format: 'decisions', model: 'gpt-6-luna', key: '' }));
    const meta = planFighter(`${MINE}e1`, 0, me('none'), k).meta('#000');
    expect(meta.model).toBe('custom:api.openai.com/gpt-6-luna');
    expect(meta.via).toBe('custom');
    expect(meta.host).toBe('api.openai.com');
  });

  it('gives an Opper endpoint the Opper key unless it has its own', () => {
    const k = withKeys((c) => {
      c.opperKey = 'op-main-1111';
      c.endpoints.push({ id: 'a', name: 'A', url: 'https://api.opper.ai/v3/compat', format: 'systemone', model: 'm', key: '' });
      c.endpoints.push({ id: 'b', name: 'B', url: 'http://localhost:8000', format: 'systemone', model: 'm', key: '' });
    });
    expect(planFighter(`${MINE}a`, 0, me('none'), k).note).toContain('····1111');
    expect(planFighter(`${MINE}b`, 0, me('none'), k).note).toContain('no key');
    expect(planFighter(`${MINE}gone`, 0, me('none'), k).problem).toBeTruthy();
  });
});

describe('endpoints', () => {
  it('add the format path to the base URL once', () => {
    expect(endpointUrl({ url: 'https://api.opper.ai/v3/compat/', format: 'systemone' })).toBe('https://api.opper.ai/v3/compat/v1/systemone');
    expect(endpointUrl({ url: 'https://api.openai.com/v1', format: 'chat' })).toBe('https://api.openai.com/v1/chat/completions');
    expect(endpointUrl({ url: 'https://x.dev/v1/decisions', format: 'decisions' })).toBe('https://x.dev/v1/decisions');
  });
  it('need a name, a model and https (plain http only for localhost)', () => {
    const c = { name: 'x', url: 'https://x.dev/v1', format: 'chat' as const, model: '' };
    expect(endpointProblem(c)).toMatch(/model/);
    expect(endpointProblem({ ...c, model: 'm' })).toBeNull();
    expect(endpointProblem({ ...c, model: 'm', name: ' ' })).toMatch(/name/);
    expect(endpointProblem({ ...c, model: 'm', url: 'http://x.dev/v1' })).toMatch(/https/);
    expect(endpointProblem({ ...c, model: 'm', url: 'http://localhost:8000/v1' })).toBeNull();
    expect(endpointProblem({ ...c, model: 'm', url: 'javascript:alert(1)' })).toBeTruthy();
  });
  it('load from fighters.json, reporting bad entries without dropping good ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fighters-'));
    const file = join(dir, 'fighters.json');
    writeFileSync(
      file,
      JSON.stringify({
        fighters: [
          { id: 'my-bot', name: 'My bot', url: 'http://localhost:8000', format: 'systemone', model: 'm', keyEnv: 'MY_BOT_KEY' },
          { id: 'Bad Id', name: 'x', url: 'http://localhost:1', format: 'chat', model: 'm' },
          { id: 'no-format', name: 'x', url: 'http://localhost:1', model: 'm' },
        ],
      }),
    );
    const { endpoints, errors } = loadFighters(file);
    expect(endpoints.map((e) => e.id)).toEqual(['my-bot']);
    expect(endpoints[0].keyEnv).toBe('MY_BOT_KEY');
    expect(errors).toHaveLength(2);
    expect(loadFighters(join(dir, 'missing.json'))).toEqual({ endpoints: [], errors: [] });
  });
  it('explain a blocked browser call and keep the key out of errors', async () => {
    const failing = (err: Error) => ({ id: 'm', kind: 'chat' as const, warmUp: () => Promise.reject(err), decide: () => Promise.reject(err) });
    await expect(guarded(failing(new TypeError('Failed to fetch')), 'x.dev', 'k').warmUp()).rejects.toThrow(/CORS/);
    await expect(guarded(failing(new Error('bad key sk-123456')), 'x.dev', 'sk-123456').warmUp()).rejects.toThrow('bad key [key]');
  });
});

describe('the Decisions adapter', () => {
  it("sends one choice question and reads OpenAI's answer", async () => {
    let sent: { model: string; input: string; questions: { type: string; name: string; choices: { value: string }[] }[] } | null = null;
    let auth = '';
    const fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      auth = (init.headers as Record<string, string>).Authorization;
      const first = sent!.questions[0].choices[0].value;
      return new Response(JSON.stringify({ model: 'gpt-6-luna', answers: [{ type: 'choice', name: 'move', choice: first, confidence: 0.7, probabilities: [{ value: first, probability: 0.7 }, { value: sent!.questions[0].choices[1].value, probability: 0.3 }] }], usage: { input_tokens: 600 } }), {
        headers: { 'x-opper-cost': '0.00006' },
      });
    }) as unknown as typeof globalThis.fetch;
    const q = question();
    const a = await decisionsAdapter('gpt-6-luna', { apiKey: 'k', fetch, endpoint: 'https://x.dev/v1/decisions', tag: false }).decide(q, AbortSignal.timeout(1000));
    expect(auth).toBe('Bearer k');
    expect(sent!.questions[0].type).toBe('choice');
    expect(sent!.questions[0].choices.map((c) => c.value)).toEqual(q.options.map((o) => o.id));
    expect(a.move).toBe(q.options[0].id);
    expect(a.probabilities![q.options[0].id]).toBeCloseTo(0.7);
    expect(a.costUsd).toBeCloseTo(0.00006);
    expect(a.inputTokens).toBe(600);
  });
  it('treats a refusal as an invalid answer', async () => {
    const fetch = (async () => new Response(JSON.stringify({ answers: [{ type: 'refusal', name: 'move' }], usage: { input_tokens: 1 } }))) as unknown as typeof globalThis.fetch;
    await expect(decisionsAdapter('m', { apiKey: 'k', fetch }).decide(question(), AbortSignal.timeout(1000))).rejects.toMatchObject({ name: 'InvalidAnswer' });
  });
});

describe('posted replays', () => {
  const r = (fighters: Partial<Replay['fighters'][0]>[]) => ({ fighters: fighters.map((f) => ({ model: 'opper/kev-4b', label: 'Kev', kind: 'systemone', color: '#000', ...f })) }) as unknown as Replay;
  it('accept known and custom fighters', () => {
    expect(fightersProblem(r([{}, { via: 'key' }]))).toBeNull();
    expect(fightersProblem(r([{ via: 'custom', model: 'custom:x.dev/m', host: 'x.dev' }, {}]))).toBeNull();
  });
  it("refuse a custom endpoint wearing a known model's id, and the custom namespace without one", () => {
    expect(fightersProblem(r([{ via: 'custom', model: 'opper/kev-4b' }, {}]))).toBeTruthy();
    expect(fightersProblem(r([{ model: 'custom:x.dev/m' }, {}]))).toBeTruthy();
    expect(fightersProblem(r([{ label: 'x'.repeat(100) }, {}]))).toBeTruthy();
  });
});
