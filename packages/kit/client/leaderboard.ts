// A game page's Leaderboard section, shared by every game: official runs (leaderboard.json) and self-reported ones
// (community.json) ranked together, with a Run by column and =1 ties, then the baselines (baselines.json) for
// reference, never ranked. The look is in page.css (.tablecard, .lbt). A game names its metric's column, how to show
// its numbers and any columns of its own (from each entry's `extra`).
import type { CommunityEntry, Entry, Leaderboard } from '../shared/contract.ts';
import { modelName } from '../shared/models.ts';
import { rankLabels, sortBest } from '../shared/stats.ts';

export interface Row {
  rank: string;
  name: string;
  model: string;
  mean: number;
  margin: number;
  best: number;
  games: number;
  fallbackRate: number;
  latencyMs: number | null;
  costPerGame: number | null;
  /** The GitHub handle that ran it: opper-ai for official runs. */
  by: string;
  url?: string;
  kind: 'official' | 'community' | 'baseline';
  tie: boolean;
  via: Entry['via'];
  extra?: Entry['extra'];
}

export interface Rows {
  ranked: Row[];
  baselines: Row[];
}

/** A game's own column, read from each entry's `extra`. */
export interface ExtraColumn {
  label: string;
  key: string;
  format?: (v: number | string) => string;
}

/** How a game shows its table. Every field has the default Snake uses. */
export interface TableOptions {
  /** The metric's column heading. */
  metric?: string;
  /** A mean or a margin as text. */
  format?: (n: number) => string;
  /** The value the bars fill to: by default the largest mean shown. */
  scaleMax?: number;
  /** Whether to show each row's best game (Snake: the most apples). */
  best?: boolean;
  extra?: readonly ExtraColumn[];
  /** The line while no model is ranked. */
  empty?: string;
}

const isBoard = (v: unknown): v is Leaderboard<Entry> => typeof v === 'object' && v !== null && Array.isArray((v as { entries?: unknown }).entries);

/** The ranked rows (official and self-reported, best first) and the baselines' rows. */
export function leaderboardRows(official: unknown, community: unknown, baselines: unknown): Rows {
  const entries: (Entry & { kind: Row['kind']; by: string; url?: string })[] = [
    ...(isBoard(official) ? official.entries.map((e) => ({ ...e, kind: 'official' as const, by: 'opper-ai' })) : []),
    ...(isBoard(community) ? (community.entries as CommunityEntry[]).map((e) => ({ ...e, kind: 'community' as const })) : []),
  ];
  const measure = (e: Entry) => e.metric;
  const sorted = sortBest(entries, measure, true);
  const labels = rankLabels(sorted, measure);
  const row = (e: Entry & { kind: Row['kind']; by: string; url?: string }, rank: string): Row => ({
    rank,
    name: e.kind === 'official' ? modelName(e.model) : e.name,
    model: e.model,
    mean: e.metric.mean,
    margin: 2 * e.metric.stdError,
    best: e.metric.best,
    games: e.games,
    fallbackRate: e.fallbackRate,
    latencyMs: e.meanLatencyMs,
    costPerGame: e.costPerGame,
    by: e.by,
    ...(e.url ? { url: e.url } : {}),
    kind: e.kind,
    tie: rank === '=1',
    via: e.via,
    ...(e.extra ? { extra: e.extra } : {}),
  });
  const ranked = sorted.map((e, i) => row(e, labels[i]!));
  const base = isBoard(baselines) ? sortBest(baselines.entries, measure, true).map((e) => row({ ...e, kind: 'baseline', by: 'opper-ai' }, '')) : [];
  return { ranked, baselines: base };
}

/** A number with up to `places` decimals, trailing zeros dropped: 48.90 -> 48.9, 100.0 -> 100. */
export const fmt = (n: number, places = 1) => n.toFixed(places).replace(/\.0+$/, '');

const DEFAULTS = {
  metric: 'Score (mean ± margin)',
  format: (n: number) => fmt(n),
  best: true,
  empty: 'No models ranked yet: our runs of every decision model Opper serves come next. Benchmark your own model below.',
};

/** The headings, each with its class ('r' right-aligns a number column). */
export function tableHeadings(o: TableOptions = {}): [string, string][] {
  return [
    ['Rank', ''],
    ['Model', ''],
    [o.metric ?? DEFAULTS.metric, ''],
    ...((o.best ?? DEFAULTS.best) ? [['Best', 'r'] as [string, string]] : []),
    ...(o.extra ?? []).map((c): [string, string] => [c.label, 'r']),
    ['Games', 'r'],
    ['Fallbacks', 'r'],
    ['Latency', 'r'],
    ['Cost / game', 'r'],
    ['Run by', ''],
  ];
}

