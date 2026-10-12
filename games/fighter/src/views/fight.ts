import { Match } from '../../shared/match.ts';
import type { Adapter } from '../../shared/adapter.ts';
import { DEFAULT_LEFT, DEFAULT_RIGHT, modelInfo } from '../../shared/models.ts';
import type { Track } from '../../shared/question.ts';
import type { FighterMeta } from '../../shared/replay.ts';
import { saveReplay, type Me } from '../api.ts';
import { CONTROLS, getKeyboard } from '../input.ts';
import { FILE, HUMAN, MINE, connections, planFighter, subscribe, update, type Plan } from '../connections.ts';
import { openConnect } from './connect.ts';
import { h, money } from '../dom.ts';
import { Stage } from '../stage.ts';
import { decisionCard, topMoves } from './decisions.ts';
import { audio } from '../audio.ts';

import { SIDES } from '../theme.ts';

export const COLORS = [SIDES[0].deep, SIDES[1].deep] as const;
const STORE = 'jev-fighter.setup';

interface Setup {
  left: string;
  right: string;
  mode: 'realtime' | 'paused';
  deadline: number;
  track: Track;
}

function loadSetup(): Setup {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Setup | null;
    if (s?.left && s?.right) return { ...s, track: s.track === 'raw' ? 'raw' : 'assisted' };
  } catch {
    // storage blocked
  }
  return { left: DEFAULT_LEFT, right: DEFAULT_RIGHT, mode: 'realtime', deadline: 0, track: 'assisted' };
}

const ADD = '__add';

