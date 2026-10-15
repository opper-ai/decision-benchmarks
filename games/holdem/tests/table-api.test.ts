// The table service end to end over HTTP: the kit's game middleware with AI Hold'em's table API, against a fake Opper
// (System One and chat completions) on a local port, called with fetch as the page calls it.
import { afterAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../../packages/kit/server/auth';
import { purposeKey, seal, unseal } from '../../../packages/kit/server/session';
import { formatCard } from '../shared/cards';
import { verifyRecording } from '../shared/recording';
import type { Review, ReviewHand, SnapshotReply, StepReply, TableSnapshot } from '../shared/table';
import { CHAT_SYSTEM, LIVE_CHAT_SYSTEM, LIVE_TABLE } from '../shared/questions';
import { NETWORK_FACTOR } from '../../../packages/kit/server/pool';
import type { GameApiResponse } from '../../../packages/kit/shared/game';
import { DEFAULT_TABLE_LIMITS, tableApi, type TableLimits } from '../server/table';
import { TABLE_TTL_MS } from '../server/token';
import { ANSWER_TTL_MS } from '../server/table';
import { CHAT, DECISION, DECISION2, KEY, LOOSE, SECRET, SECRET_REASONING, setup, type Setup } from './table-server';

const PLAY = (...models: string[]) => ({ mode: 'play', seats: [{ kind: 'human', id: 'you' }, ...models.map((id) => ({ kind: 'model', id }))] });
const WATCH = (...models: string[]) => ({ mode: 'watch', seats: models.map((id) => ({ kind: 'model', id })) });

/** The human's policy: check when free, call small bets, now and then shove or raise to an amount of its own. */
function humanAction(s: TableSnapshot, i: number): unknown {
  const t = s.turn!;
  const keys = t.options.map((o) => o.key);
  if (t.raise && i % 11 === 3) return { action: { kind: 'raise', to: t.raise.min } };
  if (keys.includes('allin') && i % 41 === 4) return { action: { key: 'allin' } };
  if (keys.includes('check')) return { action: { key: 'check' } };
  return { action: { key: t.toCall <= 150 || i % 3 === 0 ? 'call' : 'fold' } };
}

/** Plays a whole game through the API; returns every reply in order and the finished hands. */
async function playToEnd(call: Awaited<ReturnType<typeof setup>>['call'], start: Record<string, unknown>) {
  const first = await call('start', start);
  expect(first.status).toBe(200);
  let { token, snapshot } = first.body as unknown as SnapshotReply;
  const finished: ReviewHand[] = [];
  const steps: StepReply[] = [];
  const tokens: number[] = [token.length];
  for (let i = 0; i < 20_000; i++) {
    if (snapshot.view.street === 'done') {
      if (snapshot.over) return { token, snapshot, finished, steps, tokens };
      const r = await call('next', { token });
      expect(r.status).toBe(200);
      const dealt = r.body as unknown as SnapshotReply;
      // A hand can end as it is dealt (the blinds put everyone all-in): it comes finished with the deal.
      if (dealt.finished) finished.push(dealt.finished);
      ({ token, snapshot } = dealt);
      tokens.push(token.length);
      continue;
    }
    const r = snapshot.turn ? await call('act', { token, ...(humanAction(snapshot, i) as object) }) : await call('step', { token });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const reply = r.body as unknown as StepReply;
    steps.push(reply);
    if (reply.finished) finished.push(reply.finished);
    token = reply.token;
    tokens.push(token.length);
    snapshot = reply.result.snapshot;
  }
  throw new Error('the game did not end');
}

const CARD = /"([2-9TJQKA][cdhs])"/g;

/**
 * Secrecy at a play table (the human in seat 0): replays what every reply showed against what was hidden at that
 * moment (other seats' hole cards until a showdown shows them, the board to come, the reasoning, the table key), until
 * the human is out of the game. Returns how many replies it checked.
 */
function checkSecrecy(responses: { path: string; text: string }[], finished: ReviewHand[]): number {
  const byHand = new Map(finished.map((h) => [h.hand, h]));
  let checked = 0;
  for (const { path, text } of responses) {
    const body = JSON.parse(text) as Record<string, unknown>;
    if (path === 'review') continue;
    const { finished: _f, token: _t, ...shown } = body;
    const snap = ((shown.result as StepReply['result'] | undefined)?.snapshot ?? shown.snapshot) as TableSnapshot;
    expect(snap.spectating).toBe(snap.places[0] !== null ? true : undefined);
    expect(text).not.toContain(KEY);
    if (snap.spectating) continue;
    checked++;
    const hand = byHand.get(snap.hand)!;
    const shownAtShowdown = new Set(snap.events.flatMap((e) => (e.type === 'showdown' ? e.hands.map((x) => x.seat) : [])));
    const hidden = new Set<string>();
    for (const e of hand.events) if (e.type === 'hole' && e.seat !== 0 && !shownAtShowdown.has(e.seat)) e.cards.forEach((c) => hidden.add(formatCard(c)));
    // Board cards not dealt yet.
    hand.runout.slice(snap.view.board.length).forEach((c) => hidden.add(c));
    const seen = [...JSON.stringify(shown).matchAll(CARD)].map((m) => m[1]!);
    expect(seen.filter((c) => hidden.has(c)), `${path} in hand ${snap.hand} shows a hidden card`).toEqual([]);
    for (const e of snap.events) if (e.type === 'hole' && e.seat !== 0 && !shownAtShowdown.has(e.seat)) expect(e.cards).toEqual([]);
    for (const p of snap.view.players) if (p.seat !== 0 && !shownAtShowdown.has(p.seat)) expect(p.cards).toBeNull();
    // No reasoning before the hand is over, and no table key before the game is.
    expect(JSON.stringify(shown)).not.toContain(SECRET_REASONING);
    expect(text).not.toMatch(/"seed"|c0ffee/);
  }
  return checked;
}

describe('the table: starting', () => {
  it('deals a play table to a signed-out visitor against decision models, on the free credits, and shows only their own cards', async () => {
    const { call } = await setup();
    const r = await call('start', PLAY(DECISION, DECISION2, 'openai/gpt-6-luna-decisions'));
    expect(r.status).toBe(200);
    const { token, snapshot } = r.body as unknown as SnapshotReply;
    expect(typeof token).toBe('string');
    expect(snapshot.viewer).toBe(0);
    expect(snapshot.hand).toBe(1);
    expect(snapshot.view.players[0]!.cards).toHaveLength(2);
    for (const p of snapshot.view.players.slice(1)) expect(p.cards).toBeNull();
    for (const e of snapshot.events) if (e.type === 'hole' && e.seat !== 0) expect(e.cards).toEqual([]);
    expect(JSON.stringify(r.body)).not.toContain(KEY);
    expect(JSON.stringify(r.body)).not.toMatch(/seed|c0ffee/i);
  });

  it('refuses a table it cannot seat: too many or too few seats, two humans, a human watching, no human playing, bad bodies (400), an unknown model (403)', async () => {
    const { call } = await setup({ devKey: true });
    const human = { kind: 'human', id: 'you' };
    const m = (id = DECISION) => ({ kind: 'model', id });
    // 2 to 6 seats: you and up to five AIs, or up to six AIs to watch.
    expect(await call('start', { mode: 'play', seats: [human, m(), m(), m(), m(), m(), m()] })).toMatchObject({ status: 400, body: { error: 'A table seats 2 to 6 players' } });
    expect((await call('start', { mode: 'watch', seats: [m(), m(), m(), m(), m(), m(), m()] })).status).toBe(400);
    expect((await call('start', { mode: 'watch', seats: [m()] })).status).toBe(400);
    for (const n of [5, 6]) {
      expect((await call('start', { mode: 'play', seats: [human, ...Array.from({ length: n - 1 }, () => m())] })).status).toBe(200);
      expect((await call('start', { mode: 'watch', seats: Array.from({ length: n }, () => m()) })).status).toBe(200);
    }
    expect((await call('start', { mode: 'play', seats: [human] })).status).toBe(400);
    expect((await call('start', { mode: 'play', seats: [human, human, m()] })).status).toBe(400);
    expect((await call('start', { mode: 'watch', seats: [human, m(), m()] })).status).toBe(400);
    expect((await call('start', { mode: 'play', seats: [m(), m()] })).status).toBe(400);
    expect((await call('start', { mode: 'play', seats: [human, m()], seed: 7 })).status).toBe(400);
    expect((await call('start', { mode: 'race', seats: [human, m()] })).status).toBe(400);
    expect((await call('start', { mode: 'play', seats: [human, { kind: 'bot', id: 'rock' }] })).status).toBe(400);
    expect((await call('start', '[]')).status).toBe(400);
    const unknown = await call('start', PLAY('openai/gpt-4o'));
    expect(unknown).toMatchObject({ status: 403, body: { error: expect.stringContaining('openai/gpt-4o') } });
  });

  it('asks a signed-out visitor to sign in for a chat model (401), even with the free credits open', async () => {
    const { call, up } = await setup();
    expect(await call('start', PLAY(CHAT, DECISION))).toMatchObject({ status: 401, body: { signedOut: true } });
    expect(await call('start', WATCH(CHAT, DECISION))).toMatchObject({ status: 401, body: { signedOut: true } });
    expect(up.calls).toHaveLength(0);
  });

  it('seats a chat model for a signed-in player, and for the local key in development', async () => {
    expect((await (await setup({ signedIn: true })).call('start', PLAY(CHAT, DECISION))).status).toBe(200);
    expect((await (await setup({ devKey: true })).call('start', WATCH(CHAT, DECISION))).status).toBe(200);
  });

  it('tells every chat model at a live table the same live-table words, and the bench never hears them', async () => {
    const models = [CHAT, 'aws/claude-opus-5-5', 'azure:eu/gpt-6.1-sol', 'inceptron/zai-org/GLM-5.3'];
    const { call, up } = await setup({ devKey: true });
    const first = (await call('start', WATCH(...models))).body as unknown as SnapshotReply;
    let token = first.token;
    let snapshot = first.snapshot;
    for (let i = 0; i < 80 && new Set(up.calls.map((c) => c.body.model)).size < models.length; i++) {
      const r = (await call(snapshot.view.street === 'done' ? 'next' : 'step', { token })).body as Record<string, unknown>;
      token = r.token as string;
      snapshot = ((r as unknown as StepReply).result?.snapshot ?? (r as unknown as SnapshotReply).snapshot);
    }
    const chats = up.calls.filter((c) => c.path === '/v3/compat/chat/completions');
    expect(new Set(chats.map((c) => c.body.model))).toEqual(new Set(models));
    for (const c of chats) {
      const [system] = c.body.messages as { role: string; content: string }[];
      expect(system).toEqual({ role: 'system', content: LIVE_CHAT_SYSTEM });
      const schema = c.body.response_format as { json_schema: { schema: { properties: { mood: { enum: string[] } } } } };
      expect(schema.json_schema.schema.properties.mood.enum).toEqual(['annoyed', 'confident', 'nervous', 'relaxed', 'smug']);
    }
    expect(LIVE_CHAT_SYSTEM).toContain(LIVE_TABLE);
    expect(CHAT_SYSTEM).not.toContain('audience');
  });

  it('asks a signed-out visitor to sign in when the free credits are spent (402) or there are none (401)', async () => {
    expect(await (await setup({ pool: 'spent' })).call('start', PLAY(DECISION))).toMatchObject({ status: 402, body: { poolEmpty: true } });
    expect(await (await setup({ pool: 'none' })).call('start', PLAY(DECISION))).toMatchObject({ status: 401, body: { signedOut: true } });
  });

  it('caps the body at 128 KB', async () => {
    const { call } = await setup();
    expect((await call('step', { token: 'x'.repeat(130 * 1024) })).status).toBe(413);
  });
});

describe('the table: tokens', () => {
  it('refuses a tampered token, one sealed with another key or for another purpose, and garbage (400)', async () => {
    const { call } = await setup();
    const { token } = (await call('start', PLAY(DECISION))).body as unknown as SnapshotReply;
    const [iv, ct, tag] = token.split('.');
    const flipped = ct!.slice(0, 10) + (ct![10] === 'A' ? 'B' : 'A') + ct!.slice(11);
    expect(await call('step', { token: `${iv}.${flipped}.${tag}` })).toMatchObject({ status: 400, body: { badToken: true } });
    const opened = unseal(token, purposeKey(SECRET, 'holdem-table'));
    expect(opened).toMatchObject({ key: KEY, mode: 'play' });
    expect((await call('step', { token: seal(opened, purposeKey('x'.repeat(64), 'holdem-table')) })).status).toBe(400);
    expect((await call('step', { token: seal(opened, purposeKey(SECRET, 'holdem-other')) })).status).toBe(400);
    expect((await call('step', { token: 'nope' })).status).toBe(400);
    expect((await call('step', { token: 42 })).status).toBe(400);
    expect((await call('step', {})).status).toBe(400);
    expect((await call('step', { token, extra: 1 })).status).toBe(400);
  });

  it('refuses to replay a hand this table already finished: no folding to see the cards, then playing it again', async () => {
    const { call } = await setup();
    let { token, snapshot } = (await call('start', PLAY(DECISION))).body as unknown as SnapshotReply;
    let kept: string | null = null;
    let finished: StepReply | null = null;
    // Keep the token of the human's first turn, then play the hand to its end.
    while (!finished) {
      const r = snapshot.turn
        ? await call('act', { token, action: { key: snapshot.turn.options.some((o) => o.key === 'fold') ? 'fold' : 'check' } })
        : await call('step', { token });
      if (snapshot.turn && kept === null) kept = token;
      const reply = r.body as unknown as StepReply;
      ({ token } = reply);
      snapshot = reply.result.snapshot;
      if (reply.finished) finished = reply;
    }
    expect(finished.finished!.events.filter((e) => e.type === 'hole').every((e) => e.type === 'hole' && e.cards.length === 2)).toBe(true);
    if (kept) {
      expect(await call('act', { token: kept, action: { key: 'call' } })).toMatchObject({ status: 409, body: { stale: true } });
      expect((await call('step', { token: kept })).status).toBe(409);
    }
    // The table goes on from the latest token.
    expect((await call('next', { token })).status).toBe(200);
  });

  it("answers a retry of the request that finished a hand (its answer was lost) with the same answer, and nothing else on that token", async () => {
    const { call, up } = await setup();
    let { token, snapshot } = (await call('start', PLAY(DECISION, DECISION2))).body as unknown as SnapshotReply;
    let last: { route: string; body: Record<string, unknown> } | null = null;
    let finished: Record<string, unknown> | null = null;
    while (!finished) {
      last = snapshot.turn ? { route: 'act', body: { token, action: { key: snapshot.turn.options.some((o) => o.key === 'check') ? 'check' : 'fold' } } } : { route: 'step', body: { token } };
      const r = await call(last.route, last.body);
      const reply = r.body as unknown as StepReply;
      ({ token } = reply);
      snapshot = reply.result.snapshot;
      if (reply.finished) finished = r.body;
    }
    const calls = up.calls.length;
    // The same request again (the answer was lost on the way): the same answer, no new model call.
    const again = await call(last!.route, last!.body);
    expect(again).toMatchObject({ status: 200 });
    expect(again.body).toEqual(finished);
    expect(up.calls).toHaveLength(calls);
    // Anything else on that token is a replay of a hand whose cards were shown: refused.
    const other = last!.route === 'act' ? { ...last!.body, action: { key: 'allin' } } : { ...last!.body };
    if (last!.route === 'act') expect(await call('act', other)).toMatchObject({ status: 409, body: { stale: true } });
    // Back at the table with that token after a reload: the table as the lost answer left it.
    const resumed = (await call('resume', { token: last!.body.token })).body as unknown as SnapshotReply;
    expect(resumed.token).toBe((finished as unknown as StepReply).token);
    expect(resumed.snapshot).toEqual((finished as unknown as StepReply).result.snapshot);
  });

  it('answers identical steps in flight with one model call: a retry while the first is still thinking gets the same answer', async () => {
    let asked = 0;
    const { call } = await setup({
      up: {
        // Slow, and a different decision each time it is asked: two calls would give two answers.
        decide: (body) => {
          asked++;
          const keys = Object.keys((body.questions as { action: { criteria: Record<string, string> } }).action.criteria);
          const choice = asked % 2 === 1 && keys.includes('fold') ? 'fold' : keys.includes('check') ? 'check' : 'call';
          return { status: 200, delayMs: 150, body: { answers: { action: { type: 'choice', choice } } } };
        },
      },
    });
    let { token, snapshot } = (await call('start', PLAY(DECISION))).body as unknown as SnapshotReply;
    // Raise until the AI faces a bet, so it may fold (and finish the hand) or not.
    while (snapshot.turn) {
      const keys = snapshot.turn.options.map((o) => o.key);
      const r = (await call('act', { token, action: { key: keys.includes('half') ? 'half' : keys.includes('allin') ? 'allin' : keys[0]! } })).body as unknown as StepReply;
      ({ token } = r);
      snapshot = r.result.snapshot;
    }
    asked = 0;
    const first = call('step', { token });
    await new Promise((r) => setTimeout(r, 30));
    const [a, b] = await Promise.all([first, call('step', { token }), call('step', { token })]).then(([x, y, z]) => {
      expect(z.body).toEqual(x.body);
      return [x, y];
    });
    expect(asked).toBe(1);
    expect(a!.status).toBe(200);
    expect(b!.body).toEqual(a!.body);
    // The table plays on from that answer, and resumes from it.
    const reply = a!.body as unknown as StepReply;
    expect((await call('resume', { token: reply.token })).status).toBe(200);
    // A retry afterwards gets the same answer if it ended the hand; otherwise the model is asked again (never seen).
    if (reply.finished) expect((await call('step', { token })).body).toEqual(a!.body);
  });

  it('cancels a shared model call only when every caller has gone', async () => {
    const s = await setup({ up: { decide: (body) => ({ status: 200, delayMs: 300, body: { answers: { action: { type: 'choice', choice: Object.keys((body.questions as { action: { criteria: object } }).action.criteria)[0] } } } }) } });
    const { token } = (await s.call('start', WATCH(DECISION, DECISION2))).body as unknown as SnapshotReply;
    const gone = new AbortController();
    const leaving = fetch(`${s.url}/api/table/step`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }), signal: gone.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 30));
    const staying = s.call('step', { token });
    await new Promise((r) => setTimeout(r, 30));
    gone.abort();
    await leaving;
    expect(await staying).toMatchObject({ status: 200, body: { result: { meta: { by: 'answer' } } } });
  });

  it('holds steps to their own per-visitor limit, before the table is rebuilt', async () => {
    const s = await setup({ limits: { starts: { ratePerSec: 1e6, burst: 1e6 }, moves: { ratePerSec: 1e6, burst: 1e6 }, steps: { ratePerSec: 0.001, burst: 3 } } });
    const { token } = (await s.call('start', WATCH(DECISION, DECISION2))).body as unknown as SnapshotReply;
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await s.call('step', { token: i < 3 ? token : 'garbage' })).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it("forgets the answer that finished a hand after a few minutes: a retry that late is refused", async () => {
    let now = Date.now();
    const { call } = await setup({ now: () => now });
    let { token, snapshot } = (await call('start', PLAY(DECISION))).body as unknown as SnapshotReply;
    let last: { route: string; body: Record<string, unknown> } | null = null;
    for (;;) {
      last = snapshot.turn ? { route: 'act', body: { token, action: { key: snapshot.turn.options.some((o) => o.key === 'fold') ? 'fold' : 'check' } } } : { route: 'step', body: { token } };
      const reply = (await call(last.route, last.body)).body as unknown as StepReply;
      ({ token } = reply);
      snapshot = reply.result.snapshot;
      if (reply.finished) break;
    }
    now += ANSWER_TTL_MS - 1000;
    expect((await call(last.route, last.body)).status).toBe(200);
    now += 2000;
    expect(await call(last.route, last.body)).toMatchObject({ status: 409, body: { stale: true } });
  });

  it('resumes a table after a reload as the player last saw it, with nothing more than they may see', async () => {
    const { call } = await setup({ signedIn: true });
    let { token, snapshot } = (await call('start', PLAY(DECISION, CHAT))).body as unknown as SnapshotReply;
    let older = token;
    for (let i = 0; i < 6 && snapshot.view.street !== 'done'; i++) {
      const r = (snapshot.turn ? await call('act', { token, action: { key: snapshot.turn.options.find((o) => o.key === 'check' || o.key === 'call')!.key } }) : await call('step', { token })).body as unknown as StepReply;
      older = token;
      ({ token } = r);
      snapshot = r.result.snapshot;
    }
    const r = await call('resume', { token });
    expect(r.status).toBe(200);
    const resumed = r.body as unknown as SnapshotReply;
    expect(resumed.token).toBe(token);
    expect(resumed.snapshot).toEqual(snapshot);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(SECRET_REASONING);
    if (snapshot.view.street !== 'done') {
      for (const e of resumed.snapshot.events) if (e.type === 'hole' && e.seat !== 0) expect(e.cards).toEqual([]);
      for (const p of resumed.snapshot.view.players) if (p.seat !== 0) expect(p.cards).toBeNull();
    }
    // An older token of the same hand resumes too (the hand is not over): the table as that token had it.
    expect((await call('resume', { token: older })).status).toBe(200);
  });

  it('refuses to resume a tampered or expired table', async () => {
    let now = Date.now();
    const { call } = await setup({ now: () => now });
    const { token } = (await call('start', PLAY(DECISION))).body as unknown as SnapshotReply;
    expect(await call('resume', { token: token.slice(0, -4) + 'AAAA' })).toMatchObject({ status: 400, body: { badToken: true } });
    expect((await call('resume', {})).status).toBe(400);
    now += TABLE_TTL_MS + 1;
    expect(await call('resume', { token })).toMatchObject({ status: 410, body: { expired: true } });
  });

  it('refuses a token past its six hours (410)', async () => {
    let now = Date.now();
    const { call } = await setup({ now: () => now });
    const { token } = (await call('start', PLAY(DECISION))).body as unknown as SnapshotReply;
    now += TABLE_TTL_MS + 1;
    expect(await call('next', { token })).toMatchObject({ status: 410, body: { expired: true } });
  });

  it('keeps the key and the cards out of the token: only the server can read it', async () => {
    const { call } = await setup();
    const { token } = (await call('start', PLAY(DECISION))).body as unknown as SnapshotReply;
    for (const part of token.split('.')) {
      const bytes = Buffer.from(part, 'base64url');
      expect(bytes.toString('latin1')).not.toMatch(/key|c0ffee/);
      expect(bytes.toString('hex')).not.toContain(KEY);
    }
  });

  it('deals every table from a fresh 256-bit key out of the cryptographic random source', async () => {
    const { call } = await setup({ randomKey: true });
    const keys = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const { token } = (await call('start', PLAY(DECISION))).body as unknown as SnapshotReply;
      const key = (unseal(token, purposeKey(SECRET, 'holdem-table')) as { key: string }).key;
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      keys.add(key);
    }
    expect(keys.size).toBe(8);
  });
});

