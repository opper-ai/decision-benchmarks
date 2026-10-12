import type { CommunityEntry, Entry, Leaderboard } from '../../../../packages/kit/shared/contract.ts';
import { rankLabels } from '../../../../packages/kit/shared/stats.ts';
import { getBoards } from '../api.ts';
import { h, money } from '../dom.ts';

const pct1 = (x: number | string | undefined) => (typeof x === 'number' ? `${x.toFixed(1)}%` : '');

/** One board as a table: rank (ties share "=1"), the metric with its margin, the share against each baseline, cost. */
function table(board: Leaderboard<Entry | CommunityEntry>, opts: { runBy?: boolean } = {}): HTMLElement {
  const rows = board.entries;
  const ranks = rankLabels(rows, (e) => e.metric);
  const head = ['#', 'Model', 'Round-win share', 'vs greedy', 'vs payoff', 'vs maximin', 'Matches won', 'Games', 'Fallbacks', 'Latency', 'Cost / game', ...(opts.runBy ? ['Run by'] : [])];
  return h(
    'div.table-wrap',
    null,
    h(
      'table.lb',
      null,
      h('thead', null, h('tr', null, ...head.map((t) => h('th', null, t)))),
      h(
        'tbody',
        null,
        ...rows.map((e, k) =>
          h(
            'tr',
            null,
            h('td', null, ranks[k]!),
            h('td', null, h('strong', null, e.name), h('div.model-id', null, `${e.model}${e.via === 'chat-adapter' ? ' (chat model via adapter)' : ''}`)),
            h('td.num', null, `${e.metric.mean.toFixed(1)}%`, h('span.ci', null, ` ± ${(2 * e.metric.stdError).toFixed(1)}`)),
            h('td.num', null, pct1(e.extra?.vsGreedy)),
            h('td.num', null, pct1(e.extra?.vsPayoff)),
            h('td.num', null, pct1(e.extra?.vsMaximin)),
            h('td.num', null, pct1(e.extra?.matchWinShare)),
            h('td.num', null, String(e.games)),
            h('td.num', null, `${(e.fallbackRate * 100).toFixed(1)}%`),
            h('td.num', null, e.meanLatencyMs === null || e.meanLatencyMs === 0 ? '' : `${e.meanLatencyMs} ms`),
            h('td.num', null, e.costPerGame === null ? '' : money(e.costPerGame)),
            ...(opts.runBy ? [h('td', null, 'by' in e ? (e.url ? h('a', { href: e.url, rel: 'noopener nofollow', target: '_blank' }, `@${e.by}`) : `@${e.by}`) : '')] : []),
          ),
        ),
      ),
    ),
  );
}

export async function leaderboardView(host: HTMLElement): Promise<void> {
  const body = h('div', null, h('p.note', null, 'Loading...'));
  host.replaceChildren(
    h(
      'div.page',
      null,
      h('h1', null, 'Leaderboard'),
      h(
        'p.lead',
        null,
        "Each model plays 102 paused matches on the assisted track against the three strongest baselines (greedy, payoff and maximin), every fight from both sides. The score is its share of the rounds won, a drawn round counting half. ± is two standard errors: rows within that of the leader share first place.",
      ),
      body,
    ),
  );
  const { official, community, baselines } = await getBoards();
  const sections: HTMLElement[] = [];
  sections.push(h('h3', null, 'Our runs'));
  sections.push(official?.entries.length ? table(official) : h('p.note', null, 'No official runs yet: we play every decision model Opper serves, 102 games each, and the results land here.'));
  if (community?.entries.length) {
    sections.push(h('h3', null, 'Self-reported'), h('p.note', null, 'Sent by pull request and replayed by our CI: every game checks out, but the moves, latency and cost are as reported.'), table(community, { runBy: true }));
  }
  if (baselines?.entries.length) {
    sections.push(
      h('h3', null, 'Baselines, for reference'),
      h('p.note', null, 'The baselines as the player under test, on the same 102 games. Random picks any offered move, guard always blocks, greedy takes the biggest swing if the opponent stands, payoff the best average, maximin the safest move.'),
      table(baselines),
    );
  }
  body.replaceChildren(...sections);
}
