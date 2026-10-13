/**
 * The files every game serves below https://opper.ai/decision-benchmarks/<slug>/ for the hub (opper-website), as
 * agreed in docs/design.md: game.json, leaderboard.json, community.json, /api/highscores and poster.png. The hub only
 * reads these and renders them as text, so their shape is the whole contract. `npm run check-contract` validates
 * every game's files with the functions below, and CI runs it.
 */

export const CATEGORIES = ['Arcade', 'Puzzle', 'Fighting', 'Strategy'] as const;
export type Category = (typeof CATEGORIES)[number];

/** How a game measures a run: e.g. { name: 'Apples', unit: 'apples', higherIsBetter: true }. */
export interface Metric {
  name: string;
  unit: string;
  higherIsBetter: boolean;
}

/** game.json */
export interface GameInfo {
  slug: string;
  name: string;
  tagline: string;
  category: Category;
  /** Our own games: github "opper-ai" and no originalRepo. */
  author: { github: string; originalRepo?: string };
  license: string;
  metric: Metric;
  /** Set at build time from the newest results file (ISO date). */
  updatedAt: string;
}

/** One model's row. `model` is the Opper id the run called (or, self-reported, the submission's own id). */
export interface Entry {
  model: string;
  name: string;
  games: number;
  metric: { mean: number; stdError: number; best: number };
  meanLatencyMs: number | null;
  /** Share of decisions the game's fallback made because the model did not answer in time (or at all). */
  fallbackRate: number;
  costPerGame: number | null;
  /** How the model was called: the System One API, or a chat model through the bench's chat adapter. */
  via: 'systemone' | 'chat-adapter';
  /** Game-specific numbers for the game's own page. */
  extra?: Record<string, number | string>;
}

/** A row its submitter ran and sent by pull request: replayed by CI, but moves, latency and cost are as reported. */
export interface CommunityEntry extends Entry {
  /** The submitter's GitHub handle. */
  by: string;
  url?: string;
  selfReported: true;
}

/** leaderboard.json (official runs) and, with CommunityEntry rows, community.json. Entries best first. */
export interface Leaderboard<E extends Entry = Entry> {
  generatedAt: string;
  game: string;
  benchVersion: number;
  metric: Metric;
  entries: E[];
  /** Models that could not play (not warm in time, not enabled for the key), or submissions left out. */
  skipped: { model: string; reason: string }[];
}
export type Community = Leaderboard<CommunityEntry>;

/** One line on a player high-score board. */
export interface HighScoreLine {
  initials: string;
  score: number;
  at: string;
}

/** GET <game>/api/highscores: the boards in the order the game shows them (the hub shows the first board's top). */
export interface HighScoresView {
  order: string[];
  boards: Record<string, HighScoreLine[]>;
}

/** poster.png: 16:9, at most this many bytes. */
export const MAX_POSTER_BYTES = 150 * 1024;

// ---------- validators: each returns a list of problems, empty when the value is valid ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 200) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const isoDate = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function metricProblems(m: unknown, where: string): string[] {
  if (!isObj(m)) return [`${where} must be an object`];
  const out: string[] = [];
  if (!text(m.name, 60)) out.push(`${where}.name must be text`);
  if (!text(m.unit, 40)) out.push(`${where}.unit must be text`);
  if (typeof m.higherIsBetter !== 'boolean') out.push(`${where}.higherIsBetter must be true or false`);
  return out;
}

export function validateGameInfo(v: unknown, slug?: string): string[] {
  if (!isObj(v)) return ['game.json must be an object'];
  const out: string[] = [];
  if (!(typeof v.slug === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(v.slug))) out.push('slug must be lowercase letters, digits and dashes');
  else if (slug !== undefined && v.slug !== slug) out.push(`slug is ${v.slug}, the folder is ${slug}`);
  if (!text(v.name, 60)) out.push('name must be text');
  if (!text(v.tagline, 160)) out.push('tagline must be text of at most 160 characters');
  if (!CATEGORIES.includes(v.category as Category)) out.push(`category must be one of ${CATEGORIES.join(', ')}`);
  if (!isObj(v.author) || !(typeof v.author.github === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(v.author.github))) out.push('author.github must be a GitHub handle');
  else if (v.author.originalRepo !== undefined && !(typeof v.author.originalRepo === 'string' && /^https:\/\/\S+$/.test(v.author.originalRepo))) out.push('author.originalRepo must be an https URL');
  if (!text(v.license, 40)) out.push('license must be text');
  out.push(...metricProblems(v.metric, 'metric'));
  if (!isoDate(v.updatedAt)) out.push('updatedAt must be a date');
  return out;
}

