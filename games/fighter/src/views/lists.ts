import { modelInfo } from '../../shared/models.ts';
import { PROVISIONAL_BELOW, type Source } from '../../shared/stats.ts';
import { deleteReplay, getLeaderboard, getReplays, type Me } from '../api.ts';
import { h, money, pct } from '../dom.ts';
import { COLORS } from './fight.ts';

type SourceFilter = Source | 'all';

/** A row of radio buttons: one choice, shown as a segmented control. */
function radios<T extends string>(name: string, label: string, options: [T, string][], value: T, onChange: (v: T) => void): HTMLElement {
  return h(
    'fieldset.radios',
    null,
    h('legend', null, label),
    ...options.map(([v, text]) => {
      const input = h('input', { type: 'radio', name, value: v, checked: v === value }) as HTMLInputElement;
      input.addEventListener('change', () => input.checked && onChange(v));
      return h('label', null, input, h('span', null, text));
    }),
  );
}

export const sourceBadge = (src: Source) => h(`span.badge.src-${src}`, { title: src === 'official' ? 'Run by us: a fixed list of models, the same seeds, from one place' : 'Saved from the site by a player: not checked' }, src === 'official' ? 'Official' : 'Community');

export async function replaysView(host: HTMLElement, me: Me): Promise<void> {
  let filter: SourceFilter = 'official';
  const body = h('div', null, h('p.note', null, 'Loading...'));
  const controls = h('div.filters');
  const render = async () => {
    const { replays: list, counts } = await getReplays(filter);
    controls.replaceChildren(
      radios<SourceFilter>(
        'replay-source',
        'Show',
        [
          ['official', `Official (${counts.official})`],
          ['community', `Community (${counts.community})`],
          ['all', 'All'],
        ],
        filter,
        (v) => {
          filter = v;
          void render();
        },
      ),
    );
    body.replaceChildren(
      list.length
        ? h(
            'div.cards',
            null,
            ...list.map((s) => {
              const [a, b] = s.stats;
              const winner = s.winner === null ? 'Draw' : `${s.stats[s.winner].label} wins`;
              const card = h(
                'div.card',
                null,
                h(
                  'a.card-body',
                  { href: `/replay/${s.id}` },
                  h('div.card-vs', null, h('span', { style: { color: COLORS[0] } }, a.label), h('span.vs-small', null, 'vs'), h('span', { style: { color: COLORS[1] } }, b.label)),
                  h('div.card-win', null, winner, ` (${a.roundsWon}-${b.roundsWon})`),
                  h('div.card-meta', null, `${new Date(s.createdAt).toLocaleString()} · ${s.mode === 'paused' ? 'paused' : 'real time'} · ${s.track ?? 'assisted'}`),
                  h('div.card-meta', null, `damage ${a.dealt}-${b.dealt} · p50 ${Math.round(a.latency.p50)} / ${Math.round(b.latency.p50)} ms · ${money(a.costUsd + b.costUsd)}`),
                ),
                h('div.card-foot', null, sourceBadge(s.source), me.admin ? deleteButton(s.id, () => card.remove()) : null),
              );
              return card;
            }),
          )
        : h('p.note', null, filter === 'community' ? 'No community matches yet. Play a fight and it lands here.' : 'No replays yet. Run a fight or `npm run bench`.'),
    );
  };
  host.replaceChildren(
    h(
      'div.page',
      null,
      h('h1', null, 'Replays'),
      h('p.lead', null, 'Official matches are run by us: a fixed list of models on the same seeds, from one place. Community matches are saved from the site by players and are not checked.'),
      controls,
      body,
    ),
  );
  await render();
}

/** Deletes a replay after a second click, so one slip does not lose it. */
export function deleteButton(id: string, onDeleted: () => void): HTMLElement {
  const btn = h('button.btn.small.danger', { type: 'button', title: 'Delete this replay' }, 'Delete') as HTMLButtonElement;
  let armed = false;
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!armed) {
      armed = true;
      btn.textContent = 'Delete for good?';
      setTimeout(() => {
        armed = false;
        if (btn.isConnected && !btn.disabled) btn.textContent = 'Delete';
      }, 4000);
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Deleting...';
    try {
      await deleteReplay(id);
      onDeleted();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = `Failed: ${(err as Error).message}`;
    }
  });
  return btn;
}

