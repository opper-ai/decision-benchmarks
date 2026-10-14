// A game page's Leaderboard section, shared by every game and drawn as jevman draws its own: official runs
// (leaderboard.json) and self-reported ones (community.json) ranked together, with =1 ties, each model with its
// maker's mark and name. Phones get the same rows as a list, a row opening its numbers. The look is in page.css
// (.tablecard, .lbt, .lbl). A game names its metric's column, how to show its numbers and any columns of its own (from
// each entry's `extra`). Its baselines (baselines.json, scripts that use no model) stay off the page unless it asks for
// them: then they sit in the table at their score for reference, marked Base where the rank would be, never ranked.
import type { CommunityEntry, Entry, Leaderboard } from '../shared/contract.ts';
import { modelMaker, modelName } from '../shared/models.ts';
import { rankLabels, sortBest } from '../shared/stats.ts';
import { logoFor, pageOf } from './logos.ts';
import { tag } from './track.ts';

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
  /** The fallback share's heading (a real-time game: the steps the model was too late for). */
  fallbacks?: string;
  /** The mean latency's heading. */
  latency?: string;
  /** The line while no model is ranked. */
  empty?: string;
  /** Whether the baselines show among the models as reference rows. Off: a script's score says little to a visitor. */
  baselines?: boolean;
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

/**
 * The table's order: every row by its mean, best first, the baselines among the models at their score (a model
 * before a baseline on an equal mean). The ranks stay the models' own: a baseline between two takes no place.
 */
export function tableOrder(rows: Rows): Row[] {
  const all = [...rows.ranked, ...rows.baselines];
  return all.map((r, i) => ({ r, i })).sort((a, b) => b.r.mean - a.r.mean || a.i - b.i).map(({ r }) => r);
}

/** A number with up to `places` decimals, trailing zeros dropped: 48.90 -> 48.9, 100.0 -> 100. */
export const fmt = (n: number, places = 1) => n.toFixed(places).replace(/\.0+$/, '');

const DEFAULTS = {
  metric: 'Score (mean ± margin)',
  format: (n: number) => fmt(n),
  best: true,
  empty: 'No models ranked yet: our runs of every decision model Opper serves come next. Benchmark your own model below.',
};

/**
 * The headings, each with its class: 'r' right-aligns a number column, 'hide-m' drops it narrower than a laptop (who
 * ran a community model then shows under its name).
 */