describe('the table: turns', () => {
  it("refuses a step on the human's turn, an act on an AI's, an illegal action, the next hand mid-hand (409/422)", async () => {
    const { call, up } = await setup();
    let { token, snapshot } = (await call('start', PLAY(DECISION, DECISION2))).body as unknown as SnapshotReply;
    expect((await call('next', { token })).status).toBe(409);
    // Play AIs until it is the human's turn.
    while (!snapshot.turn) {
      if (snapshot.view.street === 'done') ({ token, snapshot } = (await call('next', { token })).body as unknown as SnapshotReply);
      else {
        const before = token;
        const r = (await call('step', { token })).body as unknown as StepReply;
        // Acting for the human while an AI is to act is refused, the token unchanged.
        expect(await call('act', { token: before, action: { key: 'fold' } })).toMatchObject({ status: 409, body: { error: 'It is not your turn' } });
        ({ token } = r);
        snapshot = r.result.snapshot;
      }
    }
    const calls = up.calls.length;
    expect(await call('step', { token })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/your turn/) } });
    expect(up.calls).toHaveLength(calls);
    expect(await call('act', { token, action: { kind: 'raise', to: 1 } })).toMatchObject({ status: 422 });
    const illegal = snapshot.turn.options.some((o) => o.key === 'check') ? 'fold' : 'check';
    // A fold when checking is free is not on the menu; nor is a check facing a bet.
    expect((await call('act', { token, action: { key: illegal } })).status).toBe(422);
    expect((await call('act', { token, action: { key: 'raise_everything' } })).status).toBe(400);
    expect((await call('act', { token, action: { kind: 'raise', to: 1.5 } })).status).toBe(400);
    expect((await call('act', { token })).status).toBe(400);
    const ok = await call('act', { token, action: { key: snapshot.turn.options[0]!.key } });
    expect(ok.status).toBe(200);
    const r = ok.body as unknown as StepReply;
    expect(r.result).toMatchObject({ seat: 0, meta: { by: 'human' } });
  });

  it('refuses act in watch mode: there is no human', async () => {
    const { call } = await setup();
    const { token } = (await call('start', WATCH(DECISION, DECISION2))).body as unknown as SnapshotReply;
    expect((await call('act', { token, action: { key: 'call' } })).status).toBe(409);
    expect((await call('step', { token })).status).toBe(200);
  });
});

