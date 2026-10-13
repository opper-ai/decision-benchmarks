import { describe, expect, it } from 'vitest';
import { askPaused, RealtimeScheduler, type BaseDecision, type SchedulerEvent, type SchedulerGame } from '../client/scheduler';
import { parseChoice, type DecideResponse, type SystemOneRequest, type Transport } from '../shared/systemone';

/**
 * A toy game for the schedulers: a few walkers, each with turns coming up (key, options). The weather is what an
 * answer depends on besides its key, so a change of weather makes an answer stale.
 */
interface Turn {
  key: string;
  actor: string;
  options: string[];
  once?: boolean;
}
interface World {
  turns: Turn[];
  weather: 'sun' | 'rain';
}
interface Move extends BaseDecision {
  key: string;
  reason?: string;
}

const game: SchedulerGame<World, Turn, { point: Turn }, Move, { weather: string }> = {
  points: (w, actor) => w.turns.filter((t) => t.actor === actor),
  prepare: (_w, point) => ({ point }),
  name: (p) => (p.once ? `${p.actor}_once` : p.actor),
  build: (w, batch) => ({ state: { weather: w.weather }, questions: Object.fromEntries(batch.map((q) => [game.name(q.point), { type: 'choice', instructions: 'Which way?', criteria: Object.fromEntries(q.point.options.map((o) => [o, o])) }])) }),
  parse: (answer, q) => {
    const c = parseChoice(answer, q.point.options);
    return c ? { key: q.point.key, choice: c.choice, source: 'model' } : null;
  },
  fallback: (_w, q, reason) => ({ key: q.point.key, choice: q.point.options.at(-1)!, source: 'fallback', reason }),
  context: (w) => ({ weather: w.weather }),
  isStale: (ctx, w, p) => p.actor === 'walker' && ctx.weather !== w.weather,
  staleAtUse: (ctx, w) => (ctx.weather !== w.weather ? 'weather changed' : null),
  move: (d, p) => (p.once ? `${d.choice}!` : d.choice),
  answeredOnce: (p) => p.once === true,
};

interface Call {
  body: SystemOneRequest;
  resolve: (r: DecideResponse) => void;
  reject: (e: Error) => void;
}

function harness(opts: { maxInFlight?: number; timeoutFrom?: 'send' | 'queue'; modelFor?: (actor: string) => string | undefined; actors?: string[] } = {}) {
  const calls: Call[] = [];
  const events: SchedulerEvent<Move, { weather: string }>[] = [];
  const clock = { now: 0 };
  const transport: Transport = (body) => new Promise((resolve, reject) => calls.push({ body, resolve, reject }));
  const scheduler = new RealtimeScheduler(game, { transport, now: () => clock.now, onEvent: (e) => events.push(e), actors: opts.actors ?? ['walker', 'runner'], ...opts });
  return { calls, events, clock, scheduler };
}

const answer = (body: SystemOneRequest, pick = 0, extra: Partial<DecideResponse> = {}): DecideResponse => ({
  answers: Object.fromEntries(Object.entries(body.questions).map(([n, q]) => [n, { type: 'choice', choice: Object.keys(q.criteria)[pick], probabilities: {} }])),
  usage: { input_tokens: 10, output_tokens: 1 },
  latencyMs: 250,
  costUsd: 0.0001,
  traceId: 't',
  ...extra,
});
const flush = () => new Promise((r) => setTimeout(r, 0));
const world = (weather: 'sun' | 'rain' = 'sun'): World => ({ weather, turns: [{ key: 'w1', actor: 'walker', options: ['left', 'right'] }, { key: 'r1', actor: 'runner', options: ['up', 'down'] }] });