export function tableHeadings(o: TableOptions = {}): [string, string][] {
  return [
    ['#', ''],
    ['Model', ''],
    [o.metric ?? DEFAULTS.metric, ''],
    ...((o.best ?? DEFAULTS.best) ? [['Best', 'r'] as [string, string]] : []),
    ...(o.extra ?? []).map((c): [string, string] => [c.label, 'r']),
    ['Games', 'r hide-m'],
    [o.fallbacks ?? 'Fallbacks', 'r'],
    [o.latency ?? 'Latency', 'r'],
    ['Cost / game', 'r'],
    ['Run by', 'hide-m'],
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

/** What the row's model line says under its name: the maker, Community for a self-reported model, or Script. */
export function modelNote(r: Row): string {
  if (r.kind === 'community') return 'Community';
  if (r.kind === 'baseline') return 'Script, no model';
  const maker = modelMaker(r.model) ?? r.model;
  return r.via === 'chat-adapter' ? `${maker}, chat model via adapter` : maker;
}

function el<K extends keyof HTMLElementTagNameMap>(tagName: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tagName);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

/** A link someone submitted (their model's page, their profile): opened in a new tab and marked as user-submitted. */
const outLink = (href: string, text: string, cls?: string) => Object.assign(el('a', text, cls), { href, target: '_blank', rel: 'noopener nofollow ugc' });

/** Who ran the games: our runs link this repo, a community model its submitter's GitHub profile. */
function runBy(r: Row): HTMLElement {
  if (r.kind !== 'community') return tag(Object.assign(el('a', '@opper-ai'), { href: 'https://github.com/opper-ai/decision-benchmarks', target: '_blank', rel: 'noopener' }), 'click_github', { source: 'leaderboard_run_by' });
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(r.by) ? tag(outLink(`https://github.com/${r.by}`, `@${r.by}`), 'click_github', { source: 'leaderboard_run_by' }) : el('span', r.by);
}

/** The model's name: a link to its page on opper.ai, or for a self-reported model to the page its submitter gave. */
function nameOf(r: Row, source: string, fill: (name: HTMLElement) => void): HTMLElement {
  const page = r.kind === 'official' ? pageOf(r.model) : undefined;
  const own = r.kind === 'community' && r.url && /^https?:\/\//.test(r.url) ? r.url : undefined;
  const name = page
    ? tag(Object.assign(el('a', undefined, 'mname'), { href: page }), 'click_view_model', { source, model: r.model })
    : own
      ? tag(outLink(own, '', 'mname'), 'click_community_model', { source, model: r.model })
      : el('span', undefined, 'mname');
  fill(name);
  return name;
}

/**
 * A model's mark (or, without one, its initial, so every name lines up). When the name links somewhere, the mark links
 * there too: a copy of the name's link, left out of the tab order and screen readers, where the name is the link.
 */
function markOf(r: Row, name: HTMLElement): HTMLElement {
  const mark = logoFor(r.model) ?? el('span', r.name.trim().charAt(0).toUpperCase(), 'logo initial');
  if (!(name instanceof HTMLAnchorElement)) return mark;
  const a = name.cloneNode(false) as HTMLAnchorElement;
  a.className = 'logo-link';
  a.tabIndex = -1;
  a.setAttribute('aria-hidden', 'true');
  a.append(mark);
  return a;
}

/** The chevron on a phone row: down when closed, turned up when open. */
function chevron(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ class: 'chev', width: '16', height: '16', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const path = document.createElementNS(ns, 'path');
  for (const [k, v] of Object.entries({ d: 'M4 6l4 4 4-4', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) path.setAttribute(k, v);
  svg.append(path);
  return svg;
}

const BASE_TIP = 'Baseline: a short script, no model. Shown at its score for reference, not ranked.';

// One tooltip for the Base tags, placed against the window so the table's scrolling box can't clip it. Hover or focus
// shows it; a click (a tap on phones) pins it until a click elsewhere, Escape, or a scroll.
let tip: HTMLElement | null = null;
let tipFor: HTMLButtonElement | null = null;
let pinned = false;
function showTip(button: HTMLButtonElement, text: string): void {
  if (!tip) {
    tip = el('div', undefined, 'kind-tip');
    tip.id = 'kind-tip';
    tip.setAttribute('role', 'tooltip');
    document.body.append(tip);
    const close = () => hideTip(true);
    document.addEventListener('click', (e) => {
      if (!(e.target instanceof Element && e.target.closest('.kind-tag'))) close();
    });
    document.addEventListener('keydown', (e) => e.key === 'Escape' && close());
    window.addEventListener('scroll', close, { passive: true });
    window.addEventListener('resize', close);
  }
  tip.textContent = text;
  tip.hidden = false;
  tipFor?.removeAttribute('aria-describedby');
  tipFor = button;
  button.setAttribute('aria-describedby', 'kind-tip');
  const r = button.getBoundingClientRect();
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  tip.style.left = `${Math.max(12, Math.min(r.left, document.documentElement.clientWidth - width - 12))}px`;
  tip.style.top = `${r.bottom + 8 + height > window.innerHeight ? r.top - 8 - height : r.bottom + 8}px`;
}
function hideTip(force = false): void {
  if (!tip || (pinned && !force)) return;
  pinned = false;
  tip.hidden = true;
  tipFor?.removeAttribute('aria-describedby');
  tipFor = null;
}
/** The rank cell of a baseline's row: Base instead of a number, explained on hover or a tap. */
function baseTag(): HTMLElement {
  const b = el('button', 'Base', 'kind-tag');
  b.type = 'button';
  b.addEventListener('mouseenter', () => !pinned && showTip(b, BASE_TIP));
  b.addEventListener('mouseleave', () => hideTip());
  b.addEventListener('focus', () => !pinned && showTip(b, BASE_TIP));
  b.addEventListener('blur', () => hideTip());
  b.addEventListener('click', (e) => {
    e.stopPropagation(); // on a phone row, a tap on the tag explains it instead of opening the row
    const open = !(pinned && tipFor === b);
    hideTip(true);
    if (open) {
      showTip(b, BASE_TIP);
      pinned = true;
    }
  });
  return b;
}
/** A row's rank, or Base for a baseline. */
function rankCell<K extends 'td' | 'span'>(r: Row, tagName: K): HTMLElementTagNameMap[K] {
  const c = el(tagName, undefined, 'rk');
  c.append(r.kind === 'baseline' ? baseTag() : r.rank);
  return c;
}
const rowClass = (r: Row, base: string[] = []) => [...base, r.tie ? 'tie' : '', r.kind === 'community' ? 'self' : '', r.kind === 'baseline' ? 'ref' : ''].filter(Boolean).join(' ') || undefined;

/**
 * Renders the leaderboard: `table` for laptops and up; `list`, if given, the same rows for phones (page.css shows one
 * or the other). An empty-state line leads while no model is ranked, the baselines still below it.
 */
export function renderLeaderboard(table: HTMLTableElement, rows: Rows, o: TableOptions = {}, list?: HTMLElement): void {
  const format = o.format ?? DEFAULTS.format;
  const headings = tableHeadings(o);
  const order = tableOrder(rows);
  // Every row's bar on one scale, so a baseline's reads against the models'.
  const top = o.scaleMax ?? Math.max(1, ...order.map((r) => r.mean));
  const head = el('thead');
  const hr = el('tr');
  for (const [label, cls] of headings) hr.append(el('th', label, cls || undefined));
  head.append(hr);
  const body = el('tbody');
  const numberHeads = headings.slice(3, -1);
  const line = (r: Row) => {
    const tr = el('tr', undefined, rowClass(r));
    tr.append(rankCell(r, 'td'));
    const mdl = el('div', undefined, 'mdl');
    const name = nameOf(r, 'leaderboard', (a) => a.append(el('b', r.name)));
    const who = el('div');
    const small = el('small');
    if (r.kind === 'community') {
      const runM = el('span', 'Run by ', 'show-m');
      runM.append(runBy(r));
      small.append(el('span', modelNote(r), 'hide-m'), runM);
    } else small.textContent = modelNote(r);
    who.append(name, small);
    mdl.append(markOf(r, name), who);
    const tdModel = el('td');
    tdModel.append(mdl);
    tr.append(tdModel);
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
    numberCells(r, o).forEach((text, i) => tr.append(el('td', text, `n ${numberHeads[i]![1]}`)));
    const run = el('td', undefined, 'run hide-m');
    run.append(runBy(r));
    tr.append(run);
    return tr;
  };
  if (!rows.ranked.length) {
    const tr = el('tr', undefined, 'empty');
    const td = el('td', o.empty ?? DEFAULTS.empty);
    td.colSpan = headings.length;
    tr.append(td);
    body.append(tr);
  }
  for (const r of order) body.append(line(r));
  table.replaceChildren(head, body);
  if (list) renderList(list, rows, order, o);
}

/** Phones: rank, mark, model and maker, and the mean per row; a tap opens the rest, one row at a time. */
function renderList(list: HTMLElement, rows: Rows, order: Row[], o: TableOptions): void {
  const format = o.format ?? DEFAULTS.format;
  const headings = tableHeadings(o);
  const setOpen = (item: HTMLElement, open: boolean) => {
    item.classList.toggle('open', open);
    item.querySelector('.lbl-toggle')!.setAttribute('aria-expanded', String(open));
    item.querySelector<HTMLElement>('.lbl-d')!.hidden = !open;
  };
  const listItem = (r: Row, i: number) => {
    const item = el('div', undefined, rowClass(r, ['lbl-row']));
    const name = nameOf(r, 'leaderboard_mobile', (a) => (a.textContent = r.name));
    const who = el('span', undefined, 'who');
    who.append(name, el('small', modelNote(r)));
    const toggle = el('button', undefined, 'lbl-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', `lbl-${i}`);
    toggle.setAttribute('aria-label', `${r.name}: all numbers`);
    toggle.append(chevron());
    const head = tag(el('div', undefined, 'lbl-head'), 'click_leaderboard_row', { source: 'mobile', model: r.model });
    head.append(rankCell(r, 'span'), markOf(r, name), who, el('span', format(r.mean), 'n'), toggle);
    const details = el('dl', undefined, 'lbl-d');
    details.id = `lbl-${i}`;
    details.hidden = true;
    const add = (label: string, value: string | Node) => {
      const dd = el('dd');
      dd.append(value);
      details.append(el('dt', label), dd);
    };
    add(headings[2]![0], `${format(r.mean)} ±${format(r.margin)}`);
    numberCells(r, o).forEach((text, k) => add(headings[3 + k]![0], text));
    add('Run by', runBy(r));
    head.addEventListener('click', (ev) => {
      if (ev.target instanceof Element && ev.target.closest('a')) return; // the name's link
      const open = !item.classList.contains('open');
      for (const other of list.querySelectorAll<HTMLElement>('.lbl-row.open')) setOpen(other, false);
      setOpen(item, open);
    });
    item.append(head, details);
    return item;
  };
  const cols = el('div', undefined, 'lbl-cols');
  cols.append(el('span', '#', 'rk'), el('span', 'Model', 'grow'), el('span', 'Mean'));
  const empty = rows.ranked.length ? [] : [el('p', o.empty ?? DEFAULTS.empty, 'lbl-empty')];
  list.replaceChildren(cols, ...empty, ...order.map(listItem));
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

/**
 * Fetches the game's results files and renders its table, and the phone list beside it (the .lbl in the same card).
 * Resolves to the rows, for anything else on the page that reads them (a score to beat, where a player would rank).
 */
export async function loadLeaderboard(table: HTMLTableElement, path: (p: string) => string, o: TableOptions = {}): Promise<Rows> {
  const [official, community, baselines] = await Promise.all([fetchJson(path('/leaderboard.json')), fetchJson(path('/community.json')), o.baselines ? fetchJson(path('/baselines.json')) : null]);
  const rows = leaderboardRows(official, community, baselines);
  renderLeaderboard(table, rows, o, table.closest('.tablecard')?.querySelector<HTMLElement>('.lbl') ?? undefined);
  return rows;
}
