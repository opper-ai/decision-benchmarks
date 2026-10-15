// Records a curated replay for the Replays list (public/demo/), gzipped: one AI-only Sit & Go (watch mode) played
// through the service's own table (server/table.ts), in process. The script stands in for the HTTP layer only: it
// builds the kit's GameApiCall as the service does (the table sealed and opened with AES-256-GCM, the dev key as the
// payer) and plays start, step, next and review as the page's RemoteDriver does, so the models are asked with the
// same prompts, time banks (2.5 s decision, 20 s chat) and fallbacks as at a live table. The talk, moods, tells,
// reasoning, latencies and costs the stateless server hands back with each answer are laid over the review's recording
// (as RemoteDriver.review does), which is verified (verifyRecording) before it is written.
//
//   OPPER_API_KEY=... OPPER_PROJECT=... node games/holdem/scripts/record-demo.ts \
//     --seats aws/claude-opus-5-5,vertexai/claude-sonnet-5-5-eu,azure:eu/gpt-6.1-sol,azure/gpt-5.6-terra \
//     --file claude-vs-gpt.json.gz --title "Claude vs GPT" [--blurb "{winner} wins in {hands} hands. {moment}"] \
//     [--max-usd 2] [--log <file>]
//
//   node games/holdem/scripts/record-demo.ts --from <file> [--title ...] [--blurb ...]
//       rewrites an existing replay's entry in index.json (title, blurb, hands) without playing again
//
// The blurb's {winner}, {hands} and {moment} are filled in from the game: {moment} is the best moment exactly as the
// replay's end screen says it (highlights.ts momentOf over the hands the ReplayDriver plays back), as "In hand 23, ...". --max-usd stops the
// game, writing nothing, once the reported cost passes it. Costs what the model calls cost; the total is printed.
import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { systemOneTransport } from '../../../packages/kit/bench/transports.ts';
import { warmUp } from '../../../packages/kit/bench/warm.ts';
import { purposeKey, seal, unseal } from '../../../packages/kit/server/session.ts';
import { devTargetFromEnv } from '../../../packages/kit/server/systemone.ts';
import type { ApiPayer, GameApiCall, GameApiResponse } from '../../../packages/kit/shared/game.ts';
import { DECISION_TIMEOUT_MS, holdemModel } from '../shared/models.ts';
import { FALLBACK_REASONS, verifyRecording, type RecordedAction, type Recording } from '../shared/recording.ts';
import type { ActionMeta, Review, ReviewHand, SnapshotReply, StepReply, TableSnapshot } from '../shared/table.ts';
import { tableApi } from '../server/table.ts';
import { momentOf, potText, type Moment } from '../src/highlights.ts';
import { ReplayDriver } from '../src/replay-driver.ts';
import { personOf } from '../src/view-model.ts';
// Type only: watch-list.ts itself draws (the page's paths), which Node can't load.
import type { DemoEntry } from '../src/views/watch-list.ts';

const DEMO_DIR = new URL('../public/demo/', import.meta.url);
const INDEX = new URL('index.json', DEMO_DIR);
const DEFAULT_BLURB = '{winner} wins in {hands} hands. {moment}';

const { values } = parseArgs({
  options: {
    seats: { type: 'string' },
    file: { type: 'string' },
    title: { type: 'string' },
    blurb: { type: 'string' },
    'max-usd': { type: 'string' },
    log: { type: 'string' },
    from: { type: 'string' },
  },
});
const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const nameOf = (id: string) => personOf(id.includes('/') ? { kind: 'model', id } : { kind: 'bot', id }).name;

/** The finished game as the replay shows it: its hands played back, and the best moment its end screen names. */
async function playBack(rec: Recording): Promise<{ review: Review; moment: Moment | null; winner: string }> {
  const d = new ReplayDriver(rec);
  await d.jumpTo(d.hands);
  while (d.snapshot().view.toAct !== null) await d.step();
  const review = await d.review();
  const name = (seat: number) => personOf(review.players[seat]!).name;
  return { review, moment: momentOf(review.hands, review.players, name), winner: name(rec.result.places!.indexOf(1)) };
}

const readIndex = (): DemoEntry[] => (JSON.parse(readFileSync(INDEX, 'utf8')) as { replays: DemoEntry[] }).replays;

/** Adds or replaces the file's entry in index.json, keeping the others and their order. */
function writeEntry(entry: DemoEntry): void {
  const kept = readIndex();
  const i = kept.findIndex((e) => e.file === entry.file);
  if (i >= 0) kept[i] = entry;
  else kept.push(entry);
  writeFileSync(INDEX, `${JSON.stringify({ format: 1, replays: kept }, null, 2)}\n`);
}

const blurbOf = (template: string, winner: string, hands: number, moment: Moment | null) =>
  template
    .replaceAll('{winner}', winner)
    .replaceAll('{hands}', String(hands))
    .replaceAll('{moment}', moment?.text.replace(/^Hand (\d+)\. /, 'In hand $1, ') ?? '')
    .trim();