export function fightView(host: HTMLElement, me: Me, navigate: (path: string) => void): () => void {
  let cleanup: () => void = () => {};
  const setup = loadSetup();
  const group = (label: string, items: [string, string][], sel: string) =>
    items.length ? h('optgroup', { label }, ...items.map(([value, text]) => h('option', { value, selected: value === sel }, text))) : null;
  const models = (kind: string): [string, string][] => me.models.filter((m) => m.kind === kind).map((m) => [m.id, m.label]);
  /** The picker lists what you are connected to; endpoints come and go with the Connect panel. */
  const fill = (select: HTMLSelectElement, sel: string) => {
    const c = connections();
    const endpoints: [string, string][] = [
      ...c.endpoints.map((e): [string, string] => [`${MINE}${e.id}`, e.name]),
      ...(me.endpoints ?? []).map((e): [string, string] => [`${FILE}${e.id}`, `${e.name} (fighters.json)`]),
    ];
    select.replaceChildren(
      ...[
        group('Decision models (System One)', models('systemone'), sel),
        group('LLMs', models('chat'), sel),
        group('Your endpoints', [...endpoints, [ADD, 'Add an endpoint...']], sel),
        group('Play it yourself', [[HUMAN, 'You (keyboard)']], sel),
        group('Baselines (no API)', models('baseline'), sel),
      ].filter((x): x is HTMLOptGroupElement => x !== null),
    );
    // A removed endpoint falls back to the first listed model.
    if (select.value !== sel && ![...select.options].some((o) => o.value === sel)) select.selectedIndex = 0;
  };
  const left = h('select', { id: 'left' }) as HTMLSelectElement;
  const right = h('select', { id: 'right' }) as HTMLSelectElement;
  const pickers = [left, right] as const;
  const chosen = [setup.left, setup.right];
  pickers.forEach((p, k) => fill(p, chosen[k]));
  const mode = h('select', { id: 'mode' }, h('option', { value: 'realtime', selected: setup.mode === 'realtime' }, 'Real time: thinking costs time'), h('option', { value: 'paused', selected: setup.mode === 'paused' }, 'Paused: the fight waits for answers')) as HTMLSelectElement;
  // Empty = automatic: 2 s in real time, 15 s paused (the fight waits anyway).
  const deadline = h('input', { id: 'deadline', type: 'number', min: 300, max: 30000, step: 100, placeholder: 'auto', value: setup.deadline || '' }) as HTMLInputElement;
  const track = h(
    'select',
    { id: 'track' },
    h('option', { value: 'assisted', selected: setup.track !== 'raw' }, 'Assisted: options show payoffs'),
    h('option', { value: 'raw', selected: setup.track === 'raw' }, 'Raw: situation and rules only'),
  ) as HTMLSelectElement;
  const start = h('button.btn.primary.big', { type: 'button' }, 'Fight!');
  const billing = h('span.note');
  const signin = h('div.signin');

  // Each fighter: who pays, and (rarely needed) a key for that fighter only.
  const sideParts = ([0, 1] as const).map((k) => {
    const note = h('span.keynote');
    const own = h('input', { id: `key-${k}`, type: 'password', value: connections().fighterKeys[k], placeholder: 'Optional', autocomplete: 'off', spellcheck: 'false', 'data-1p-ignore': true, 'data-lpignore': 'true' }) as HTMLInputElement;
    own.addEventListener('change', () => update((c) => (c.fighterKeys[k] = own.value.trim())));
    const more = h('details.fighter-keys', null, h('summary', null, 'Use a different key'), h('label', { for: `key-${k}` }, 'A key for this fighter only', own));
    return { note, more, box: h('div.fighter-extra', null, note, more) };
  });

  const plans = () => pickers.map((p, k) => planFighter(p.value, k as 0 | 1, me));
  function refresh() {
    const ps = plans();
    ps.forEach((p, k) => {
      sideParts[k].note.textContent = p.note;
      sideParts[k].note.classList.toggle('warn', Boolean(p.problem));
      sideParts[k].more.hidden = p.source === 'baseline' || p.source === 'human';
    });
    const problem = left.value === HUMAN && right.value === HUMAN ? 'One keyboard, one player: pick a model or baseline for the other side.' : (ps.find((p) => p.problem)?.problem ?? null);
    start.toggleAttribute('disabled', Boolean(problem));
    billing.textContent = problem ?? (ps.every((p) => p.source === 'baseline' || p.source === 'human') ? 'Runs in your browser: no API calls.' : '');
    signin.hidden = !ps.some((p) => p.source === 'none');
  }

  host.replaceChildren(
    h(
      'div.setup',
      null,
      h('h1', null, 'Pick two fighters'),
      h('p.lead', null, 'Each fighter is a model, an endpoint of yours, or you. Every time a fighter is free to act it gets the situation and its legal moves, and picks one. System One classifiers answer with probabilities; LLMs answer the same question through a JSON schema.'),
      h(
        'div.vs',
        null,
        h('div.side', null, h('label.side-pick', { for: 'left' }, h('span.dot.big', { style: { background: COLORS[0] } }), h('span', null, 'Left'), left), sideParts[0].box),
        h('div.vs-word', null, 'vs'),
        h('div.side', null, h('label.side-pick', { for: 'right' }, h('span.dot.big', { style: { background: COLORS[1] } }), h('span', null, 'Right'), right), sideParts[1].box),
      ),
      h('div.row', null, h('label', { for: 'mode' }, 'Mode', mode)),
      h(
        'details.advanced',
        null,
        h('summary', null, 'Advanced'),
        h(
          'div.row',
          null,
          h('label', { for: 'track' }, 'Track', track),
          h('label', { for: 'deadline' }, 'Answer deadline (ms)', deadline),
        ),
        h('p.note', null, 'Assisted shows each move\'s payoff against the opponent\'s likely answers. Raw gives only the situation and the rules, a harder test. Each track has its own leaderboard.'),
      ),
      h('div.row', null, start, billing),
      signin,
    ),
  );
  signin.append(
    h('p', null, 'Models are billed to you: connect an Opper account or key, or an endpoint of your own. Or play a baseline yourself, pit two baselines against each other for free, or watch the replays.'),
    h('button.btn.primary', { type: 'button', onclick: () => openConnect(me) }, 'Connect'),
    h('a.btn', { href: '/replays' }, 'Watch replays'),
  );
  pickers.forEach((p, k) =>
    p.addEventListener('change', () => {
      if (p.value === ADD) {
        // Back to what was picked; the panel adds the endpoint, which then shows up here.
        fill(p, chosen[k]);
        openConnect(me, { addEndpoint: true });
      } else chosen[k] = p.value;
      refresh();
    }),
  );
  const unsubscribe = subscribe(() => {
    pickers.forEach((p, k) => {
      fill(p, chosen[k]);
      chosen[k] = p.value;
    });
    refresh();
  });
  refresh();

  start.addEventListener('click', () => {
    const ps = plans();
    if (ps.some((p) => p.problem)) return;
    const s: Setup = {
      left: left.value,
      right: right.value,
      mode: mode.value === 'paused' ? 'paused' : 'realtime',
      deadline: Number(deadline.value) > 0 ? Math.max(300, Number(deadline.value)) : mode.value === 'paused' ? 15000 : 2000,
      track: track.value === 'raw' ? 'raw' : 'assisted',
    };
    try {
      localStorage.setItem(STORE, JSON.stringify(s));
    } catch {
      // storage blocked
    }
    unsubscribe();
    cleanup = live(host, s, ps as [Plan, Plan], navigate);
  });
  return () => {
    unsubscribe();
    cleanup();
  };
}

