import { describe, expect, it, vi } from 'vitest';
import { verifyRecording } from '../shared/recording';
import type { TableDriver, TableSnapshot } from '../src/driver';
import { errorKind, RemoteDriver, TableError } from '../src/remote-driver';
import { CHAT, DECISION, KEY, SECRET_REASONING, setup, type Setup } from './table-server';

/** A RemoteDriver on the test table service, sending the player's cookie as the browser would. */
async function remote(o: Setup = {}) {
  const s = await setup(o);
  const f = vi.fn<typeof fetch>((input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), ...(s.cookie ? { cookie: s.cookie } : {}) } }));
  return { ...s, f, driver: new RemoteDriver({ fetch: f, url: (route) => `${s.url}/api/table/${route}`, storage: null }) };
}

/** Plays to the end: AIs by step(), the human by checking or calling. */
async function playOut(d: TableDriver, first: TableSnapshot): Promise<TableSnapshot> {
  let s = first;
  for (let i = 0; i < 20_000; i++) {
    if (s.view.street === 'done') {
      if (s.over) return s;
      s = await d.nextHand();
      continue;
    }
    if (s.turn) {
      const keys = s.turn.options.map((o) => o.key);
      s = (await d.act({ key: keys.includes('check') ? 'check' : s.turn.toCall <= 150 || i % 3 === 0 ? 'call' : 'fold' })).snapshot;
    } else s = (await d.step()).snapshot;
  }
  throw new Error('the game did not end');
}