/** The text of a row's number columns, between the metric and Run by, in the headings' order. */
export function numberCells(r: Row, o: TableOptions = {}): string[] {
  const format = o.format ?? DEFAULTS.format;
  return [
    ...((o.best ?? DEFAULTS.best) ? [format(r.best)] : []),
    ...(o.extra ?? []).map((c) => {
      const v = r.extra?.[c.key];
      return v === undefined ? '-' : c.format ? c.format(v) : String(v);
    }),
    String(r.games),
    `${fmt(100 * r.fallbackRate)}%`,
    r.kind === 'baseline' || r.latencyMs === null ? '-' : `${r.latencyMs} ms`,
    r.costPerGame === null ? '-' : `$${r.costPerGame.toFixed(4)}`,
  ];
}

/** What the row's model line says under its name. */
export function modelNote(r: Row): string {
  return r.kind === 'community' ? 'self-reported' : r.kind === 'baseline' ? 'baseline script' : r.via === 'chat-adapter' ? 'chat model via adapter' : r.model;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

/** Renders the table: ranked rows, an empty-state line while there are none, then the baselines. */
export function renderLeaderboard(table: HTMLTableElement, rows: Rows, o: TableOptions = {}): void {
  const format = o.format ?? DEFAULTS.format;
  const headings = tableHeadings(o);
  const top = o.scaleMax ?? Math.max(1, ...rows.ranked.map((r) => r.mean), ...rows.baselines.map((r) => r.mean));
  const head = el('thead');
  const hr = el('tr');
  for (const [label, cls] of headings) hr.append(el('th', label, cls || undefined));
  head.append(hr);
  const body = el('tbody');
  const line = (r: Row) => {
    const tr = el('tr', undefined, [r.tie ? 'tie' : '', r.kind === 'baseline' ? 'baseline' : ''].filter(Boolean).join(' ') || undefined);
    tr.append(el('td', r.rank || '-', 'rk'));
    const mdl = el('td', undefined, 'mdl');
    mdl.append(el('b', r.name));
    mdl.append(el('small', modelNote(r)));
    tr.append(mdl);
    const sc = el('td');
    const w = el('div', undefined, 'scw');
    const bar = el('span', undefined, 'bar');
    const fill = el('i');
    fill.style.width = `${Math.max(2, Math.min(100, (100 * r.mean) / top))}%`;
    bar.append(fill);
    const num = el('span', undefined, 'n');
    num.append(format(r.mean), el('span', ` ±${format(r.margin)}`, 'pm'));
    w.append(bar, num);
    sc.append(w);
    tr.append(sc);
    for (const text of numberCells(r, o)) tr.append(el('td', text, 'r n'));
    const run = el('td', undefined, 'run');
    const a = el('a', `@${r.by}`);
    a.href = `https://github.com/${encodeURIComponent(r.by)}`;
    a.target = '_blank';
    a.rel = 'noopener';
    run.append(a);
    tr.append(run);
    return tr;
  };
  if (rows.ranked.length) for (const r of rows.ranked) body.append(line(r));
  else {
    const tr = el('tr', undefined, 'empty');
    const td = el('td', o.empty ?? DEFAULTS.empty);
    td.colSpan = headings.length;
    tr.append(td);
    body.append(tr);
  }
  if (rows.baselines.length) {
    const g = el('tr', undefined, 'group');
    const td = el('td', 'Baselines: simple scripts for reference, not ranked');
    td.colSpan = headings.length;
    g.append(td);
    body.append(g);
    for (const r of rows.baselines) body.append(line(r));
  }
  table.replaceChildren(head, body);
}

/** GET a results file below the game's path, or null (missing, as community.json is before any submission). */
export async function fetchJson(url: string): Promise<unknown> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Fetches the game's three results files and renders its table. */
export async function loadLeaderboard(table: HTMLTableElement, path: (p: string) => string, o: TableOptions = {}): Promise<void> {
  const [official, community, baselines] = await Promise.all([fetchJson(path('/leaderboard.json')), fetchJson(path('/community.json')), fetchJson(path('/baselines.json'))]);
  renderLeaderboard(table, leaderboardRows(official, community, baselines), o);
}