describe('RealtimeScheduler', () => {
  it('asks ahead about every open question in one request per model, with each question keyed for signing', () => {
    const { calls, scheduler } = harness({ modelFor: (a) => (a === 'runner' ? 'opper/kev-4b' : undefined) });
    scheduler.update(world());
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toMatchObject({ questions: { walker: {} }, keys: { walker: 'w1' } });
    expect(calls[0]!.body.model).toBeUndefined();
    expect(calls[1]!.body).toMatchObject({ model: 'opper/kev-4b', keys: { runner: 'r1' } });
    scheduler.update(world());
    expect(calls).toHaveLength(2); // nothing asked twice
  });

  it('hands an answer over once, with the model and its signature', async () => {
    const { calls, events, scheduler } = harness();
    const w = world();
    scheduler.update(w);
    calls[0]!.resolve(answer(calls[0]!.body, 0, { model: 'm', signatures: { walker: 'sig-w' }, signedAs: 'm' }));
    await flush();
    expect(scheduler.decide(w.turns[0]!, w)).toBe('left');
    expect(scheduler.lastDecision).toMatchObject({ choice: 'left', model: 'm', sig: 'sig-w', signedAs: 'm' });
    expect(scheduler.decide(w.turns[0]!, w)).toBeNull();
    expect(events.filter((e) => e.type === 'decision')).toHaveLength(2);
    expect(events.find((e) => e.type === 'call')).toMatchObject({ actors: ['walker', 'runner'], costUsd: 0.0001, costEstimated: false });
  });

  it('falls back when the model is too slow, and reports a late answer as stale', async () => {
    const { calls, events, clock, scheduler } = harness();
    const w = world();
    scheduler.update(w);
    clock.now = 2001;
    scheduler.update(w);
    expect(scheduler.decide(w.turns[0]!, w)).toBe('right');
    expect(scheduler.lastDecision).toMatchObject({ source: 'fallback', reason: 'timeout' });
    calls[0]!.resolve(answer(calls[0]!.body));
    await flush();
    expect(events.filter((e) => e.type === 'stale').map((e) => (e as { key: string }).key).sort()).toEqual(['r1', 'w1']);
  });

  it('times out from the queue for a player, so a question stuck behind a slow call still falls back in time', () => {
    for (const [from, falls] of [['send', false], ['queue', true]] as const) {
      const { clock, scheduler } = harness({ maxInFlight: 1, timeoutFrom: from, modelFor: (a) => a });
      const w = world();
      scheduler.update(w); // walker sent, runner queued behind it
      clock.now = 2500;
      scheduler.update(w);
      expect(scheduler.decide(w.turns[1]!, w) !== null).toBe(falls);
    }
  });

  it("drops an answer whose context changed and asks again (the game's isStale)", async () => {
    const { calls, events, scheduler } = harness({ actors: ['walker'] });
    const w = world();
    scheduler.update(w);
    calls[0]!.resolve(answer(calls[0]!.body));
    await flush();
    w.weather = 'rain';
    scheduler.update(w);
    expect(events.filter((e) => e.type === 'superseded')).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.state).toEqual({ weather: 'rain' });
  });

  it("replaces an answer with the fallback when the situation moved on by the time it is used (staleAtUse)", async () => {
    const { calls, events, scheduler } = harness({ actors: ['runner'] });
    const w = world();
    scheduler.update(w);
    calls[0]!.resolve(answer(calls[0]!.body));
    await flush();
    w.weather = 'rain'; // runners are not stale on update, only at use
    expect(scheduler.decide(w.turns[1]!, w)).toBe('down');
    expect(scheduler.lastDecision).toMatchObject({ source: 'fallback', reason: 'weather changed' });
    expect(events.at(-1)).toMatchObject({ type: 'decision', latencyMs: null, context: { weather: 'rain' } });
    expect(events.at(-2)).toMatchObject({ type: 'superseded' });
  });

  it('answers a question that stays open only once, and maps the move', async () => {
    const { calls, scheduler } = harness({ actors: ['walker'] });
    const w: World = { weather: 'sun', turns: [{ key: 'esc', actor: 'walker', options: ['on', 'back'], once: true }] };
    scheduler.update(w);
    calls[0]!.resolve(answer(calls[0]!.body, 1));
    await flush();
    expect(scheduler.decide(w.turns[0]!, w)).toBe('back!');
    scheduler.update(w);
    expect(calls).toHaveLength(1);
    w.turns = [];
    scheduler.update(w); // the question closed: it may be asked again later
    w.turns = [{ key: 'esc', actor: 'walker', options: ['on', 'back'], once: true }];
    scheduler.update(w);
    expect(calls).toHaveLength(2);
  });

  it("forgets what the old model said once an actor's model changes", async () => {
    let model = 'a';
    const { calls, scheduler } = harness({ actors: ['walker'], modelFor: () => model });
    const w = world();
    scheduler.update(w);
    calls[0]!.resolve(answer(calls[0]!.body));
    await flush();
    model = 'b';
    scheduler.update(w);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.model).toBe('b');
  });

  it('falls back on a failed call or an unusable answer', async () => {
    const { calls, events, scheduler } = harness();
    const w = world();
    scheduler.update(w);
    calls[0]!.resolve({ ...answer(calls[0]!.body), answers: { walker: { type: 'choice', choice: 'sideways' } } });
    await flush();
    expect(scheduler.decide(w.turns[0]!, w)).toBe('right');
    expect(scheduler.lastDecision).toMatchObject({ reason: 'invalid answer' });
    const second = harness();
    second.scheduler.update(w);
    second.calls[0]!.reject(new Error('HTTP 502'));
    await flush();
    expect(second.scheduler.decide(w.turns[1]!, w)).toBe('down');
    expect(second.events.find((e) => e.type === 'error')).toEqual({ type: 'error', message: 'HTTP 502' });
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('askPaused', () => {
  const opts = (transport: Transport, timeoutMs = 50) => ({ transport, now: () => 0, timeoutMs, model: 'opper/kev-4b' });

  it('waits for the answers and returns a decision per question', async () => {
    const events: SchedulerEvent<Move, { weather: string }>[] = [];
    let sent: SystemOneRequest | undefined;
    const w = world();
    const ds = await askPaused(game, w, w.turns, { ...opts(async (b) => ((sent = b), answer(b, 0, { signatures: { walker: 's' }, signedAs: 'opper/kev-4b' }))), onEvent: (e) => events.push(e) });
    expect(sent).toMatchObject({ model: 'opper/kev-4b', keys: { walker: 'w1', runner: 'r1' } });
    expect(ds.map((d) => d.choice)).toEqual(['left', 'up']);
    expect(ds[0]).toMatchObject({ source: 'model', sig: 's', signedAs: 'opper/kev-4b', model: 'opper/kev-4b' });
    expect(events.map((e) => e.type)).toEqual(['call', 'decision', 'decision']);
  });

  it("uses the game's fallback when the answer is late, and says so when it arrives", async () => {
    const events: SchedulerEvent<Move, { weather: string }>[] = [];
    const w = world();
    let resolve: (r: DecideResponse) => void = () => {};
    const ds = await askPaused(game, w, w.turns, { ...opts((b) => new Promise((r) => (resolve = () => r(answer(b)))), 20), onEvent: (e) => events.push(e) });
    expect(ds.map((d) => [d.choice, d.reason])).toEqual([
      ['right', 'timeout'],
      ['down', 'timeout'],
    ]);
    resolve(answer({ state: {}, questions: {} }));
    await flush();
    expect(events.filter((e) => e.type === 'stale')).toHaveLength(2);
  });

  it('falls back on an error, never rejecting', async () => {
    const w = world();
    const ds = await askPaused(game, w, [w.turns[0]!], opts(async () => Promise.reject(new Error('down'))));
    expect(ds).toEqual([{ key: 'w1', choice: 'right', source: 'fallback', reason: 'error' }]);
    expect(await askPaused(game, w, [], opts(async () => Promise.reject(new Error('unused'))))).toEqual([]);
  });
});
