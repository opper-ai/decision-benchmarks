import type { TransportHooks } from '../../../../packages/kit/client/transport.ts';
import { modelMaker } from '../../../../packages/kit/shared/models.ts';
import type { Adapter } from '../../shared/adapter.ts';
import { Match } from '../../shared/match.ts';
import { DEFAULT_OPPONENT, MODELS, modelInfo, type ModelInfo } from '../../shared/models.ts';
import type { Track } from '../../shared/question.ts';
import type { FighterMeta, Replay } from '../../shared/replay.ts';
import { downloadReplay, type Me } from '../api.ts';
import { audio } from '../audio.ts';
import { h, money } from '../dom.ts';
import { getKeyboard } from '../input.ts';
import { HUMAN, modelProblem, planFighter, type Plan } from '../players.ts';
import { Stage } from '../stage.ts';
import { SIDES } from '../theme.ts';
import { soundTool } from './audio-toggles.ts';
import { decisionCard, topMoves } from './decisions.ts';
import { fullscreenButton } from './fullscreen.ts';
import { activityDrawer } from './panel.ts';
import { floorLabel, ICONS, stageShell } from './shell.ts';

export const COLORS = [SIDES[0].deep, SIDES[1].deep] as const;
const STORE = 'fighter.setup';
/** A model's answer comes through the game's server, which gives it 2 s; the page waits a little longer. */
const MAX_DEADLINE_MS = 2500;
/** The pair "watch two baselines" plays: the two strongest. */
const BASELINE_PAIR = ['baseline/maximin', 'baseline/greedy'] as const;
/** The baselines a player can fight instead of a model: the three the benchmark uses. */
const PLAYABLE_BASELINES = ['baseline/maximin', 'baseline/payoff', 'baseline/greedy'];

