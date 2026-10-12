import type { TransportHooks } from '../../../../packages/kit/client/transport.ts';
import type { Adapter } from '../../shared/adapter.ts';
import { Match } from '../../shared/match.ts';
import { DEFAULT_OPPONENT, MODELS, modelInfo } from '../../shared/models.ts';
import type { Track } from '../../shared/question.ts';
import type { FighterMeta, Replay } from '../../shared/replay.ts';
import { downloadReplay, type Me } from '../api.ts';
import { audio } from '../audio.ts';
import { h, money } from '../dom.ts';
import { CONTROLS, getKeyboard } from '../input.ts';
import { HUMAN, planFighter, type Plan } from '../players.ts';
import { Stage } from '../stage.ts';
import { SIDES } from '../theme.ts';
import { decisionCard, topMoves } from './decisions.ts';

export const COLORS = [SIDES[0].deep, SIDES[1].deep] as const;
const STORE = 'fighter.setup';
/** A model's answer comes through the game's server, which gives it 2 s; the page waits a little longer. */
const MAX_DEADLINE_MS = 2500;

interface Setup {
  left: string;
  right: string;
  mode: 'realtime' | 'paused';
  deadline: number;
  track: Track;
}

const known = (id: unknown): id is string => id === HUMAN || MODELS.some((m) => m.id === id);

function loadSetup(): Setup {
  const fallback: Setup = { left: HUMAN, right: DEFAULT_OPPONENT, mode: 'realtime', deadline: 0, track: 'assisted' };
  try {
    const s = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Partial<Setup> | null;
    if (s && known(s.left) && known(s.right)) return { ...fallback, ...s, mode: s.mode === 'paused' ? 'paused' : 'realtime', track: s.track === 'raw' ? 'raw' : 'assisted', deadline: Number(s.deadline) || 0 };
  } catch {
    // storage blocked
  }
  return fallback;
}

export interface FightOptions {
  me: Me;
  hooks: TransportHooks;
  signIn: () => void;
  /** Opens the replay of a match just played (kept in this page only). */
  watch: (r: Replay) => void;
  navigate: (hash: string) => void;
}