export async function leaderboardView(host: HTMLElement): Promise<void> {
  // Real time on the raw track is the default: the fullest test (understanding the fight, against the clock).
  let mode: 'realtime' | 'paused' = 'realtime';
  let track: 'assisted' | 'raw' = 'raw';
  let community = false;
  const body = h('div');
  const tabs = h('div.tabs');
  const filters = h('div.filters');
  const render = async () => {
    filters.replaceChildren(
      radios<'assisted' | 'raw'>(
        'lb-track',
        'Track',
        [
          ['raw', 'Raw'],
          ['assisted', 'Assisted'],
        ],
        track,
        (v) => {
          track = v;
          void render();
        },
      ),
      radios<'official' | 'all'>(
        'lb-source',
        'Matches',
        [
          ['official', 'Official'],
          ['all', 'Official + community'],
        ],
        community ? 'all' : 'official',
        (v) => {
          community = v === 'all';
          void render();
        },
      ),
    );
    tabs.replaceChildren(
      ...(['realtime', 'paused'] as const).map((m) =>
        h(
          `button.tab${m === mode ? '.active' : ''}`,
          {
            type: 'button',
            onclick: () => {
              mode = m;
              void render();
            },
          },
          m === 'paused' ? 'Decisions (paused)' : 'Speed (real time)',
        ),
      ),
    );
    body.replaceChildren(h('p.note', null, 'Loading...'));
    const lb = await getLeaderboard(mode, track, community);
    const rows = lb.rows ?? [];
    if (!rows.length) {
      body.replaceChildren(h('p.note', null, community ? 'No matches for this mode and track yet.' : 'No official matches for this mode and track yet.'));
      return;
    }
    const names = rows.map((r) => r.model);
    body.replaceChildren(
      h(
        'div.table-wrap',
        null,
        h(
          'table.lb',
          null,
          h('thead', null, h('tr', null, ...['#', 'Player', 'Rating [95% CI]', 'W-L-D', 'Score', 'Latency p50', 'Fallbacks', 'Cost / match'].map((t) => h('th', null, t)))),
          h(
            'tbody',
            null,
            ...rows.map((r, k) => {
              const kind = modelInfo(r.model).kind;
              const provisional = r.matches < PROVISIONAL_BELOW;
              return h(
                `tr${kind === 'baseline' ? '.baseline' : ''}${provisional ? '.provisional' : ''}`,
                null,
                h('td', null, String(k + 1)),
                h('td', null, h('strong', null, r.label), provisional ? h('span.badge', { title: `Fewer than ${PROVISIONAL_BELOW} matches: the rating can still move a lot` }, 'provisional') : null, h('div.model-id', null, r.model === 'human' ? 'people at the keyboard' : kind === 'baseline' ? (modelInfo(r.model).description ?? '') : `${r.model}${kind === 'chat' ? ' (LLM)' : ''}`)),
                h('td.num', null, `${r.rating}`, h('span.ci', null, ` [${r.ci[0]}, ${r.ci[1]}]`)),
                h('td.num', null, `${r.wins}-${r.losses}-${r.draws}`),
                h('td.num', null, pct(r.winRate)),
                h('td.num', null, kind === 'baseline' ? '' : `${Math.round(r.p50LatencyMs)} ms`),
                h('td.num', null, pct(r.fallbackRate)),
                h('td.num', null, money(r.costPerMatch)),
              );
            }),
          ),
        ),
      ),
      h('h3', null, 'Head to head (points of row against column)'),
      h(
        'div.table-wrap',
        null,
        h(
          'table.matrix',
          null,
          h('thead', null, h('tr', null, h('th', null, ''), ...names.map((n) => h('th', null, modelInfo(n).label)))),
          h(
            'tbody',
            null,
            ...names.map((a) =>
              h(
                'tr',
                null,
                h('th', null, modelInfo(a).label),
                ...names.map((b) => {
                  const c = lb.matrix?.[a]?.[b];
                  if (a === b || !c) return h('td.num', null, '');
                  const share = c.points / c.games;
                  return h('td.num', { style: { background: `rgba(${share >= 0.5 ? '23,125,56' : '194,37,92'},${Math.abs(share - 0.5) * 0.5})` } }, `${c.points}/${c.games}`);
                }),
              ),
            ),
          ),
        ),
      ),
    );
  };
  host.replaceChildren(
    h(
      'div.page',
      null,
      h('div.page-head', null, h('h1', null, 'Leaderboard'), h('button.btn.small', { type: 'button', onclick: openHowToRead }, 'How to read the results')),
      tabs,
      filters,
      body,
    ),
  );
  await render();
}

/** What the leaderboard's numbers and switches mean, in a popup so the table stays on top. */
function openHowToRead(): void {
  const d = h('dialog.connect', { 'aria-labelledby': 'how-title' }) as HTMLDialogElement;
  const close = h('button.btn.small', { type: 'button' }, 'Close');
  close.addEventListener('click', () => d.close());
  d.addEventListener('click', (e) => e.target === d && d.close());
  d.addEventListener('close', () => d.remove());
  const section = (title: string, ...body: (string | HTMLElement)[]) => h('section', null, h('h3', null, title), ...body.map((b) => (typeof b === 'string' ? h('p', null, b) : b)));
  d.append(
    h('div.connect-head', null, h('h2', { id: 'how-title' }, 'How to read the results'), close),
    h(
      'div.connect-body',
      null,
      section('Ratings', 'Bradley-Terry ratings on the current engine, on an Elo-like scale where 1500 is the average player. The brackets are 95% intervals: when two overlap, the order between those two is not settled yet. A player with fewer than 6 matches is marked provisional.'),
      section('Real time or paused', 'In real time the clock keeps running, so a slow answer costs turns: it rewards deciding well and fast. Paused matches wait for every answer and measure decisions only.'),
      section('Raw or assisted', 'Raw: the model gets only each move\'s damage, speed and reach, and has to understand the fight itself. Assisted: the game works out what each move would win or lose against everything the opponent could do and shows it as a table; the model picks from it.'),
      section('Official or community', 'Official matches are run by us: a fixed list of models, every pair on the same seeds from both sides, from one place. Community matches are saved from the site by players and cannot be checked, so they only count when you include them.'),
      section('Baselines', 'Baselines need no model: they follow one fixed rule on the assisted table (greedy takes the biggest swing, maximin the safest move, random anything). A model that cannot beat them is not adding anything.'),
      section('Head to head', 'Under the table, each cell is the row player\'s points against the column player (a win is 1, a draw 0.5) over the games they played.'),
    ),
  );
  document.body.append(d);
  d.showModal();
}
