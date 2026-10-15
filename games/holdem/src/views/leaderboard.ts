// The Leaderboard section: the kit's table over leaderboard.json, community.json and baselines.json, as Snake's and
// Jev Fighter's, with the poker names (the kit only knows the decision models' names) and a row of the benchmark's own
// numbers under each model: VPIP, PFR, aggression, showdowns, bluffs, and big blinds won from each bot.
import { fetchJson, fmt, leaderboardRows, renderLeaderboard, type Row, type Rows } from '../../../../packages/kit/client/leaderboard.ts';
import { isBotName } from '../../shared/bots.ts';
import { h } from '../dom.ts';
import { BOT_LABELS, modelById } from '../roster.ts';

/** bb/100 with its sign. */
export const bb = (n: number): string => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n))}`;

/** The rows, every model and bot by the name the page uses. */
export function holdemRows(official: unknown, community: unknown, baselines: unknown): Rows {
  const rows = leaderboardRows(official, community, baselines);
  const named = (r: Row): Row => {
    if (r.kind === 'community') return r;
    const bot = r.model.replace(/^baseline\//, '');
    if (r.kind === 'baseline' && isBotName(bot)) return { ...r, name: `${BOT_LABELS[bot]} (bot)` };
    return { ...r, name: modelById(r.model)?.name ?? r.name };
  };
  return { ranked: rows.ranked.map(named), baselines: rows.baselines.map(named) };
}

/** The benchmark's own numbers for a row, as label and value, in the order a reader wants them. */
export function extraFacts(extra: Row['extra']): [string, string][] {
  if (!extra) return [];
  const out: [string, string][] = [];
  const num = (k: string) => (typeof extra[k] === 'number' ? (extra[k] as number) : null);
  const pct = (label: string, k: string) => num(k) !== null && out.push([label, `${fmt(num(k)!)}%`]);
  pct('VPIP', 'VPIP %');
  pct('PFR', 'PFR %');
  const af = extra['Aggression factor'];
  if (af !== undefined) out.push(['Aggression', typeof af === 'number' ? fmt(af, 2) : String(af)]);
  pct('Fold to a 3-bet', 'Fold to 3-bet %');
  pct('Went to showdown', 'Went to showdown %');
  pct('Won at showdown', 'Won at showdown %');
  pct('Bluff rate', 'Bluff rate %');
  for (const bot of ['rock', 'station', 'maniac'] as const) if (num(`bb/100 vs ${bot}`) !== null) out.push([`vs ${BOT_LABELS[bot]}`, `${bb(num(`bb/100 vs ${bot}`)!)} bb/100`]);
  pct('Fallbacks', 'Fallback %');
  return out;
}

const OPTIONS = {
  metric: 'bb/100 (mean ± margin)',
  // The kit writes the margin with the same function, so no plus sign: "14.2 ±6.2", "−4.5 ±4.4".
  format: (n: number) => (n < 0 ? `−${fmt(-n)}` : fmt(n)),
  best: false,
  fallbacks: 'Fallbacks',
  latency: 'Mean latency',
  empty: 'No model has played the benchmark yet: the first official runs are on their way.',
};

/** Renders the table, then a row of numbers under each model, opened with its Stats button. */
export function renderHoldemLeaderboard(table: HTMLTableElement, rows: Rows): void {
  renderLeaderboard(table, rows, { ...OPTIONS, scaleMax: Math.max(1, ...[...rows.ranked, ...rows.baselines].map((r) => Math.abs(r.mean))) });
  const lines = [...table.tBodies[0]!.rows].filter((tr) => !tr.classList.contains('group') && !tr.classList.contains('empty'));
  const all = [...rows.ranked, ...rows.baselines];
  lines.forEach((tr, i) => {
    const facts = extraFacts(all[i]?.extra);
    if (!facts.length) return;
    const details = h('tr.lb-details', { hidden: true });
    const td = h('td', null, h('dl.lb-facts', null, ...facts.map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, v)))));
    td.colSpan = tr.cells.length;
    details.append(td);
    tr.after(details);
    const more = h('button.lb-more', { type: 'button', 'aria-expanded': 'false', onclick: () => {
      details.hidden = !details.hidden;
      more.setAttribute('aria-expanded', String(!details.hidden));
    } }, 'Stats');
    tr.querySelector('td.mdl')?.append(more);
  });
}

/** Fetches the results files below the game's path and renders the section's table. */
export async function mountLeaderboard(table: HTMLTableElement, path: (p: string) => string): Promise<void> {
  const [official, community, baselines] = await Promise.all([fetchJson(path('/leaderboard.json')), fetchJson(path('/community.json')), fetchJson(path('/baselines.json'))]);
  renderHoldemLeaderboard(table, holdemRows(official, community, baselines));
}