function entryProblems(e: unknown, where: string, community: boolean): string[] {
  if (!isObj(e)) return [`${where} must be an object`];
  const out: string[] = [];
  if (!text(e.model, 120)) out.push(`${where}.model must be text`);
  if (!text(e.name, 60)) out.push(`${where}.name must be text`);
  if (!(Number.isInteger(e.games) && (e.games as number) > 0)) out.push(`${where}.games must be a positive whole number`);
  if (!isObj(e.metric) || !num(e.metric.mean) || !num(e.metric.stdError) || (e.metric.stdError as number) < 0 || !num(e.metric.best)) out.push(`${where}.metric must hold mean, stdError (at least 0) and best`);
  if (!(e.meanLatencyMs === null || (num(e.meanLatencyMs) && (e.meanLatencyMs as number) >= 0))) out.push(`${where}.meanLatencyMs must be a number or null`);
  if (!(num(e.fallbackRate) && (e.fallbackRate as number) >= 0 && (e.fallbackRate as number) <= 1)) out.push(`${where}.fallbackRate must be between 0 and 1`);
  if (!(e.costPerGame === null || (num(e.costPerGame) && (e.costPerGame as number) >= 0))) out.push(`${where}.costPerGame must be a number or null`);
  if (e.via !== 'systemone' && e.via !== 'chat-adapter') out.push(`${where}.via must be systemone or chat-adapter`);
  if (e.extra !== undefined && !(isObj(e.extra) && Object.values(e.extra).every((x) => num(x) || typeof x === 'string'))) out.push(`${where}.extra must map names to numbers or text`);
  if (community) {
    if (!(typeof e.by === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(e.by))) out.push(`${where}.by must be a GitHub handle`);
    if (e.url !== undefined && !(typeof e.url === 'string' && /^https:\/\/\S+$/.test(e.url))) out.push(`${where}.url must be an https URL`);
    if (e.selfReported !== true) out.push(`${where}.selfReported must be true`);
  }
  return out;
}

function boardProblems(v: unknown, file: string, community: boolean, slug?: string): string[] {
  if (!isObj(v)) return [`${file} must be an object`];
  const out: string[] = [];
  if (!isoDate(v.generatedAt)) out.push(`${file}: generatedAt must be a date`);
  if (!text(v.game, 60)) out.push(`${file}: game must be the game's slug`);
  else if (slug !== undefined && v.game !== slug) out.push(`${file}: game is ${String(v.game)}, expected ${slug}`);
  if (!(Number.isInteger(v.benchVersion) && (v.benchVersion as number) >= 1)) out.push(`${file}: benchVersion must be a whole number of at least 1`);
  out.push(...metricProblems(v.metric, `${file}: metric`));
  if (!Array.isArray(v.entries)) out.push(`${file}: entries must be a list`);
  else {
    v.entries.forEach((e, i) => out.push(...entryProblems(e, `${file}: entries[${i}]`, community)));
    const higher = isObj(v.metric) ? v.metric.higherIsBetter !== false : true;
    const means = v.entries.map((e) => (isObj(e) && isObj(e.metric) && num(e.metric.mean) ? (e.metric.mean as number) : NaN));
    if (means.some((m, i) => i > 0 && (higher ? m > means[i - 1]! : m < means[i - 1]!))) out.push(`${file}: entries must be best first`);
  }
  if (!Array.isArray(v.skipped) || !v.skipped.every((s) => isObj(s) && typeof s.model === 'string' && typeof s.reason === 'string')) out.push(`${file}: skipped must list { model, reason }`);
  return out;
}

export const validateLeaderboard = (v: unknown, slug?: string): string[] => boardProblems(v, 'leaderboard.json', false, slug);
export const validateCommunity = (v: unknown, slug?: string): string[] => boardProblems(v, 'community.json', true, slug);

export function validateHighScores(v: unknown): string[] {
  if (!isObj(v)) return ['highscores must be an object'];
  const out: string[] = [];
  if (!Array.isArray(v.order) || !v.order.every((b) => typeof b === 'string')) out.push('order must list board ids');
  if (!isObj(v.boards)) return [...out, 'boards must be an object'];
  for (const id of Array.isArray(v.order) ? v.order : []) {
    const list = v.boards[id as string];
    if (!Array.isArray(list)) out.push(`boards.${String(id)} must be a list`);
    else if (!list.every((l) => isObj(l) && typeof l.initials === 'string' && num(l.score) && isoDate(l.at))) out.push(`boards.${String(id)} must list { initials, score, at }`);
  }
  return out;
}

/** A PNG's width and height from its header, or null if it is not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !sig.every((b, i) => bytes[i] === b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function validatePoster(bytes: Uint8Array): string[] {
  const out: string[] = [];
  if (bytes.length > MAX_POSTER_BYTES) out.push(`poster.png is ${Math.ceil(bytes.length / 1024)} KB, at most ${MAX_POSTER_BYTES / 1024} KB`);
  const size = pngSize(bytes);
  if (!size) return [...out, 'poster.png is not a PNG'];
  // 16:9 within a pixel of rounding.
  if (Math.abs(size.width * 9 - size.height * 16) > 16) out.push(`poster.png is ${size.width}x${size.height}, not 16:9`);
  return out;
}