/** Writes the replay's entry for a recording and says what the entry says. */
async function index(file: string, rec: Recording, title: string, template: string, recordedAt: string): Promise<void> {
  const { moment, winner } = await playBack(rec);
  const blurb = blurbOf(template, winner, rec.hands.length, moment);
  if (title.length > 80) die(`the title is ${title.length} characters, at most 80`);
  if (blurb.length > 300) die(`the blurb is ${blurb.length} characters, at most 300: ${blurb}`);
  writeEntry({ file, title, blurb, players: rec.players.map((p) => p.id), hands: rec.hands.length, recordedAt });
  console.log(`index.json: ${file}\n  title: ${title}\n  blurb: ${blurb}`);
  if (moment) console.log(`  best moment: ${moment.title} (hand ${moment.highlight.hand}, ${potText(moment.highlight)}, score ${moment.highlight.score})`);
}

if (values.from) {
  const file = values.from.replace(/^.*\//, '');
  const rec = JSON.parse(gunzipSync(readFileSync(new URL(file, DEMO_DIR))).toString('utf8')) as Recording;
  const verdict = verifyRecording(rec);
  if (!verdict.ok) die(`${file} does not verify: ${verdict.error}`);
  const old = readIndex().find((e) => e.file === file);
  await index(file, rec, values.title ?? old?.title ?? die('--title is required for a new entry'), values.blurb ?? DEFAULT_BLURB, old?.recordedAt ?? new Date().toISOString().slice(0, 10));
  process.exit(0);
}

// ---------- recording a game ----------

const seats = (values.seats ?? die('--seats <id,id,...> is required')).split(',').map((s) => s.trim());
const file = values.file ?? die('--file <name>.json.gz is required');
if (!/^[a-z0-9][a-z0-9-]{0,80}\.json\.gz$/.test(file)) die('--file is letters, digits and dashes, ending .json.gz');
const title = values.title ?? die('--title is required');
const maxUsd = values['max-usd'] === undefined ? Infinity : Number(values['max-usd']);
if (!(maxUsd > 0)) die('--max-usd must be a positive number of dollars');
for (const id of seats) if (!holdemModel(id)) die(`AI Hold'em does not seat ${id}`);
// Opper only: the chat models play through Opper (a TypeSafe key would be refused for them).
const target = devTargetFromEnv({ OPPER_API_KEY: process.env.OPPER_API_KEY, OPPER_PROJECT: process.env.OPPER_PROJECT, OPPER_BASE_URL: process.env.OPPER_BASE_URL }) ?? die('set OPPER_API_KEY (and OPPER_PROJECT for an organization key)');
const logFile = values.log;
const log = (line: string) => {
  if (logFile) appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  if (/fallback|failed|timed out|refus/i.test(line)) console.log(`  ${line}`);
};

// Opper scales idle decision models down: wake them as the page does before a table starts.
for (const id of new Set(seats.filter((id) => holdemModel(id)!.kind === 'decision'))) {
  const problem = await warmUp(systemOneTransport(id, target, DECISION_TIMEOUT_MS, 'decision-benchmarks-holdem-warm'), { fastMs: DECISION_TIMEOUT_MS * 0.9, log: (l) => console.log(`${id}${l}`) });
  if (problem) die(`${id}: ${problem}`);
}

// The kit's GameApiCall as the service builds it for a request (packages/kit/server/routes.ts), with the dev key.
const tableKey = purposeKey(randomBytes(32).toString('hex'), 'holdem-table');
const payer: ApiPayer = { mode: 'dev', provider: 'opper', apiKey: target.apiKey, baseUrl: target.baseUrl, ...(target.project ? { project: target.project } : {}) };
const stop = new AbortController();
const api = tableApi();
async function post<T>(route: string, body: unknown): Promise<T> {
  const call: GameApiCall = {
    body: JSON.parse(JSON.stringify(body)) as unknown,
    visitor: '127.0.0.1',
    payer: () => payer,
    unpaid: () => ({ status: 401, body: { error: 'no key' } }),
    takePool: () => null,
    poolSpent: () => {},
    seal: (purpose, value) => seal(value, purpose === 'table' ? tableKey : die(`unexpected purpose ${purpose}`)),
    open: (purpose, token) => unseal(token, purpose === 'table' ? tableKey : die(`unexpected purpose ${purpose}`)),
    fetch,
    log,
    signal: stop.signal,
  };
  const r: GameApiResponse = await api.routes[`/api/table/${route}`]!(call);
  // Through JSON, as the page gets it.
  const out = JSON.parse(JSON.stringify(r.body)) as T & { error?: string };
  if (r.status !== 200) die(`api/table/${route} answered ${r.status}: ${out.error ?? ''}`);
  return out;
}

// The page's watch loop (main.ts) over the RemoteDriver's memory of each finished hand (remote-driver.ts).
const finished = new Map<number, ReviewHand>();
let metas: ActionMeta[] = [];
const recordedMeta = (m: ActionMeta): Partial<RecordedAction> => ({
  ...(m.say !== undefined ? { say: m.say } : {}),
  ...(m.mood ? { mood: m.mood } : {}),
  ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
  ...(m.probabilities ? { probabilities: m.probabilities } : {}),
});
const keep = (hand: ReviewHand | undefined) => {
  if (!hand) return;
  finished.set(hand.hand, { ...hand, actions: hand.actions.map((x, i) => ({ ...recordedMeta(metas[i] ?? { by: x.by, latencyMs: 0 }), ...x })) });
};

const started = Date.now();
let cost = 0;
let unpriced = 0;
let r0 = await post<SnapshotReply>('start', { mode: 'watch', seats: seats.map((id) => ({ kind: 'model', id })) });
let token = r0.token;
let snap: TableSnapshot = r0.snapshot;
keep(r0.finished);
console.log(`table: ${seats.map(nameOf).join(', ')}; cap $${maxUsd}`);
while (true) {
  if (snap.view.street === 'done') {
    const stacks = snap.view.players.map((p) => p.stack);
    console.log(`hand ${snap.hand} done: ${stacks.join(' / ')}; $${cost.toFixed(4)} so far, ${Math.round((Date.now() - started) / 1000)} s`);
    if (snap.over) break;
    const r = await post<SnapshotReply>('next', { token });
    token = r.token;
    snap = r.snapshot;
    metas = [];
    keep(r.finished);
    continue;
  }
  const r = await post<StepReply>('step', { token });
  token = r.token;
  metas.push(r.result.meta);
  keep(r.finished);
  snap = r.result.snapshot;
  if (r.result.meta.costUsd !== undefined) cost += r.result.meta.costUsd;
  else if (r.result.meta.by === 'answer' || r.result.meta.why !== undefined) unpriced++;
  if (cost > maxUsd) {
    stop.abort();
    die(`stopped at hand ${snap.hand}: $${cost.toFixed(4)} is past the cap of $${maxUsd}; nothing written`);
  }
}

// The review's recording (with its key), the remembered metadata laid over it as RemoteDriver.review does.
const review = await post<Review>('review', { token });
if (!review.recording) die('the game is over but the review has no recording');
const rec: Recording = {
  ...review.recording!,
  hands: review.recording!.hands.map((h, i) => {
    const known = finished.get(i + 1)?.actions;
    return known && known.length === h.actions.length ? { ...h, actions: h.actions.map((x, k) => ({ ...known[k], ...x })) } : h;
  }),
};
const verdict = verifyRecording(rec);
if (!verdict.ok) die(`the recording does not verify: ${verdict.error}`);

const bytes = gzipSync(JSON.stringify(rec), { level: 9 });
writeFileSync(new URL(file, DEMO_DIR), bytes);
await index(file, rec, title, values.blurb ?? DEFAULT_BLURB, new Date().toISOString().slice(0, 10));

// What the game was like, per seat.
const all = rec.hands.flatMap((h) => h.actions);
console.log(`\n${rec.hands.length} hands in ${Math.round((Date.now() - started) / 1000)} s; places ${JSON.stringify(rec.result.places)}`);
rec.players.forEach((p, seat) => {
  const mine = all.filter((x) => x.seat === seat);
  const fb = mine.filter((x) => x.by === 'fallback');
  const why = FALLBACK_REASONS.map((w) => [w, fb.filter((x) => x.why === w).length] as const).filter(([, n]) => n);
  const usd = mine.reduce((a, x) => a + (x.costUsd ?? 0), 0);
  const ms = mine.filter((x) => x.latencyMs !== undefined).map((x) => x.latencyMs!);
  const keys = Object.entries(mine.reduce<Record<string, number>>((a, x) => ((a[x.key ?? 'raise'] = (a[x.key ?? 'raise'] ?? 0) + 1), a), {}))
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
  console.log(
    `  ${nameOf(p.id)} (place ${rec.result.places![seat]}): ${mine.length} decisions, ${fb.length} fallbacks${why.length ? ` (${why.map(([w, n]) => `${w} ${n}`).join(', ')})` : ''}, ` +
      `$${usd.toFixed(4)}, mean ${ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0} ms, ${mine.filter((x) => x.say).length} said something, ${mine.filter((x) => x.reasoning).length} reasoned; ${keys}`,
  );
});
const fallbacks = all.filter((x) => x.by === 'fallback');
console.log(`total: ${all.length} decisions, ${fallbacks.length} fallbacks (${FALLBACK_REASONS.map((w) => `${w} ${fallbacks.filter((x) => x.why === w).length}`).join(', ')}), cost $${cost.toFixed(4)}${unpriced ? ` (+${unpriced} calls without a reported cost)` : ''}`);
console.log(`wrote ${file}: ${bytes.length} bytes gzipped (${JSON.stringify(rec).length} bytes of JSON), fingerprint ${verdict.ok ? verdict.fingerprint : ''}`);