export function fightView(host: HTMLElement, o: FightOptions): () => void {
  let cleanup: () => void = () => {};
  const setup = loadSetup();
  const group = (label: string, items: [string, string][], sel: string) => h('optgroup', { label }, ...items.map(([value, text]) => h('option', { value, selected: value === sel }, text)));
  const of = (kind: string): [string, string][] => MODELS.filter((m) => m.kind === kind).map((m) => [m.id, m.label]);
  const fill = (select: HTMLSelectElement, sel: string) =>
    select.replaceChildren(group('Play it yourself', [[HUMAN, 'You (keyboard)']], sel), group('Decision models', of('systemone'), sel), group('Baselines (no model, free)', of('baseline'), sel));
  const left = h('select', { id: 'left' }) as HTMLSelectElement;
  const right = h('select', { id: 'right' }) as HTMLSelectElement;
  const pickers = [left, right] as const;
  fill(left, setup.left);
  fill(right, setup.right);
  const mode = h('select', { id: 'mode' }, h('option', { value: 'realtime', selected: setup.mode === 'realtime' }, 'Real time: thinking costs time'), h('option', { value: 'paused', selected: setup.mode === 'paused' }, 'Paused: the fight waits for answers')) as HTMLSelectElement;
  // Empty = automatic: 2 s in real time, 2.5 s paused.
  const deadline = h('input', { id: 'deadline', type: 'number', min: 300, max: MAX_DEADLINE_MS, step: 100, placeholder: 'auto', value: setup.deadline || '' }) as HTMLInputElement;
  const track = h(
    'select',
    { id: 'track' },
    h('option', { value: 'assisted', selected: setup.track !== 'raw' }, 'Assisted: options show payoffs'),
    h('option', { value: 'raw', selected: setup.track === 'raw' }, 'Raw: situation and rules only'),
  ) as HTMLSelectElement;
  const start = h('button.btn.primary.big', { type: 'button' }, 'Fight!');
  const billing = h('span.note');
  const signin = h('div.signin');
  const notes = ([0, 1] as const).map(() => h('span.keynote'));

  const plans = () => pickers.map((p) => planFighter(p.value, o.me, o.hooks));
  function refresh() {
    const ps = plans();
    ps.forEach((p, k) => {
      notes[k]!.textContent = p.note;
      notes[k]!.classList.toggle('warn', Boolean(p.problem));
    });
    const problem = left.value === HUMAN && right.value === HUMAN ? 'One keyboard, one player: pick a model or a baseline for the other side.' : (ps.find((p) => p.problem)?.problem ?? null);
    start.toggleAttribute('disabled', Boolean(problem));
    billing.textContent = problem ?? (ps.every((p) => p.source !== 'model') ? 'Runs in your browser: no model calls.' : '');
    signin.hidden = !ps.some((p) => p.source === 'model' && p.problem) || !o.me.loginAvailable;
  }

  const sideBox = (k: 0 | 1, picker: HTMLSelectElement) =>
    h('div.side', null, h('label.side-pick', { for: picker.id }, h('span.dot.big', { style: { background: COLORS[k] } }), h('span', null, k === 0 ? 'Left' : 'Right'), picker), h('div.fighter-extra', null, notes[k]));
  host.replaceChildren(
    h(
      'div.setup',
      null,
      h('h1', null, 'Pick two fighters'),
      h(
        'p.lead',
        null,
        'Stick figures fight; models decide. Every time a fighter is free to act it gets the situation and its legal moves, and picks one. Fight a decision model yourself, or pit any two fighters against each other. Baselines follow one fixed rule and need no model.',
      ),
      h('div.vs', null, sideBox(0, left), h('div.vs-word', null, 'vs'), sideBox(1, right)),
      h('div.row', null, h('label', { for: 'mode' }, 'Mode', mode)),
      h(
        'details.advanced',
        null,
        h('summary', null, 'Advanced'),
        h('div.row', null, h('label', { for: 'track' }, 'Track', track), h('label', { for: 'deadline' }, 'Answer deadline (ms)', deadline)),
        h('p.note', null, "Assisted shows each move's payoff against the opponent's likely answers (the benchmark's track). Raw gives only the situation and the rules, a harder test."),
      ),
      h('div.row', null, start, billing),
      signin,
    ),
  );
  signin.append(h('p', null, 'Models play on the free credits while they last, then on your own Opper account.'), h('button.btn.primary', { type: 'button', onclick: o.signIn }, 'Login with Opper'), h('a.btn', { href: '#/watch' }, 'Watch a recorded match'));
  for (const p of pickers) p.addEventListener('change', refresh);
  refresh();

  start.addEventListener('click', () => {
    const ps = plans();
    if (ps.some((p) => p.problem)) return;
    const paused = mode.value === 'paused';
    const s: Setup = {
      left: left.value,
      right: right.value,
      mode: paused ? 'paused' : 'realtime',
      deadline: Number(deadline.value) > 0 ? Math.min(MAX_DEADLINE_MS, Math.max(300, Number(deadline.value))) : paused ? MAX_DEADLINE_MS : 2000,
      track: track.value === 'raw' ? 'raw' : 'assisted',
    };
    try {
      localStorage.setItem(STORE, JSON.stringify({ ...s, deadline: Number(deadline.value) > 0 ? s.deadline : 0 }));
    } catch {
      // storage blocked
    }
    cleanup = live(host, s, ps as [Plan, Plan], o);
  });
  return () => cleanup();
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

function live(host: HTMLElement, s: Setup, plans: [Plan, Plan], o: FightOptions): () => void {
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
  const models = meta.filter((_, k) => plans[k]!.source === 'model').map((m) => m.label);
  const stageHost = h('div.stage-wrap');
  const stage = new Stage(stageHost, meta);
  const overlay = h('div.overlay', null, h('div.overlay-card', null, h('div.spinner'), h('div', null, models.length ? `Waking up ${models.join(' and ')}` : 'Getting ready')));
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
        h(
          'div.viewer-title',
          null,
          h('h1', null, h('span', { style: { color: COLORS[0] } }, meta[0].label), ' vs ', h('span', { style: { color: COLORS[1] } }, meta[1].label)),
          h('div.sub', null, `Live, ${s.mode === 'paused' ? 'paused' : 'real-time'} mode, ${s.track} track, ${s.deadline} ms deadline.`),
        ),
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
    const download = h('button.btn', { type: 'button' }, 'Download the replay');
    download.addEventListener('click', () => void downloadReplay(replay));
    stageHost.append(
      h(
        'div.overlay.end',
        null,
        h(
          'div.overlay-card',
          null,
          h('div.end-title', null, replay.result.winner === null ? 'Draw' : `${meta[replay.result.winner].label} ${meta[replay.result.winner].kind === 'human' ? 'win' : 'wins'}`),
          h('p.note', null, 'This match stays in your browser: watch it with its stats, or save it.'),
          h('div.row', null, h('button.btn.primary', { type: 'button', onclick: () => o.watch(replay) }, 'Watch the replay and stats'), download, h('button.btn', { type: 'button', onclick: () => o.navigate('#/') }, 'New fight')),
        ),
      ),
    );
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

