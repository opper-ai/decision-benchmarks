// The leaderboard section: official runs (leaderboard.json) and self-reported ones (community.json) ranked together,
// with a Run by column and =1 ties, then the baselines (baselines.json) for reference, never ranked.
import type { CommunityEntry, Entry, Leaderboard } from '../../../packages/kit/shared/contract.ts';
import { modelName } from '../../../packages/kit/shared/models.ts';
import { rankLabels, sortBest } from '../../../packages/kit/shared/stats.ts';

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
}

const isBoard = (v: unknown): v is Leaderboard<Entry> => typeof v === 'object' && v !== null && Array.isArray((v as { entries?: unknown }).entries);

/** The ranked rows (official and self-reported, best first) and the baselines' rows. */
export function leaderboardRows(official: unknown, community: unknown, baselines: unknown): { ranked: Row[]; baselines: Row[] } {
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
  });
  const ranked = sorted.map((e, i) => row(e, labels[i]!));
  const base = isBoard(baselines) ? sortBest(baselines.entries, measure, true).map((e) => row({ ...e, kind: 'baseline', by: 'opper-ai' }, '')) : [];
  return { ranked, baselines: base };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

const fmt = (n: number, places = 1) => n.toFixed(places).replace(/\.0+$/, '');

/** Renders the table: ranked rows, an empty-state line while there are none, then the baselines. */
export function renderLeaderboard(table: HTMLTableElement, rows: { ranked: Row[]; baselines: Row[] }): void {
  const top = Math.max(1, ...rows.ranked.map((r) => r.mean), ...rows.baselines.map((r) => r.mean));
  const head = el('thead');
  const hr = el('tr');
  for (const [label, cls] of [['Rank', ''], ['Model', ''], ['Apples (mean ± margin)', ''], ['Best', 'r'], ['Games', 'r'], ['Fallbacks', 'r'], ['Latency', 'r'], ['Cost / game', 'r'], ['Run by', '']] as const) hr.append(el('th', label, cls || undefined));
  head.append(hr);
  const body = el('tbody');
  const line = (r: Row) => {
    const tr = el('tr', undefined, [r.tie ? 'tie' : '', r.kind === 'baseline' ? 'baseline' : ''].filter(Boolean).join(' ') || undefined);
    tr.append(el('td', r.rank || '-', 'rk'));
    const mdl = el('td', undefined, 'mdl');
    mdl.append(el('b', r.name));
    const note = r.kind === 'community' ? 'self-reported' : r.kind === 'baseline' ? 'baseline script' : r.via === 'chat-adapter' ? 'chat model via adapter' : r.model;
    mdl.append(el('small', note));
    tr.append(mdl);
    const sc = el('td');
    const w = el('div', undefined, 'scw');
    const bar = el('span', undefined, 'bar');
    const fill = el('i');
    fill.style.width = `${Math.max(2, (100 * r.mean) / top)}%`;
    bar.append(fill);
    const num = el('span', undefined, 'n');
    num.append(fmt(r.mean), el('span', ` ±${fmt(r.margin)}`, 'pm'));
    w.append(bar, num);
    sc.append(w);
    tr.append(sc);
    tr.append(el('td', String(r.best), 'r n'));
    tr.append(el('td', String(r.games), 'r n'));
    tr.append(el('td', `${fmt(100 * r.fallbackRate)}%`, 'r n'));
    tr.append(el('td', r.kind === 'baseline' || r.latencyMs === null ? '-' : `${r.latencyMs} ms`, 'r n'));
    tr.append(el('td', r.costPerGame === null ? '-' : `$${r.costPerGame.toFixed(4)}`, 'r n'));
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
    const td = el('td', 'No models ranked yet: our runs of every decision model Opper serves come next. Benchmark your own model below.');
    td.colSpan = 9;
    tr.append(td);
    body.append(tr);
  }
  if (rows.baselines.length) {
    const g = el('tr', undefined, 'group');
    const td = el('td', 'Baselines: simple scripts for reference, not ranked');
    td.colSpan = 9;
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