describe('the table: a whole game', () => {
  it('plays a Sit & Go to the end against decision and chat models, keeping every hidden card hidden until it is public', async () => {
    const { call, responses, up, logs } = await setup({ signedIn: true });
    const game = await playToEnd(call, PLAY(DECISION, CHAT, DECISION2));
    expect(game.snapshot.over).toBe(true);
    // Every finished hand arrived, face up, with the chat model's reasoning.
    expect(game.finished.map((h) => h.hand)).toEqual(Array.from({ length: game.snapshot.hand }, (_, i) => i + 1));
    const chatMoves = game.finished.flatMap((h) => h.actions.filter((x) => x.seat === 2 && x.by === 'answer'));
    expect(chatMoves.length).toBeGreaterThan(0);
    for (const x of chatMoves) expect(x).toMatchObject({ reasoning: expect.stringContaining(SECRET_REASONING), say: expect.any(String), mood: 'confident', costUsd: 0.0012, latencyMs: expect.any(Number) });
    for (const x of game.finished.flatMap((h) => h.actions.filter((a) => a.seat !== 0 && a.seat !== 2))) expect(x).toMatchObject({ by: 'answer', costUsd: 0.00001, probabilities: expect.any(Object) });
    // The player's key paid, and the chat model was asked in the game's format.
    expect(new Set(up.calls.map((c) => c.headers.authorization))).toEqual(new Set(['Bearer op-player']));
    const chat = up.calls.find((c) => c.path === '/v3/compat/chat/completions')!;
    expect(chat.body).toMatchObject({ model: CHAT, reasoning_effort: 'low', max_tokens: 4000 });
    expect(chat.headers['x-opper-name']).toBe('decision-benchmarks-holdem');
    expect(logs.some((l) => /table \S+: hand 1, seat \d .* in \d+ ms, \$/.test(l))).toBe(true);

    // Secrecy: every reply until the human is out of the game (from then on they watch with every card up: the next test).
    const checked = checkSecrecy(responses, game.finished);
    expect(checked).toBeGreaterThan(20);

    // The review: every hand face up, and once over, the recording with its table key, which verifies.
    const review = (await call('review', { token: game.token })).body as unknown as Review;
    expect(review.hands).toHaveLength(game.snapshot.hand);
    expect(review.players).toEqual([{ kind: 'human', id: 'you' }, { kind: 'model', id: DECISION }, { kind: 'model', id: CHAT }, { kind: 'model', id: DECISION2 }]);
    expect(review.recording!.sitngo).toEqual({ key: KEY, startingStack: 1500 });
    expect(verifyRecording(review.recording)).toMatchObject({ ok: true });
    expect(review.hands.map((h) => h.events)).toEqual(game.finished.map((h) => h.events));
    // Steps after the end are refused.
    expect((await call('step', { token: game.token })).status).toBe(409);
    expect((await call('next', { token: game.token })).status).toBe(409);
    // A real length of game (the fake models fold to big bets), and the token stays small all along: the compact log,
    // plus one hand's talk and reasoning (66 hands and 535 actions: at most 2.2 KB).
    expect(game.snapshot.hand).toBeGreaterThan(20);
    expect(Math.max(...game.tokens)).toBeLessThan(4 * 1024);
  });

  it('shows a player who is out of the game every card and the reasoning, as a spectator; a token from before still hides them', async () => {
    const { call } = await setup({ signedIn: true });
    let { token, snapshot } = (await call('start', PLAY(CHAT, DECISION))).body as unknown as SnapshotReply;
    let beforeBust = token;
    const after: StepReply[] = [];
    // The human shoves every hand until they are out, then the models play on a few actions.
    for (let i = 0; i < 5000 && after.length < 12 && !snapshot.over; i++) {
      if (snapshot.view.street === 'done') {
        ({ token, snapshot } = (await call('next', { token })).body as unknown as SnapshotReply);
        continue;
      }
      if (snapshot.places[0] === null) beforeBust = token;
      const r = snapshot.turn ? await call('act', { token, action: { key: snapshot.turn.options.some((o) => o.key === 'allin') ? 'allin' : 'call' } }) : await call('step', { token });
      const reply = r.body as unknown as StepReply;
      if (reply.result.snapshot.places[0] !== null) after.push(reply);
      ({ token } = reply);
      snapshot = reply.result.snapshot;
    }
    expect(after.length).toBeGreaterThan(0);
    // The reply that knocked them out already shows every card of that hand.
    const bust = after[0]!.result.snapshot;
    expect(bust).toMatchObject({ viewer: 0, spectating: true, turn: null });
    for (const e of bust.events) if (e.type === 'hole') expect(e.cards).toHaveLength(2);
    // Later hands: every live seat's cards, and the chat model's reasoning with each of its steps.
    for (const r of after.slice(1)) {
      const s = r.result.snapshot;
      expect(s.spectating).toBe(true);
      if (s.view.street !== 'done') for (const p of s.view.players) if (p.status !== 'empty') expect(p.cards).toHaveLength(2);
      if (r.result.seat === 1 && r.result.meta.by === 'answer') expect(r.result.meta.reasoning).toContain(SECRET_REASONING);
    }
    if (!snapshot.over) expect(JSON.stringify(after)).not.toContain(KEY);
    // A token from before the bust still sees the table as a player: own cards only. (This instance refuses it as a
    // replay of a finished hand; another instance, which never saw the hand end, answers it.)
    expect(await call('resume', { token: beforeBust })).toMatchObject({ status: 409 });
    const elsewhere = await setup({ signedIn: true });
    const resumed = (await elsewhere.call('resume', { token: beforeBust })).body as unknown as SnapshotReply;
    expect(resumed.snapshot.spectating).toBeUndefined();
    if (resumed.snapshot.view.street !== 'done') for (const p of resumed.snapshot.view.players) if (p.seat !== 0) expect(p.cards).toBeNull();
  });

  it('keeps the review of a game in play to the finished hands and without the table key', async () => {
    const { call } = await setup();
    let { token, snapshot } = (await call('start', PLAY(DECISION))).body as unknown as SnapshotReply;
    let review = (await call('review', { token })).body as unknown as Review;
    expect(review).toEqual({ players: [{ kind: 'human', id: 'you' }, { kind: 'model', id: DECISION }], hands: [], recording: null });
    while (snapshot.view.street !== 'done') {
      const r = (snapshot.turn ? await call('act', { token, action: { key: snapshot.turn.options.some((o) => o.key === 'check') ? 'check' : 'fold' } }) : await call('step', { token })).body as unknown as StepReply;
      ({ token } = r);
      snapshot = r.result.snapshot;
    }
    review = (await call('review', { token })).body as unknown as Review;
    expect(review.hands).toHaveLength(1);
    expect(review.recording).toBeNull();
    expect(JSON.stringify(review)).not.toContain(KEY);
  });

  it('watches models play with every card face up and the reasoning as each action comes, on the local key', async () => {
    const { call, up } = await setup({ devKey: true, pool: 'none' });
    const game = await playToEnd(call, WATCH(CHAT, DECISION));
    expect(game.snapshot.viewer).toBeNull();
    const first = game.steps[0]!.result;
    expect(first.snapshot.view.players.every((p) => p.cards?.length === 2)).toBe(true);
    const chatSteps = game.steps.filter((s) => s.result.seat === 0 && s.result.meta.by === 'answer');
    for (const s of chatSteps) expect(s.result.meta.reasoning).toContain(SECRET_REASONING);
    expect(new Set(up.calls.map((c) => c.headers['x-opper-project']))).toEqual(new Set(['proj-1']));
    expect(new Set(up.calls.map((c) => c.headers.authorization))).toEqual(new Set(['Bearer op-dev']));
  });
});