/** The keys, shown under the stage while you play. */
function controlsCard(side: 0 | 1): HTMLElement {
  return h(
    'details.controls-card',
    { open: true },
    h('summary', null, `Your controls (you are ${side === 0 ? 'left, facing right' : 'right, facing left'})`),
    h('dl', null, ...CONTROLS.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    h('p.note', null, 'A key pressed a moment before your fighter is free still counts. Every move commits: a whiffed high kick leaves you open.'),
  );
}

function live(host: HTMLElement, s: Setup, plans: [Plan, Plan], navigate: (path: string) => void): () => void {
  const meta = plans.map((p, k) => p.meta(COLORS[k])) as [FighterMeta, FighterMeta];
  const match = new Match({
    seed: Math.floor(Math.random() * 2 ** 31),
    mode: s.mode,
    track: s.track,
    deadlineMs: s.deadline,
    // Baselines run here in the browser; in real time they "think" like a fast classifier.
    adapters: plans.map((p) => p.adapter(s.mode === 'realtime' ? 250 : 0)) as [Adapter, Adapter],
    maxTokens: [modelInfo(s.left).contextTokens, modelInfo(s.right).contextTokens],
    fighters: meta,
  });
  const humanSide = plans.findIndex((p) => p.source === 'human');
  const human = humanSide === -1 ? null : (humanSide as 0 | 1);
  const stageHost = h('div.stage-wrap');
  const stage = new Stage(stageHost, meta);
  const overlay = h('div.overlay', null, h('div.overlay-card', null, h('div.spinner'), h('div', null, `Waking up ${meta.filter((_, k) => k !== human).map((m) => m.label).join(' and ')}`)));
  stageHost.append(overlay);
  const feed = h('div.feed');
  const status = h('div.status');
  const stopBtn = h('button.btn', { type: 'button' }, 'Stop');
  const lat: [number[], number[]] = [[], []];

  host.replaceChildren(
    h(
      'div.viewer',
      null,
      h(
        'div.viewer-main',
        null,
        h('div.viewer-title', null, h('h1', null, h('span', { style: { color: COLORS[0] } }, human === 0 ? 'You' : meta[0].label), ' vs ', h('span', { style: { color: COLORS[1] } }, human === 1 ? 'You' : meta[1].label)), h('div.sub', null, `Live, ${s.mode === 'paused' ? 'paused' : 'real-time'} mode, ${s.track} track, ${s.deadline} ms deadline.`)),
        stageHost,
        h('div.controls', null, status, h('span.spacer'), stopBtn),
        human !== null ? controlsCard(human) : null,
      ),
      h('aside.panel', null, h('div.tabs', null, h('span.tab.active', null, 'Decisions, newest first')), h('div.panel-body', null, feed)),
    ),
  );

  match.onTick((st, events) => stage.tick(st, events));
  match.onDecision((d) => {
    if (d.answer) lat[d.fighter].push(d.latencyMs);
    // A player knows what they pressed; a bubble over them would only cover the fight.
    if (d.fighter !== human) stage.renderer.bubbles[d.fighter] = { thinking: false, since: performance.now(), top: topMoves(d), fallback: d.fallback, latencyMs: d.latencyMs };
    feed.prepend(decisionCard(d, meta));
    while (feed.childElementCount > 80) feed.lastElementChild?.remove();
  });
  stage.onFrame = () => {
    for (const i of [0, 1] as const) {
      const p = match.pending[i];
      const b = stage.renderer.bubbles[i];
      if (p && !p.settled) {
        // Keep the answer visible briefly before switching to "thinking".
        if (!b?.thinking && (!b || performance.now() - b.since > 500)) stage.renderer.bubbles[i] = { thinking: true, since: p.askedAt, top: [] };
        else if (b?.thinking && b.since !== p.askedAt) b.since = p.askedAt;
      } else if (b?.thinking) {
        // The question was cancelled (the fighter got hit) or answered.
        stage.renderer.bubbles[i] = null;
      }
    }
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
    // Streamed answers fill in their cost a moment after the move, so sum it fresh.
    const cost = match.decisions.reduce((sum, d) => sum + (d.answer?.costUsd ?? 0), 0);
    status.textContent = `${match.decisions.length} decisions, avg latency ${avg(lat[0])} / ${avg(lat[1])} ms, ${money(cost)}`;
  };
  stage.tick(match.state);

  let stopped = false;
  stopBtn.addEventListener('click', () => {
    stopped = true;
    match.stop();
  });

  (async () => {
    const errs = await match.warmUp();
    overlay.remove();
    if (errs.length) status.textContent = `Warm-up problem: ${errs.join('; ')}`;
    const replay = await match.run();
    if (stopped) {
      status.textContent = 'Stopped.';
      return;
    }
    const end = h('div.overlay.end', null, h('div.overlay-card', null, h('div', null, 'Saving the replay...')));
    stageHost.append(end);
    try {
      const { id, source } = await saveReplay(replay);
      end.firstElementChild!.replaceChildren(
        h('div.end-title', null, replay.result.winner === null ? 'Draw' : `${meta[replay.result.winner].label} wins`),
        ...(source === 'community' ? [h('p.note', null, 'Saved as a community match: it is in the Community replays and on the "Official + community" leaderboard.')] : []),
        h('div.row', null, h('button.btn.primary', { type: 'button', onclick: () => navigate(`/replay/${id}`) }, 'Watch the replay and stats'), h('button.btn', { type: 'button', onclick: () => navigate('/') }, 'New fight')),
      );
    } catch (e) {
      end.firstElementChild!.replaceChildren(h('div', null, `Could not save the replay: ${(e as Error).message}`), h('button.btn', { type: 'button', onclick: () => navigate('/') }, 'New fight'));
    }
  })();

  audio.scene(true);
  if (human !== null) {
    // Space would otherwise press whichever button has focus.
    (document.activeElement as HTMLElement | null)?.blur();
    getKeyboard().start();
  }
  return () => {
    if (human !== null) getKeyboard().stop();
    audio.scene(false);
    match.stop();
    stage.destroy();
  };
}