describe('RemoteDriver', () => {
  it("plays a whole Sit & Go on the service; the review has every hand face up with the chat model's reasoning, and the recording verifies", async () => {
    const { driver } = await remote({ signedIn: true });
    const first = await driver.start({ seats: [{ kind: 'human', id: 'you' }, { kind: 'model', id: CHAT }, { kind: 'model', id: DECISION }] });
    expect(first.viewer).toBe(0);
    const last = await playOut(driver, first);
    expect(last.over).toBe(true);
    const review = await driver.review();
    expect(review.hands).toHaveLength(last.hand);
    const chat = review.hands.flatMap((h) => h.actions.filter((x) => x.seat === 1 && x.by === 'answer'));
    expect(chat.length).toBeGreaterThan(0);
    for (const x of chat) expect(x.reasoning).toContain(SECRET_REASONING);
    const rec = review.recording!;
    expect(verifyRecording(rec)).toMatchObject({ ok: true });
    // The recording keeps what the models said and why, which the server's token let go of hand by hand.
    expect(rec.hands.flatMap((h) => h.actions).filter((x) => x.reasoning?.includes(SECRET_REASONING)).length).toBe(chat.length);
    expect(rec.hands.flatMap((h) => h.actions).some((x) => x.probabilities)).toBe(true);
  });

  it('puts the reasoning that came with each step back into the finished hands when watching', async () => {
    const { driver } = await remote({ devKey: true, pool: 'none' });
    let s = await driver.start({ seats: [{ kind: 'model', id: CHAT }, { kind: 'model', id: DECISION }] });
    const said: string[] = [];
    while (s.view.street !== 'done') {
      const r = await driver.step();
      if (r.meta.reasoning) said.push(r.meta.reasoning);
      s = r.snapshot;
    }
    const review = await driver.review();
    expect(review.recording).toBeNull();
    expect(review.hands[0]!.actions.flatMap((x) => (x.reasoning ? [x.reasoning] : []))).toEqual(said);
  });

  it('cancels a step with its signal and keeps the table as it was', async () => {
    const { driver, f } = await remote({ up: { decide: (body) => ({ status: 200, delayMs: 300, body: { answers: { action: { type: 'choice', choice: Object.keys((body.questions as { action: { criteria: object } }).action.criteria)[0] } } } }) } });
    let s = await driver.start({ seats: [{ kind: 'model', id: DECISION }, { kind: 'model', id: DECISION }] });
    const ac = new AbortController();
    const pending = driver.step(ac.signal);
    setTimeout(() => ac.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const tokenSent = JSON.parse(f.mock.calls[1]![1]!.body as string).token;
    s = (await driver.step()).snapshot;
    expect(JSON.parse(f.mock.calls[2]![1]!.body as string).token).toBe(tokenSent);
    expect(s.view.history).toHaveLength(1);
  });

  it('asks a signed-out player to sign in for a chat model: a TableError of kind signin', async () => {
    const { driver } = await remote();
    const err = await driver.start({ seats: [{ kind: 'human', id: 'you' }, { kind: 'model', id: CHAT }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TableError);
    expect(err).toMatchObject({ kind: 'signin', status: 401 });
    await expect(driver.start({ seats: [{ kind: 'human', id: 'you' }, { kind: 'bot', id: 'rock' }] })).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(driver.step()).rejects.toMatchObject({ kind: 'refused' });
  });

  it('maps every refusal to a kind the page can act on', async () => {
    const reply = (status: number, body: unknown) => new RemoteDriver({ fetch: async () => new Response(JSON.stringify(body), { status }), url: (r) => `http://table/${r}`, storage: null, sleep: async () => {} });
    const seats = [{ kind: 'human' as const, id: 'you' }, { kind: 'model' as const, id: DECISION }];
    const cases: [number, unknown, string][] = [
      [401, { error: 'Sign in', signedOut: true }, 'signin'],
      [402, { error: 'Top up', walletUrl: 'https://platform.opper.ai/wallet' }, 'wallet'],
      [402, { error: 'Spent', poolEmpty: true, signedOut: true }, 'pool'],
      [429, { error: 'Busy', poolEmpty: true }, 'pool'],
      [403, { error: 'No such model' }, 'forbidden'],
      [410, { error: 'Closed', expired: true }, 'expired'],
      [400, { error: 'Not ours', badToken: true }, 'expired'],
      [409, { error: 'Not your turn' }, 'refused'],
      [422, { error: 'Illegal' }, 'refused'],
      [500, { error: 'internal error' }, 'failed'],
    ];
    // Passing troubles (too fast, a proxy's 502/503/504, no connection) are retried until the budget runs out, then 'failed'.
    for (const [status, body, kind] of cases) await expect(reply(status, body).start({ seats }), `${status}`).rejects.toMatchObject({ kind, status, message: (body as { error: string }).error });
    await expect(reply(402, { error: 'Top up', walletUrl: 'https://platform.opper.ai/wallet' }).start({ seats })).rejects.toMatchObject({ walletUrl: 'https://platform.opper.ai/wallet' });
    let clock = 0;
    const quick = { url: (r: string) => r, storage: null, now: () => clock, sleep: async (ms: number) => void (clock += ms) };
    const offline = new RemoteDriver({ ...quick, fetch: async () => Promise.reject(new TypeError('fetch failed')) });
    await expect(offline.start({ seats })).rejects.toMatchObject({ kind: 'failed', status: 0 });
    const html = new RemoteDriver({ ...quick, fetch: async () => new Response('<html>Bad gateway</html>', { status: 502 }) });
    await expect(html.start({ seats })).rejects.toMatchObject({ kind: 'failed', status: 502 });
    const busy = new RemoteDriver({ ...quick, fetch: async () => new Response(JSON.stringify({ error: 'Slow down' }), { status: 429 }) });
    await expect(busy.start({ seats })).rejects.toMatchObject({ kind: 'failed', status: 429 });
    expect(errorKind(400, {})).toBe('failed');
  });
});

/** A Map-backed localStorage. */
const memoryStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};

describe('RemoteDriver on a bad connection', () => {
  it('plays a whole game through a connection that drops requests and loses answers, the same token sent again each time', async () => {
    const s = await setup({ signedIn: true });
    let n = 0;
    const lost: string[] = [];
    let lostFinishing = 0;
    // Every 4th request never arrives; every 3rd reaches the server, but its answer is lost on the way back.
    const flaky = async (input: RequestInfo | URL, init?: RequestInit) => {
      n++;
      if (n % 4 === 0) throw new TypeError('Failed to fetch');
      const res = await fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), cookie: s.cookie } });
      if (n % 3 === 0) {
        lost.push(String(input).split('/').at(-1)!);
        // An answer that finished a hand: the retry must get it again, though the replay guard now refuses its token.
        if (res.ok && 'finished' in ((await res.json()) as object) && /\/(step|act)$/.test(String(input))) lostFinishing++;
        throw new TypeError('network connection was lost');
      }
      return res;
    };
    const events: string[] = [];
    const driver = new RemoteDriver({ fetch: flaky, url: (route) => `${s.url}/api/table/${route}`, storage: null, sleep: async () => {}, onConnection: (e) => events.push(e.state) });
    const last = await playOut(driver, await driver.start({ seats: [{ kind: 'human', id: 'you' }, { kind: 'model', id: CHAT }, { kind: 'model', id: DECISION }] }));
    expect(last.over).toBe(true);
    expect(new Set(lost)).toEqual(new Set(['step', 'act', 'next']));
    expect(lostFinishing).toBeGreaterThan(0);
    expect(events.filter((e) => e === 'reconnecting').length).toBeGreaterThan(20);
    expect(events.at(-1)).toBe('ok');
    const review = await driver.review();
    expect(review.hands).toHaveLength(last.hand);
    expect(verifyRecording(review.recording)).toMatchObject({ ok: true });
  });

  it('backs off 0.5, 1, 2, 4, 8, 8... s, honours Retry-After, and gives up after two minutes with a TableError failed', async () => {
    let clock = 0;
    const waits: number[] = [];
    const events: unknown[] = [];
    const f = vi.fn<typeof fetch>(async () => new Response('{"error":"Bad gateway"}', { status: 502 }));
    const d = new RemoteDriver({ fetch: f, url: (r) => r, storage: null, now: () => clock, sleep: async (ms) => void (waits.push(ms), (clock += ms)), onConnection: (e) => events.push(e) });
    await expect(d.start({ seats: [{ kind: 'human', id: 'you' }, { kind: 'model', id: DECISION }] })).rejects.toMatchObject({ kind: 'failed', status: 502 });
    expect(waits.slice(0, 6)).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(120_000);
    expect(f).toHaveBeenCalledTimes(waits.length + 1);
    expect(events[0]).toEqual({ state: 'reconnecting', attempt: 1, nextInMs: 500, error: 'HTTP 502' });
    const limited = new RemoteDriver({ fetch: async () => new Response('{"error":"Slow down"}', { status: 429, headers: { 'Retry-After': '3' } }), url: (r) => r, storage: null, now: () => clock, sleep: async (ms) => void (waits.push(ms), (clock += ms)) });
    waits.length = 0;
    await expect(limited.start({ seats: [{ kind: 'human', id: 'you' }, { kind: 'model', id: DECISION }] })).rejects.toMatchObject({ kind: 'failed' });
    expect(waits[0]).toBe(3000);
  });

  it('never retries a refusal: not your turn (409), an illegal action (422), a closed table (410)', async () => {
    for (const status of [400, 401, 402, 403, 409, 410, 422]) {
      const f = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: 'no' }), { status }));
      const d = new RemoteDriver({ fetch: f, url: (r) => r, storage: null, sleep: async () => {} });
      await expect(d.start({ seats: [{ kind: 'human', id: 'you' }, { kind: 'model', id: DECISION }] })).rejects.toBeInstanceOf(TableError);
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it('stops retrying when the page cancels the step', async () => {
    const ac = new AbortController();
    const f = vi.fn<typeof fetch>(async () => Promise.reject(new TypeError('Failed to fetch')));
    const d = new RemoteDriver({ fetch: f, url: (r) => r, storage: null, sleep: async () => ac.abort() });
    (d as unknown as { token: string }).token = 't';
    await expect(d.step(ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('RemoteDriver: back at the table after a reload', () => {
  it('keeps the table in this browser and sits back down where the player left it, then clears it when the game is over', async () => {
    const s = await setup({ signedIn: true });
    const storage = memoryStorage();
    const make = () => new RemoteDriver({ fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), cookie: s.cookie } }), url: (route) => `${s.url}/api/table/${route}`, storage });
    const seats = [{ kind: 'human' as const, id: 'you' }, { kind: 'model' as const, id: CHAT }, { kind: 'model' as const, id: DECISION }];
    const first = make();
    let snap = await first.start({ seats });
    for (let i = 0; i < 30 && !(snap.hand >= 2 && snap.view.street !== 'done' && snap.turn); i++) {
      if (snap.view.street === 'done') snap = await first.nextHand();
      else if (snap.turn) snap = (await first.act({ key: snap.turn.options.some((o) => o.key === 'check') ? 'check' : 'fold' })).snapshot;
      else snap = (await first.step()).snapshot;
    }
    expect(RemoteDriver.saved({ storage })).toMatchObject({ mode: 'play', seats, hand: snap.hand, ageMs: expect.any(Number) });
    expect(storage.m.get('holdem:table')).not.toContain(KEY);
    // A reload: a new driver, the same browser.
    const second = make();
    const resumed = await second.resume();
    expect(resumed).toEqual(snap);
    const review = await second.review();
    expect(review.hands.length).toBe(snap.hand - 1);
    expect(review.hands.flatMap((h) => h.actions).some((x) => x.reasoning?.includes(SECRET_REASONING))).toBe(true);
    const last = await playOut(second, resumed);
    expect(last.over).toBe(true);
    expect(RemoteDriver.saved({ storage })).toBeNull();
    expect(verifyRecording((await second.review()).recording)).toMatchObject({ ok: true });
  });

  it('forgets a table the player left, one too old to resume, and one the server refuses', async () => {
    const storage = memoryStorage();
    let clock = 1_000;
    const s = await setup({ now: () => clock });
    const d = new RemoteDriver({ fetch, url: (route) => `${s.url}/api/table/${route}`, storage, now: () => clock });
    await d.start({ seats: [{ kind: 'human', id: 'you' }, { kind: 'model', id: DECISION }] });
    expect(RemoteDriver.saved({ storage, now: () => clock })).not.toBeNull();
    d.forget();
    expect(RemoteDriver.saved({ storage })).toBeNull();
    await expect(d.resume()).rejects.toMatchObject({ kind: 'refused' });
    await d.start({ seats: [{ kind: 'human', id: 'you' }, { kind: 'model', id: DECISION }] });
    expect(RemoteDriver.saved({ storage, now: () => clock + 7 * 3600_000 })).toBeNull();
    expect(storage.m.size).toBe(0);
    await d.start({ seats: [{ kind: 'human', id: 'you' }, { kind: 'model', id: DECISION }] });
    clock += 7 * 3600_000;
    await expect(new RemoteDriver({ fetch, url: (route) => `${s.url}/api/table/${route}`, storage }).resume()).rejects.toMatchObject({ kind: 'expired' });
    expect(storage.m.size).toBe(0);
    storage.setItem('holdem:table', '{"v":1,"token":5}');
    expect(RemoteDriver.saved({ storage })).toBeNull();
  });
});