describe('the table: six seats', () => {
  const tokenSizes: string[] = [];
  afterAll(() => console.info(`six-handed tokens at most: ${tokenSizes.join('; ')}`));
  const SIX = [DECISION, CHAT, DECISION2, 'aws/claude-opus-5-5', 'openai/gpt-6-luna-decisions'];

  it('plays you and five AIs to the end, blinds up every 12 hands, every hidden card hidden in every reply until public, the token small', async () => {
    const { call, responses } = await setup({ signedIn: true });
    const game = await playToEnd(call, PLAY(...SIX));
    expect(game.snapshot.over).toBe(true);
    expect(game.snapshot.view.players).toHaveLength(6);
    expect(game.finished.map((h) => h.hand)).toEqual(Array.from({ length: game.snapshot.hand }, (_, i) => i + 1));
    // Two orbits of six to a level: hand 12 still at 10/20, hand 13 at 15/30.
    const first = (JSON.parse(responses[0]!.text) as SnapshotReply).snapshot;
    expect(first.view.level).toMatchObject({ hand: 1, level: 1, sb: 10, bb: 20, handsUntilNextLevel: 12 });
    const bb = new Map(game.finished.map((h) => [h.hand, (h.events[0] as { bb: number }).bb]));
    expect([bb.get(1), bb.get(12), bb.get(13)]).toEqual([20, 20, 30]);
    // Every reply scanned while the human plays: other seats' cards, the board to come, the reasoning, the table key.
    expect(checkSecrecy(responses, game.finished)).toBeGreaterThan(40);
    expect(responses.filter((r) => r.path !== 'review').every((r) => !r.text.includes(KEY))).toBe(true);
    // The review: six players, places 1 to 6, and the recording verifies.
    const review = (await call('review', { token: game.token })).body as unknown as Review;
    expect(review.players).toEqual([{ kind: 'human', id: 'you' }, ...SIX.map((id) => ({ kind: 'model', id }))]);
    const v = verifyRecording(review.recording);
    expect(v.ok && [...v.result.places!].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(review.recording!.result.chips.reduce((a, b) => a + b, 0)).toBe(6 * 1500);
    // The token, compact log and all: a long six-handed game stays well inside a request.
    const actions = game.finished.reduce((a, h) => a + h.actions.length, 0);
    tokenSizes.push(`${game.snapshot.hand} hands, ${actions} actions: ${Math.max(...game.tokens)} characters`);
    expect(Math.max(...game.tokens)).toBeLessThan(6 * 1024);
  });

  it("keeps a long six-handed game's token small: a passive table that runs about 100 hands", async () => {
    // The decision models check, or call up to 3 big blinds and fold to more, so hands are many and long.
    const passive = (body: Record<string, unknown>) => {
      const criteria = (body.questions as { action: { criteria: Record<string, string> } }).action.criteria;
      const bb = Number(/\(([\d.]+) big blinds\)/.exec(criteria.call ?? '')?.[1] ?? 0);
      const choice = 'check' in criteria ? 'check' : bb <= 3 ? 'call' : 'fold';
      return { status: 200, body: { answers: { action: { type: 'choice', choice, probabilities: { [choice]: 0.9 } } }, usage: { input_tokens: 800, output_tokens: 1 } }, headers: { 'x-opper-cost': '0.00001' } };
    };
    const { call } = await setup({ up: { decide: passive } });
    const game = await playToEnd(call, PLAY(DECISION, DECISION2, 'openai/gpt-6-luna-decisions', 'opper/kev-4b', 'cloudflare:global/clef-flash'));
    expect(game.snapshot.over).toBe(true);
    const actions = game.finished.reduce((a, h) => a + h.actions.length, 0);
    tokenSizes.push(`${game.snapshot.hand} hands, ${actions} actions: ${Math.max(...game.tokens)} characters`);
    // About 100 hands and 1,500 actions: about 5.4 KB, some 50 characters a hand (the body cap is 128 KB).
    expect(game.snapshot.hand).toBeGreaterThanOrEqual(90);
    expect(Math.max(...game.tokens)).toBeLessThan(8 * 1024);
  });

  it('watches six AIs to the end with every card face up, and the recording verifies', async () => {
    const { call, up } = await setup({ devKey: true, pool: 'none' });
    const models = [CHAT, DECISION, 'aws/claude-opus-5-5', DECISION2, 'azure:eu/gpt-6.1-sol', 'openai/gpt-6-luna-decisions'];
    const game = await playToEnd(call, WATCH(...models));
    expect(game.snapshot).toMatchObject({ viewer: null, over: true });
    for (const s of game.steps) if (s.result.snapshot.view.street !== 'done') for (const p of s.result.snapshot.view.players) if (p.status !== 'empty') expect(p.cards).toHaveLength(2);
    expect(game.steps.filter((s) => s.result.seat === 0 && s.result.meta.by === 'answer').every((s) => s.result.meta.reasoning?.includes(SECRET_REASONING))).toBe(true);
    expect(new Set(up.calls.map((c) => c.body.model ?? 'systemone')).size).toBeGreaterThan(2);
    const review = (await call('review', { token: game.token })).body as unknown as Review;
    expect(verifyRecording(review.recording)).toMatchObject({ ok: true });
    expect(review.recording!.players.map((p) => p.id)).toEqual(models);
  });
});

describe('the table: when a model does not answer', () => {
  /** Steps until an AI acts; returns its result. */
  async function firstAiMove(o: Setup, start = PLAY(DECISION)) {
    const s = await setup(o);
    const { token, snapshot } = (await s.call('start', start)).body as unknown as SnapshotReply;
    const r = snapshot.turn ? await s.call('act', { token, action: { key: snapshot.turn.options.find((x) => x.key === 'call' || x.key === 'check')!.key } }) : null;
    const t = r ? (r.body as unknown as StepReply).token : token;
    return { ...s, step: await s.call('step', { token: t }) };
  }

  it('plays the fallback (check if free, else fold) with why: an answer that is no option, a failed call, a late one', async () => {
    const invalid = await firstAiMove({ up: { decide: () => ({ status: 200, body: { answers: { action: { type: 'choice', choice: 'raise_everything' } } } }) } });
    expect((invalid.step.body as unknown as StepReply).result).toMatchObject({ key: expect.stringMatching(/^(check|fold)$/), meta: { by: 'fallback', why: 'invalid' } });
    const down = await firstAiMove({ up: { decide: () => ({ status: 500, body: { error: 'down' } }) } });
    expect((down.step.body as unknown as StepReply).result.meta).toMatchObject({ by: 'fallback', why: 'error' });
    expect(down.logs.some((l) => l.includes('the fallback plays'))).toBe(true);
    const late = await firstAiMove({ up: { decide: () => ({ status: 200, body: { answers: {} }, delayMs: 4000 }) } });
    expect((late.step.body as unknown as StepReply).result.meta).toMatchObject({ by: 'fallback', why: 'timeout', latencyMs: 2500 });
  });

  it("plays the fallback for a chat model's refusal and unreadable reply", async () => {
    const refused = await firstAiMove({ signedIn: true, up: { chat: () => ({ status: 200, body: { choices: [{ finish_reason: 'refusal', message: { content: null, refusal: 'No gambling' } }] } }) } }, PLAY(CHAT));
    expect((refused.step.body as unknown as StepReply).result.meta).toMatchObject({ by: 'fallback', why: 'refusal' });
    const garbled = await firstAiMove({ signedIn: true, up: { chat: () => ({ status: 200, body: { choices: [{ message: { content: 'I call!' } }] } }) } }, PLAY(CHAT));
    expect((garbled.step.body as unknown as StepReply).result.meta).toMatchObject({ by: 'fallback', why: 'invalid' });
  });

  it("answers Opper refusing the player's key (401, session cleared; 402 wallet) without playing a move", async () => {
    const expired = await firstAiMove({ signedIn: true, up: { decide: () => ({ status: 401, body: { error: 'bad key' } }) } });
    expect(expired.step).toMatchObject({ status: 401, body: { signedOut: true } });
    expect(expired.step.body).not.toHaveProperty('token');
    expect(expired.step.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
    const broke = await firstAiMove({ signedIn: true, up: { decide: () => ({ status: 402, body: {} }) } });
    expect(broke.step).toMatchObject({ status: 402, body: { walletUrl: expect.stringMatching(/^https:/) } });
  });

  it('closes the free credits when Opper says they are spent (402), and limits a visitor sending too fast (429)', async () => {
    const spent = await firstAiMove({ up: { decide: () => ({ status: 402, body: {} }) } });
    expect(spent.step).toMatchObject({ status: 402, body: { poolEmpty: true } });
    expect(spent.access!.pool.current().open).toBe(false);
    const s = await setup({ poolRate: 1 });
    const { token } = (await s.call('start', WATCH(DECISION, DECISION2))).body as unknown as SnapshotReply;
    expect((await s.call('step', { token })).status).toBe(200);
    expect(await s.call('step', { token })).toMatchObject({ status: 429 });
  });
});

/**
 * The table API called directly, as the kit calls it (the local key, no model ever asked), for floods too long to send
 * over HTTP. Every table deals from KEY, so every one deals the same cards and the same seat acts first.
 */
function direct(o: { now?: () => number; limits?: Partial<TableLimits> } = {}) {
  const key = purposeKey(SECRET, 'holdem-table');
  const logs: string[] = [];
  const api = tableApi({ now: o.now ?? (() => Date.now()), key: () => KEY, clock: () => performance.now() }, o.limits);
  const signal = new AbortController().signal;
  const call = async (route: string, body: unknown, visitor = '198.51.100.1') => {
    const r: GameApiResponse = await api.routes[`/api/table/${route}`]!({
      body,
      visitor,
      payer: () => ({ mode: 'dev', provider: 'opper', apiKey: 'op-dev', baseUrl: 'http://127.0.0.1:9' }),
      unpaid: () => ({ status: 401, body: {} }),
      takePool: () => null,
      poolSpent: () => {},
      seal: (_purpose, value) => seal(value, key),
      open: (_purpose, token) => unseal(token, key),
      fetch: (async () => {
        throw new Error('no model is asked here');
      }) as typeof fetch,
      log: (line) => logs.push(line),
      signal,
    });
    return r as { status: number; body: Record<string, unknown> & Partial<SnapshotReply & StepReply>; headers?: Record<string, string> };
  };
  /** A table where the human acts first (heads-up, on the button): started, its first token kept, then folded. */
  const folded = async (visitor?: string) => {
    const s = await call('start', HUMAN_FIRST, visitor);
    if (s.status !== 200) return { status: s.status, start: s };
    const kept = s.body.token!;
    expect(s.body.snapshot!.turn).toBeTruthy();
    const f = await call('act', { token: kept, action: { key: 'fold' } }, visitor);
    expect(f.body.finished).toBeTruthy();
    return { status: 200, start: s, kept };
  };
  return { call, logs, folded };
}

/** Heads-up against a decision model with the human on KEY's button: the human acts first, so a fold ends the hand at once. */
const HUMAN_FIRST = await (async () => {
  const { call } = direct();
  const first = PLAY(DECISION);
  const r = await call('start', first);
  return r.body.snapshot!.turn ? first : { mode: 'play', seats: [...first.seats].reverse() };
})();

const forgot = (logs: string[]) => logs.filter((l) => /forget/.test(l));

describe('the table: a flood of new tables', () => {
  it("keeps refusing a finished hand's replay through a flood: one visitor is held to its new tables (429), so the memory can't fill", async () => {
    const { call, logs, folded } = direct({ limits: { starts: { ratePerSec: 0.001, burst: 5 }, remember: 10 } });
    const { kept } = await folded();
    expect(await call('act', { token: kept, action: { key: 'call' } })).toMatchObject({ status: 409, body: { stale: true } });
    let refused = 0;
    for (let i = 0; i < 50; i++) {
      const r = await folded();
      if (r.status === 200) continue;
      refused++;
      expect(r.start).toEqual({ status: 429, body: { error: expect.stringMatching(/new tables/) }, headers: { 'Retry-After': expect.stringMatching(/^[1-9]\d*$/) } });
    }
    expect(refused).toBe(46);
    expect(await call('act', { token: kept, action: { key: 'call' } })).toMatchObject({ status: 409, body: { stale: true } });
    expect(forgot(logs)).toEqual([]);
    // Another visitor still starts tables.
    expect((await folded('203.0.113.50')).status).toBe(200);
  });

  it('remembers a finished hand until its table has closed (its tokens expire), then lets it go to make room', async () => {
    let now = Date.now();
    const { call, logs, folded } = direct({ now: () => now, limits: { ...LOOSE, remember: 2 } });
    await folded();
    now += TABLE_TTL_MS + 1;
    const b = await folded();
    await folded();
    // The closed table made room: nothing still open was forgotten.
    expect(forgot(logs)).toEqual([]);
    expect(await call('act', { token: b.kept, action: { key: 'call' } })).toMatchObject({ status: 409, body: { stale: true } });
  });

  it('past its size (only many visitors together get there) forgets the table that finished a hand longest ago, and logs it once', async () => {
    const { call, logs, folded } = direct({ limits: { ...LOOSE, remember: 3 } });
    const a = await folded();
    const b = await folded();
    for (let i = 0; i < 3; i++) await folded();
    expect(forgot(logs)).toHaveLength(1);
    // As the header comment says: a forgotten table's hand can be replayed on this instance.
    expect((await call('act', { token: a.kept, action: { key: 'call' } })).status).toBe(200);
    expect((await call('act', { token: b.kept, action: { key: 'call' } })).status).toBe(200);
  });

  it('holds a visitor to a pace on the calls no model answers (act, next, review: 429), and nobody else', async () => {
    const { call } = direct({ limits: { moves: { ratePerSec: 0.001, burst: 3 } } });
    const { token } = (await call('start', HUMAN_FIRST)).body as unknown as SnapshotReply;
    for (let i = 0; i < 3; i++) expect((await call('review', { token })).status).toBe(200);
    expect(await call('act', { token, action: { key: 'fold' } })).toEqual({ status: 429, body: { error: expect.stringMatching(/slow down/) }, headers: { 'Retry-After': expect.stringMatching(/^[1-9]\d*$/) } });
    expect((await call('next', { token })).status).toBe(429);
    expect((await call('act', { token, action: { key: 'fold' } }, '203.0.113.50')).status).toBe(200);
  });

  it("sizes the memory so one visitor held to its new tables can't fill it in a token's six hours, even from a whole IPv6 /48", () => {
    const { starts, remember } = DEFAULT_TABLE_LIMITS;
    expect((starts.burst + (starts.ratePerSec * TABLE_TTL_MS) / 1000) * NETWORK_FACTOR).toBeLessThan(remember);
  });

  it("lets a person play a whole game and start the next under the default limits, through the kit's routes", async () => {
    let now = Date.now();
    // About a person's pace: a quarter of a second between calls, faster than anyone clicks.
    const { call } = await setup({ limits: DEFAULT_TABLE_LIMITS, now: () => (now += 125) });
    await playToEnd(call, PLAY(DECISION, DECISION2));
    expect((await call('start', PLAY(DECISION))).status).toBe(200);
  });

  it("answers a visitor past its new tables with the kit's 429 (Retry-After) over HTTP", async () => {
    const { call } = await setup({ limits: { starts: { ratePerSec: 0.001, burst: 1 } } });
    expect((await call('start', PLAY(DECISION))).status).toBe(200);
    const r = await call('start', PLAY(DECISION));
    expect(r).toMatchObject({ status: 429, body: { error: expect.any(String) } });
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
