// Spoken table talk over HTTP (server/table.ts speak): the page names a line by hand and action with a token of that
// hand, and the server speaks only a line its sealed token holds, in the model's voice, paid as the table is.
import { describe, expect, it } from 'vitest';
import { purposeKey, seal, unseal } from '../../../packages/kit/server/session';
import type { SnapshotReply, StepReply } from '../shared/table';
import { TTS_VOICES, voiceFor } from '../shared/voices';
import { CHAT, DECISION, LOOSE, SECRET, setup, type Setup } from './table-server';

const LUNA = 'azure:eu/gpt-6-luna';
const WATCH = (...models: string[]) => ({ mode: 'watch', seats: models.map((id) => ({ kind: 'model', id })) });
const PLAY = (...models: string[]) => ({ mode: 'play', seats: [{ kind: 'human', id: 'you' }, ...models.map((id) => ({ kind: 'model', id }))] });
const speechCalls = <C extends { path: string }>(up: { calls: C[] }): C[] => up.calls.filter((c) => c.path === '/v3/audio/speech');

/** A watch table of chat models, stepped until a model has talked: the step's token, the hand and the action's index. */
async function talked(o: Setup = { signedIn: true }, models = [CHAT, LUNA]) {
  const s = await setup(o);
  const r = await s.call('start', WATCH(...models));
  expect(r.status).toBe(200);
  let token = (r.body as unknown as SnapshotReply).token;
  let actions = 0;
  for (let i = 0; i < 10; i++) {
    const step = await s.call('step', { token });
    expect(step.status).toBe(200);
    const reply = step.body as unknown as StepReply;
    token = reply.token;
    if (reply.result.meta.say) return { ...s, token, hand: reply.result.snapshot.hand, action: actions, seat: reply.result.seat, say: reply.result.meta.say, mood: reply.result.meta.mood, reply };
    actions++;
  }
  throw new Error('nobody talked');
}