export interface Setup {
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

/** A model's mark in the picker: its initial on a tint per maker (there are no logos yet). */
const TINTS = ['#f5d6ea', '#fde3c8', '#dbe9f7', '#dcefef', '#e8e3f3', '#d9eee2', '#e2f0d6', '#f8e3d6', '#e3e8ee'];
function tint(key: string): string {
  let n = 0;
  for (const c of key) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return TINTS[n % TINTS.length]!;
}

const KEYS: [string[], string][] = [
  [['A', 'D'], 'move, hold back to block'],
  [['W'], 'jump'],
  [['S'], 'block low'],
  [['U', 'I', 'O'], 'punches'],
  [['J', 'K', 'L'], 'kicks'],
  [['H'], 'throw'],
  [['Y'], 'jump kick'],
  [['Space'], 'special'],
];

/** Your keys, in one line: in the picker and under the stage while you fight. */
export function keysStrip(): HTMLElement {
  return h('div.keys-strip', { 'aria-label': 'Your keys' }, ...KEYS.map(([keys, what]) => h('span', null, ...keys.map((k) => h('kbd', null, k)), ` ${what}`)));
}

export interface PickerOptions {
  me: Me;
  hooks: TransportHooks;
  signIn: () => void;
  /** Whether the free credits are used up (the account says so). */
  poolEmpty: boolean;
  close: () => void;
  start: (setup: Setup, plans: [Plan, Plan]) => void;
}

/**
 * "Fight an AI", over the stage as jevman's "Who plays the ghosts?" is in its cabinet: one choice, the opponent, and you
 * fight it in real time. The rest (paused mode, the answer deadline, the track, your side) waits under Advanced. When no
 * model can play for this visitor, an honest line says why, and the free baselines take the models' place.
 */
export function pickerCard(o: PickerOptions): HTMLElement {
  const saved = loadSetup();
  const problem = modelProblem(o.me);
  const models = MODELS.filter((m) => m.kind === 'systemone');
  const baselines = PLAYABLE_BASELINES.map((id) => modelInfo(id));
  let side: 0 | 1 = saved.left !== HUMAN && saved.right === HUMAN ? 1 : 0;
  const savedOpponent = side === 0 ? saved.right : saved.left;
  const playable = (id: string) => baselines.some((m) => m.id === id) || (!problem && models.some((m) => m.id === id));
  let opponent = playable(savedOpponent) ? savedOpponent : problem ? baselines[0]!.id : DEFAULT_OPPONENT;

  const radios: HTMLButtonElement[] = [];
  const pick = (id: string) => {
    opponent = id;
    for (const b of radios) b.setAttribute('aria-checked', String(b.dataset.id === id));
    refresh();
  };
  const radio = (b: HTMLButtonElement, id: string) => {
    b.dataset.id = id;
    b.setAttribute('aria-checked', String(id === opponent));
    b.addEventListener('click', () => pick(id));
    radios.push(b);
    return b;
  };
  const tile = (m: ModelInfo) => {
    const maker = modelMaker(m.id) ?? '';
    return radio(
      h('button.tile', { type: 'button', role: 'radio', title: maker ? `${m.label}, by ${maker}` : m.label }, h('span.mark', { style: { background: tint(maker || m.label) }, 'aria-hidden': 'true' }, m.label.slice(0, 1)), h('span.tile-text', null, h('b', null, m.label), h('small', null, maker))) as HTMLButtonElement,
      m.id,
    );
  };
  const baseChip = (m: ModelInfo) => radio(h('button.chip', { type: 'button', role: 'radio' }, m.label.replace(/ baseline$/, '')) as HTMLButtonElement, m.id);

  const x = h('button.x', { type: 'button', 'aria-label': 'Back to watching', title: 'Back to watching (Esc)', html: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' });
  x.addEventListener('click', o.close);
  const sub = h('p.fnote');
  const go = h('button.fight-go.big', { type: 'button' }, h('span.tri', { 'aria-hidden': 'true' }), 'Fight');
  const pay = h('p.pick-pay');

  // Advanced: closed unless something in it is already set.
  const pausedBox = h('input', { type: 'checkbox', id: 'paused', checked: saved.mode === 'paused' }) as HTMLInputElement;
  const rightBox = h('input', { type: 'checkbox', id: 'right-side', checked: side === 1 }) as HTMLInputElement;
  // Empty = automatic: 2 s in real time, 2.5 s paused.
  const deadline = h('input', { id: 'deadline', type: 'number', min: 300, max: MAX_DEADLINE_MS, step: 100, placeholder: 'auto', value: saved.deadline || '' }) as HTMLInputElement;
  const track = h(
    'select',
    { id: 'track' },
    h('option', { value: 'assisted', selected: saved.track !== 'raw' }, 'Assisted: options show payoffs'),
    h('option', { value: 'raw', selected: saved.track === 'raw' }, 'Raw: situation and rules only'),
  ) as HTMLSelectElement;
  const advOpen = saved.mode === 'paused' || side === 1 || saved.deadline > 0 || saved.track === 'raw';
  const advPanel = h(
    'div.adv',
    { id: 'pick-advanced', hidden: !advOpen },
    h('label.check', { for: 'paused' }, pausedBox, ' Wait for each answer (paused)'),
    h('p.fnote', null, 'The fight stops while the AI thinks, so only its choices count, not its speed. This is how the leaderboard is run.'),
    h('label.check', { for: 'right-side' }, rightBox, ' Play on the right'),
    h('div.fields', null, h('label.field', { for: 'track' }, 'Track', track), h('label.field', { for: 'deadline' }, 'Answer deadline (ms)', deadline)),
    h('p.fnote', null, "Assisted shows each move's payoff against the opponent's likely answers (the benchmark's track). Raw gives only the situation and the rules, a harder test."),
  );
  const advToggle = h(
    'button.adv-toggle',
    { type: 'button', 'aria-controls': 'pick-advanced', 'aria-expanded': String(advOpen) },
    'Advanced',
    h('span.chev', { html: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' }),
  );
  advToggle.addEventListener('click', () => {
    advPanel.hidden = !advPanel.hidden;
    advToggle.setAttribute('aria-expanded', String(!advPanel.hidden));
  });
  rightBox.addEventListener('change', () => {
    side = rightBox.checked ? 1 : 0;
    refresh();
  });

  const begin = (left: string, right: string) => {
    const ps = [planFighter(left, o.me, o.hooks), planFighter(right, o.me, o.hooks)] as [Plan, Plan];
    if (ps.some((p) => p.problem)) return;
    const paused = pausedBox.checked;
    const s: Setup = {
      left,
      right,
      mode: paused ? 'paused' : 'realtime',
      deadline: Number(deadline.value) > 0 ? Math.min(MAX_DEADLINE_MS, Math.max(300, Number(deadline.value))) : paused ? MAX_DEADLINE_MS : 2000,
      track: track.value === 'raw' ? 'raw' : 'assisted',
    };
    try {
      localStorage.setItem(STORE, JSON.stringify({ ...s, deadline: Number(deadline.value) > 0 ? s.deadline : 0 }));
    } catch {
      // storage blocked
    }
    o.start(s, ps);
  };
  go.addEventListener('click', () => (side === 0 ? begin(HUMAN, opponent) : begin(opponent, HUMAN)));

  function refresh(): void {
    sub.textContent = `You're on the ${side === 0 ? 'left' : 'right'}, on the keyboard. Your opponent picks every move it makes.`;
    const isModel = models.some((m) => m.id === opponent);
    go.toggleAttribute('disabled', isModel && Boolean(problem));
    pay.replaceChildren();
    const signInLink = (text: string) => h('button.linkish', { type: 'button', onclick: o.signIn }, text);
    if (!isModel) pay.append('A baseline follows one fixed rule and runs in your browser: free, no model calls.');
    else if (o.me.mode === 'player') pay.append(`On your Opper account${o.me.user?.email ? ` (${o.me.user.email})` : ''}.`);
    else if (o.me.mode === 'dev') pay.append('On the local key from .env.');
    else if (o.me.mode === 'pool') {
      const left = o.me.pool?.remainingUsd;
      pay.append(`Free while Opper's shared credits last${left !== null && left !== undefined ? ` ($${left.toFixed(2)} left)` : ''}.`);
      if (o.me.loginAvailable) pay.append(' ', signInLink('Sign in'), ' to play on your own account.');
    }
  }

  // The honest line when no model can play here: why, the way in, and what is free.
  let warn: HTMLElement | null = null;
  if (problem) {
    warn = h('p.fwarn', { role: 'status' });
    if (o.me.loginAvailable && o.me.mode !== 'player') {
      warn.append(o.poolEmpty || o.me.pool?.open === false ? 'The free credits are used up. ' : 'No decision model can play here without an Opper account. ', h('button.linkish', { type: 'button', onclick: o.signIn }, 'Sign in with Opper'), ' to play one on your own account.');
    } else warn.append(problem);
  }

  const card = h(
    'div.fcard',
    { role: 'dialog', 'aria-label': 'Fight an AI' },
    x,
    h('div.pick-head', null, h('p.fcard-title', null, 'Who do you fight?'), sub),
    warn,
    problem ? null : h('div.opp-grid', { role: 'radiogroup', 'aria-label': 'Decision models' }, ...models.map(tile)),
    h(
      'div.alt-row',
      { role: 'radiogroup', 'aria-label': 'Baselines' },
      h('span', null, problem ? 'Fight a baseline instead, free:' : 'Or a baseline, free:'),
      ...baselines.map(baseChip),
      problem ? h('button.linkish', { type: 'button', onclick: () => begin(BASELINE_PAIR[0], BASELINE_PAIR[1]) }, 'or watch two baselines fight') : null,
    ),
    keysStrip(),
    h('div.go-row', null, go),
    h('div.pick-foot', null, pay, advToggle),
    advPanel,
  );
  refresh();
  return card;
}

export interface LiveOptions {
  /** The page's primary button ("Stop the fight" while it lasts), shown on the stage's floor. */
  cta: HTMLElement;
  /** Opens the replay of the match just played (kept in this page only). */
  watch: (r: Replay) => void;
  /** The same fight again, at once. */
  again: () => void;
  /** Back to the picker, for another opponent. */
  change: () => void;
  /** The match is over (or stopped). */
  ended: () => void;
}

/** A match played live in `host`: the stage, the decisions as they come (in Activity), and at the end its result. */
export function live(host: HTMLElement, s: Setup, plans: [Plan, Plan], o: LiveOptions): () => void {
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
  const stageHost = h('div.fstage');
  const stage = new Stage(stageHost, meta);
  const cover = h('div.stage-cover', null, h('div.cover-card', null, h('div.spinner'), h('div', null, models.length ? `Waking up ${models.join(' and ')}` : 'Getting ready')));
  stageHost.append(cover);
  const feed = h('div.feed');
  const status = h('span.facts');
  const lat: [number[], number[]] = [[], []];

  // A live match cannot pause (the models answer in real time), so its stage takes no clicks; it can go fullscreen.
  const { box, tools } = stageShell(stageHost, floorLabel('Live', meta, true), o.cta);
  const fs = fullscreenButton(box);
  fs.el.className = 'tbtn';
  tools.append(soundTool(), fs.el);
  const modeLine = `${s.mode === 'paused' ? 'paused' : 'real time'} · ${s.track} track · ${s.deadline} ms deadline`;
  const body = h(
    'div.drawer-body',
    null,
    h('div.drawer-head', null, h('div.dtabs', null, h('span.dtab', { 'aria-selected': 'true' }, 'Decisions, newest first')), status),
    h('div.drawer-main.panel-body', null, feed),
  );
  const viewer = h('div.viewer');
  const act = activityDrawer(viewer, body);
  viewer.append(box, act.drawer, act.tab);
  if (human !== null) viewer.append(keysStrip());
  host.replaceChildren(viewer);

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
    status.textContent = `${match.decisions.length} decisions · avg ${avg(lat[0])} / ${avg(lat[1])} ms · ${money(cost)} · ${modeLine}`;
  };
  stage.tick(match.state);

  let stopped = false;
  (async () => {
    const errs = await match.warmUp();
    cover.remove();
    if (errs.length) {
      status.textContent = `Warm-up problem: ${errs.join('; ')}`;
      if (!act.drawer.hidden) act.drawer.scrollIntoView({ block: 'nearest' });
    }
    const replay = await match.run();
    if (stopped) return;
    o.ended();
    // The end card has its own buttons: the floor's would be a second "Fight".
    box.classList.add('ended');
    const floorTag = box.querySelector('.floor-tag');
    floorTag?.classList.remove('live');
    if (floorTag?.lastChild) floorTag.lastChild.textContent = 'Final';
    const again = h('button.fight-go.big', { type: 'button', onclick: o.again }, h('span.tri', { 'aria-hidden': 'true' }), 'Fight again');
    const winner = replay.result.winner;
    stageHost.append(
      h(
        'div.stage-cover.end',
        null,
        h(
          'div.cover-card.end-card',
          null,
          h('p.end-title', null, winner === null ? 'Draw' : `${meta[winner].label} ${meta[winner].kind === 'human' ? 'win' : 'wins'}`),
          h('p.fnote', null, `${replay.decisions.length} decisions · ${money(replay.costUsd)}`),
          h(
            'div.end-btns',
            null,
            again,
            h('button.fbtn.big', { type: 'button', onclick: () => o.watch(replay) }, 'Watch the replay'),
            h('button.fbtn.big', { type: 'button', title: 'The whole match as a gzipped JSON recording (.fight.json.gz)', onclick: () => void downloadReplay(replay) }, h('span.ico', { html: ICONS.download }), 'Download'),
          ),
          h('p.fnote', null, 'This match stays in your browser: download it to keep it. ', h('button.linkish', { type: 'button', onclick: o.change }, 'Change opponent')),
        ),
      ),
    );
    again.focus({ preventScroll: true });
  })();

  audio.scene(true);
  if (human !== null) {
    // Space would otherwise press whichever button has focus.
    (document.activeElement as HTMLElement | null)?.blur();
    getKeyboard().start();
  }
  return () => {
    stopped = true;
    if (human !== null) getKeyboard().stop();
    audio.scene(false);
    fs.destroy();
    match.stop();
    stage.destroy();
  };
}