describe('RemoteDriver: leaving the table', () => {
  it('keeps nothing once the player left, even from an answer that was still on its way, and cancels what is in flight', async () => {
    const s = await setup();
    const storage = memoryStorage();
    let hold: (() => void) | null = null;
    // A fetch that holds the step's answer until released, and ignores the signal (as a slow proxy might).
    const f = async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fetch(input, { ...init, signal: undefined });
      if (String(input).endsWith('/step')) await new Promise<void>((r) => (hold = r));
      return res;
    };
    const d = new RemoteDriver({ fetch: f, url: (route) => `${s.url}/api/table/${route}`, storage });
    await d.start({ seats: [{ kind: 'model', id: DECISION }, { kind: 'model', id: 'typesafe/jev-1.13.0' }] });
    expect(RemoteDriver.saved({ storage })).not.toBeNull();
    const pending = d.step().catch((e: unknown) => e);
    await vi.waitFor(() => expect(hold).not.toBeNull());
    d.forget();
    hold!();
    await pending;
    expect(RemoteDriver.saved({ storage })).toBeNull();
    expect(storage.m.size).toBe(0);
    // A fetch that honours the signal: the request in flight is cancelled at once.
    const d2 = new RemoteDriver({ fetch: (input, init) => new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))), url: (r) => r, storage });
    (d2 as unknown as { token: string }).token = 't';
    const cancelled = d2.act({ key: 'call' });
    d2.forget();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    // A new table afterwards is kept again.
    const d3 = new RemoteDriver({ fetch, url: (route) => `${s.url}/api/table/${route}`, storage });
    d3.forget();
    await d3.start({ seats: [{ kind: 'human', id: 'you' }, { kind: 'model', id: DECISION }] });
    expect(RemoteDriver.saved({ storage })).not.toBeNull();
  });
});