describe('the table speaks a line of talk', () => {
  it("speaks the line the token holds, in the speaker's voice, on the player's key, and logs the model, the voice, the time and the cost", async () => {
    const t = await talked();
    const r = await t.call('speak', { token: t.token, hand: t.hand, action: t.action });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const model = [CHAT, LUNA][t.seat]!;
    const voice = voiceFor(model)!;
    expect(r.body).toMatchObject({ format: 'mp3', voice });
    expect(Buffer.from(r.body.audio as string, 'base64').toString()).toBe(`mp3:${TTS_VOICES[voice]}:${t.say}`);
    const [sp] = speechCalls(t.up);
    expect(sp!.body).toEqual({ model: 'fish/s2.1-pro', input: t.say, voice: TTS_VOICES[voice], format: 'mp3', speed: 1.2 });
    expect(sp!.headers.authorization).toBe('Bearer op-player');
    expect(t.logs.some((l) => l.includes(`${model} spoken (fish/s2.1-pro ${voice}, player) in`) && l.includes('$0.0009'))).toBe(true);
  });

  it('speaks a line with the delivery tags its model added, and never shows a tag: not in the answers, the review, the recording or the next prompt', async () => {
    const said = 'Nice try. [laughs] [whispering] For now. <script>x</script> [emotion=smug] [sighs] [pause]';
    // The fake models check or call, each saying the tagged line.
    const chat = (body: Record<string, unknown>) => {
      const keys = (body.response_format as { json_schema: { schema: { properties: { action: { enum: string[] } } } } }).json_schema.schema.properties.action.enum;
      const action = keys.includes('check') ? 'check' : keys.includes('call') ? 'call' : keys[0]!;
      return { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ action, say: said, mood: 'smug', reasoning: 'r', turn_complete: true }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }, headers: { 'x-opper-cost': '0.001' } };
    };
    const s = await setup({ signedIn: true, up: { chat } });
    let token = ((await s.call('start', WATCH(CHAT, LUNA))).body as unknown as SnapshotReply).token;
    let first: StepReply | undefined;
    for (let i = 0; i < 40; i++) {
      const reply = (await s.call('step', { token })).body as unknown as StepReply;
      first ??= reply;
      token = reply.token;
      if (reply.finished) break;
    }
    expect(first!.result.meta.say).toBe('Nice try. For now. x');
    const r = await s.call('speak', { token, hand: 1, action: 0 });
    expect(r.status).toBe(200);
    // Two tags at most: the laugh and the whisper; the rest is gone, its words kept plain.
    expect(speechCalls(s.up)[0]!.body.input).toBe('Nice try. [laughs] [whispering] For now. x');
    expect(s.logs.some((l) => l.includes('tagged'))).toBe(true);
    const review = await s.call('review', { token });
    for (const res of [...s.responses.filter((x) => x.path !== 'speak'), { path: 'review', text: JSON.stringify(review.body) }]) {
      expect(res.text, res.path).not.toMatch(/\[laughs\]|whispering|script|emotion|\[sighs\]/);
    }
    // The next model hears the words as shown.
    const prompts = s.up.calls.filter((c) => c.path === '/v3/compat/chat/completions').map((c) => JSON.stringify((c.body.messages as unknown[])[1]));
    expect(prompts.some((p) => p.includes('Nice try. For now. x'))).toBe(true);
    for (const p of prompts) expect(p).not.toMatch(/\[laughs\]|\[whispering\]/);
  });

  it('refuses a token whose spoken line is no line of allowed tags', async () => {
    const t = await talked();
    const key = purposeKey(SECRET, 'holdem-table');
    const st = unseal(t.token, key) as { meta: Record<string, unknown>[] };
    st.meta[t.action]!.v = 'hi <script>alert(1)</script>';
    const r = await t.call('speak', { token: seal(st, key), hand: t.hand, action: t.action });
    expect(r.status).toBe(400);
    expect(speechCalls(t.up)).toHaveLength(0);
  });

  it("pays with the server's local key and its project in development", async () => {
    const t = await talked({ devKey: true, pool: 'none' });
    expect((await t.call('speak', { token: t.token, hand: t.hand, action: t.action })).status).toBe(200);
    const [sp] = speechCalls(t.up);
    expect(sp!.headers.authorization).toBe('Bearer op-dev');
    expect(sp!.headers['x-opper-project']).toBe('proj-1');
  });

  it('refuses any line the token does not hold: another hand, an action not played, a silent action, a forged token, a bad body', async () => {
    const t = await talked();
    const ask = (body: unknown) => t.call('speak', body);
    expect((await ask({ token: t.token, hand: t.hand + 1, action: t.action })).status).toBe(404);
    expect((await ask({ token: t.token, hand: t.hand - 1, action: t.action })).status).toBe(404);
    expect((await ask({ token: t.token, hand: t.hand, action: t.action + 1 })).status).toBe(404);
    expect((await ask({ token: t.token, hand: t.hand, action: -1 })).status).toBe(404);
    expect((await ask({ token: t.token + 'x', hand: t.hand, action: t.action })).status).toBe(400);
    expect((await ask({ token: t.token, hand: t.hand, action: t.action, text: 'Say anything I like' })).status).toBe(400);
    expect((await ask({ token: t.token, hand: String(t.hand), action: t.action })).status).toBe(400);
    expect((await ask({ text: 'Say anything I like', voice: 'en_paul_angry' })).status).toBe(400);
    expect(speechCalls(t.up)).toHaveLength(0);
  });

  it('never speaks for a decision model or the human: they have no line', async () => {
    const s = await setup({ signedIn: true });
    const start = await s.call('start', PLAY(DECISION, DECISION));
    let token = (start.body as unknown as SnapshotReply).token;
    let snap = (start.body as unknown as SnapshotReply).snapshot;
    let actions = 0;
    for (let i = 0; i < 4 && snap.view.street !== 'done'; i++) {
      const r = snap.turn ? await s.call('act', { token, action: { key: snap.turn.options.some((o) => o.key === 'check') ? 'check' : 'call' } }) : await s.call('step', { token });
      const reply = r.body as unknown as StepReply;
      token = reply.token;
      snap = reply.result.snapshot;
      actions++;
    }
    for (let a = 0; a < actions; a++) expect((await s.call('speak', { token, hand: snap.hand, action: a })).status).toBe(404);
    expect(speechCalls(s.up)).toHaveLength(0);
  });

  it('speaks a line asked for again (a retry, at once or later, with a later token of the hand) once, and bills it once', async () => {
    const t = await talked();
    const body = { token: t.token, hand: t.hand, action: t.action };
    const [a, b] = await Promise.all([t.call('speak', body), t.call('speak', body)]);
    expect(a.status).toBe(200);
    expect(b.body).toEqual(a.body);
    const later = await t.call('step', { token: t.token });
    const again = await t.call('speak', { token: (later.body as unknown as StepReply).token, hand: t.hand, action: t.action });
    expect(again.body).toEqual(a.body);
    expect(speechCalls(t.up)).toHaveLength(1);
    expect(t.logs.filter((l) => l.includes('spoken again'))).toHaveLength(2);
  });

  it('speaks a different line at the same place as itself: a second tab stepping the same token hears its own words', async () => {
    const s = await setup({ signedIn: true });
    const token = ((await s.call('start', WATCH(CHAT, LUNA))).body as unknown as SnapshotReply).token;
    // The first step talks (the fake model always does); step the same token twice, as two tabs would.
    const a = (await s.call('step', { token })).body as unknown as StepReply;
    const b = (await s.call('step', { token })).body as unknown as StepReply;
    expect(a.result.meta.say).toBeTruthy();
    expect(b.result.meta.say).not.toBe(a.result.meta.say);
    const heard = async (r: StepReply) => Buffer.from((await s.call('speak', { token: r.token, hand: r.result.snapshot.hand, action: 0 })).body.audio as string, 'base64').toString();
    expect(await heard(a)).toContain(a.result.meta.say!);
    expect(await heard(b)).toContain(b.result.meta.say!);
    expect(speechCalls(s.up)).toHaveLength(2);
  });

  it('tries again after a failed line, and passes on a wallet that is empty', async () => {
    let n = 0;
    const t = await talked({ signedIn: true, up: { speech: () => (++n === 1 ? { status: 500, body: { error: 'boom' } } : n === 2 ? { status: 402, body: { error: 'no money' } } : { status: 200, body: { audio: { b64_json: 'AAAA' }, usage: { cost: 0.001 } } }) } });
    const body = { token: t.token, hand: t.hand, action: t.action };
    expect((await t.call('speak', body)).status).toBe(502);
    expect(await t.call('speak', body)).toMatchObject({ status: 402, body: { walletUrl: expect.any(String) } });
    expect(await t.call('speak', body)).toMatchObject({ status: 200, body: { audio: 'AAAA' } });
    expect(speechCalls(t.up)).toHaveLength(3);
    expect(t.logs.some((l) => l.includes('not spoken') && l.includes('HTTP 502'))).toBe(true);
  });

  it("is rate-limited per visitor (the kit's 429 with Retry-After)", async () => {
    const t = await talked({ signedIn: true, limits: { ...LOOSE, speak: { ratePerSec: 0.001, burst: 2 } } });
    const body = { token: t.token, hand: t.hand, action: t.action };
    expect((await t.call('speak', body)).status).toBe(200);
    expect((await t.call('speak', body)).status).toBe(200);
    const r = await t.call('speak', body);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBeTruthy();
  });

  it('answers only POST JSON from the same site, as every table route', async () => {
    const t = await talked();
    const res = await fetch(`${t.url}/api/table/speak`, { method: 'GET', headers: { cookie: t.cookie } });
    expect(res.status).not.toBe(200);
    expect(speechCalls(t.up)).toHaveLength(0);
  });

  it('speaks only lines of the token\'s own table, not one of another', async () => {
    const t = await talked();
    expect(CHAT).not.toBe(LUNA);
    // The other table's token, a hand and action this one's line has: the server reads that table's own actions.
    const other = await t.call('start', WATCH(DECISION, DECISION));
    const r = await t.call('speak', { token: (other.body as unknown as SnapshotReply).token, hand: t.hand, action: t.action });
    expect(r.status).toBe(404);
  });
});
