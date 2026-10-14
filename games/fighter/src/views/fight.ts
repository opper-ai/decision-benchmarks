import type { TransportHooks } from '../../../../packages/kit/client/transport.ts';
import { modelMaker } from '../../../../packages/kit/shared/models.ts';
import type { Adapter } from '../../shared/adapter.ts';
import { BASELINE_THINK_MS } from '../../shared/baselines.ts';
import { Match } from '../../shared/match.ts';
import { DEFAULT_OPPONENT, MODELS, modelInfo } from '../../shared/models.ts';
import type { Track } from '../../shared/question.ts';
import type { FighterMeta, Replay } from '../../shared/replay.ts';
import type { Me } from '../api.ts';
import { audio } from '../audio.ts';
import { h, money } from '../dom.ts';
import { getKeyboard } from '../input.ts';
import { logoFor } from '../logos.ts';
import { HUMAN, modelProblem, planFighter, type Plan } from '../players.ts';
import { Stage } from '../stage.ts';
import { SIDES } from '../theme.ts';
import { soundTool } from './audio-toggles.ts';
import { decisionCard, topMoves } from './decisions.ts';
import { fullscreenButton } from './fullscreen.ts';
import { activityDrawer } from './panel.ts';
import { videoButton } from './save.ts';
import { floorLabel, stageShell } from './shell.ts';

export const COLORS = [SIDES[0].deep, SIDES[1].deep] as const;
const STORE = 'fighter.setup';
/** A model's answer comes through the game's server, which gives it 2 s; the page waits a little longer. */
const MAX_DEADLINE_MS = 2500;

export interface Setup {
  left: string;
  right: string;
  mode: 'realtime' | 'paused';
  deadline: number;
  track: Track;
}

const known = (id: unknown): id is string => id === HUMAN || MODELS.some((m) => m.id === id);

function loadSetup(): Setup {
  // The benchmark's settings: real time, raw track, the 2 s deadline (deadline 0 = automatic).
  const fallback: Setup = { left: HUMAN, right: DEFAULT_OPPONENT, mode: 'realtime', deadline: 0, track: 'raw' };
  try {
    const s = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Partial<Setup> | null;
    if (s && known(s.left) && known(s.right)) return { ...fallback, ...s, mode: s.mode === 'paused' ? 'paused' : 'realtime', track: s.track === 'assisted' ? 'assisted' : 'raw', deadline: Number(s.deadline) || 0 };
  } catch {
    // storage blocked
  }
  return fallback;
}

/** The mark of a model without a maker's logo (logos.ts) in the picker: its initial on a tint per maker. */
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

/** Your keys, in one line, under the stage while you fight. */
export function keysStrip(): HTMLElement {
  return h('div.keys-strip', { 'aria-label': 'Your keys' }, ...KEYS.map(([keys, what]) => h('span', null, ...keys.map((k) => h('kbd', null, k)), ` ${what}`)));
}

/**
 * The same keys on the picker, before the fight starts: moving on one line, attacking on the next. The fight has no
 * touch controls, so a touch screen is told it needs a keyboard.
 */
function keysLegend(): HTMLElement {
  const group = (title: string, keys: typeof KEYS) =>
    h('div.keys-group', null, h('span.keys-title', null, title), h('span.keys-row', null, ...keys.map(([ks, what]) => h('span.key', null, ...ks.map((k) => h('kbd', null, k)), what))));
  const legend = h('div.pick-keys', { role: 'group', 'aria-label': 'Controls' }, group('Move', KEYS.slice(0, 3)), group('Attack', KEYS.slice(3)));
  if (matchMedia('(pointer: coarse)').matches) legend.append(h('p.keys-note', null, 'You fight on a keyboard: this game has no touch controls.'));
  return legend;
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
 * "Fight an AI", over the stage as jevman's "Who plays the ghosts?" is in its cabinet: pick a decision model, then fight
 * it in real time on the keyboard. Only models: you fight a decision model, never a script. Paused mode, your side,
 * the track and the deadline wait, closed, under Advanced. When no model can play for this visitor the models still
 * show, and the button asks them to sign in, or a line says why not.
 */
export function pickerCard(o: PickerOptions): HTMLElement {
  const saved = loadSetup();
  const problem = modelProblem(o.me);
  const models = MODELS.filter((m) => m.kind === 'systemone');
  const savedSide: 0 | 1 = saved.left !== HUMAN && saved.right === HUMAN ? 1 : 0;
  const savedOpponent = savedSide === 0 ? saved.right : saved.left;
  let opponent = models.some((m) => m.id === savedOpponent) ? savedOpponent : DEFAULT_OPPONENT;

  /** The maker's logo (jevman's), or the model's initial on a tint for a model without one. */
  const markFor = (id: string, label: string, maker: string) => {
    const logo = logoFor(id);
    if (!logo) return h('span.mark', { style: { background: tint(maker || label) }, 'aria-hidden': 'true' }, label.slice(0, 1));
    return h(logo.classList.contains('round') || logo.classList.contains('square') ? 'span.mark.fill' : 'span.mark.boxed', { 'aria-hidden': 'true' }, logo);
  };
  const tiles = models.map((m) => {
    const maker = modelMaker(m.id) ?? '';
    const b = h(
      'button.tile',
      { type: 'button', role: 'radio', 'aria-checked': String(m.id === opponent), title: maker ? `${m.label}, by ${maker}` : m.label },
      markFor(m.id, m.label, maker),
      h('span.tile-text', null, h('b', null, m.label), h('small', null, maker)),
    );
    b.addEventListener('click', () => {
      opponent = m.id;
      tiles.forEach((t, k) => t.setAttribute('aria-checked', String(models[k]!.id === opponent)));
    });
    return b;
  });

  const x = h('button.x', { type: 'button', 'aria-label': 'Back to watching', title: 'Back to watching (Esc)', html: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' });
  x.addEventListener('click', o.close);

  // Advanced, closed: the mode, your side, the track (a switch each) and the deadline (empty = automatic: 2 s, 2.5 s
  // paused).
  const choice = <T extends string>(label: string, options: [T, string, string?][], value: T) => {
    let current = value;
    const buttons = options.map(([v, text, title]) => {
      const b = h('button.seg-opt', { type: 'button', role: 'radio', 'aria-checked': String(v === current), title });
      b.textContent = text;
      b.addEventListener('click', () => {
        current = v;
        buttons.forEach((x, k) => x.setAttribute('aria-checked', String(options[k]![0] === v)));
      });
      return b;
    });
    return { el: h('div.seg', { role: 'radiogroup', 'aria-label': label }, ...buttons), get: () => current };
  };
  const mode = choice('Mode', [['realtime', 'Real time'], ['paused', 'Paused', 'The fight waits for each answer']], saved.mode);
  const side = choice('Your side', [['left', 'Left'], ['right', 'Right']], savedSide === 1 ? 'right' : 'left');
  const track = choice('Track', [['raw', 'Raw', 'The situation and the rules only: the benchmark\'s track'], ['assisted', 'Assisted', "Each option shows its payoff against the opponent's likely answers"]], saved.track === 'assisted' ? 'assisted' : 'raw');
  const deadline = h('input', { id: 'deadline', type: 'number', min: 300, max: MAX_DEADLINE_MS, step: 100, placeholder: 'auto', value: saved.deadline || '' }) as HTMLInputElement;
  const row = (label: string, control: HTMLElement, forId?: string) => [h('label.adv-label', forId ? { for: forId } : null, label), control];
  const advPanel = h(
    'div.adv',
    { id: 'pick-advanced', hidden: true },
    ...row('Mode', mode.el),
    ...row('Your side', side.el),
    ...row('Track', track.el),
    ...row('Answer deadline', h('span.deadline', null, deadline, 'ms'), 'deadline'),
  );
  const advToggle = h(
    'button.adv-toggle',
    { type: 'button', 'aria-controls': 'pick-advanced', 'aria-expanded': 'false' },
    'Advanced',
    h('span.chev', { html: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' }),
  );
  advToggle.addEventListener('click', () => {
    advPanel.hidden = !advPanel.hidden;
    advToggle.setAttribute('aria-expanded', String(!advPanel.hidden));
  });

  const begin = () => {
    const [left, right] = side.get() === 'right' ? [opponent, HUMAN] : [HUMAN, opponent];
    const ps = [planFighter(left, o.me, o.hooks), planFighter(right, o.me, o.hooks)] as [Plan, Plan];
    if (ps.some((p) => p.problem)) return;
    const paused = mode.get() === 'paused';
    const s: Setup = {
      left,
      right,
      mode: paused ? 'paused' : 'realtime',
      deadline: Number(deadline.value) > 0 ? Math.min(MAX_DEADLINE_MS, Math.max(300, Number(deadline.value))) : paused ? MAX_DEADLINE_MS : 2000,
      track: track.get(),
    };
    try {
      localStorage.setItem(STORE, JSON.stringify({ ...s, deadline: Number(deadline.value) > 0 ? s.deadline : 0 }));
    } catch {
      // storage blocked
    }
    o.start(s, ps);
  };

  // The button and one line under it: who pays, or how to get in, or why no model can play.
  const go = h('button.fight-go.big', { type: 'button' });
  const pay = h('p.pick-pay');
  const signIn = (text: string) => h('button.linkish', { type: 'button', onclick: o.signIn }, text);
  if (problem && o.me.loginAvailable && o.me.mode !== 'player') {
    go.append('Sign in to fight');
    go.addEventListener('click', o.signIn);
    pay.append(o.poolEmpty || o.me.pool?.open === false ? 'The free credits are used up: fight on your own Opper account.' : 'Fights run on your own Opper account.');
  } else if (problem) {
    go.append(h('span.tri', { 'aria-hidden': 'true' }), 'Fight');
    go.disabled = true;
    pay.append(o.me.unavailable ? "Couldn't reach the server. Try again in a moment." : 'No model can play on this server right now.');
  } else {
    go.append(h('span.tri', { 'aria-hidden': 'true' }), 'Fight');
    go.addEventListener('click', begin);
    if (o.me.mode === 'player') pay.append(`On your Opper account${o.me.user?.email ? ` (${o.me.user.email})` : ''}.`);
    else if (o.me.mode === 'dev') pay.append('On the local key from .env.');
    else {
      const left = o.me.pool?.remainingUsd;
      pay.append(`Free while Opper's credits last${left !== null && left !== undefined ? ` ($${left.toFixed(2)} left)` : ''}.`);
      if (o.me.loginAvailable) pay.append(' ', signIn('Sign in'), ' to use your own.');
    }
  }

  return h(
    'div.fcard',
    { role: 'dialog', 'aria-label': 'Fight an AI' },
    x,
    h('div.pick-head', null, h('p.fcard-title', null, 'Who do you fight?'), h('p.fnote', null, 'Pick an AI model. It picks every move; you fight it on the keyboard.')),
    h('div.opp-grid', { role: 'radiogroup', 'aria-label': 'AI models' }, ...tiles),
    keysLegend(),
    h('div.go-row', null, go),
    h('div.pick-foot', null, pay, advToggle),
    advPanel,
  );
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
    adapters: plans.map((p) => p.adapter(s.mode === 'realtime' ? BASELINE_THINK_MS : 0)) as [Adapter, Adapter],
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
  const { box, frame, tools } = stageShell(stageHost, floorLabel('Live', meta, true), o.cta);
  const fs = fullscreenButton(box);
  fs.el.className = 'tbtn';
  tools.append(soundTool(), fs.el);
  const modeLine = `${s.mode === 'paused' ? 'paused' : 'real time'} · ${s.track} track · ${s.deadline} ms deadline`;
  const body = h(
    'div.drawer-body',
    null,
    // One list while the match lasts: a heading, not a tab that looks pressable.
    h('div.drawer-head', null, h('p.kicker', null, 'Decisions, newest first'), status),
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
        // The question was answered, or dropped (a new round).
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
    // Over the stage and its floor; on a phone, whose 4:3 stage is too short for it, under the stage (style.css).
    frame.append(
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
            videoButton(replay, 'end-card', 'big'),
          ),
          h('p.fnote', null, "This match isn't saved anywhere: save its video to keep it. ", h('button.linkish', { type: 'button', onclick: o.change }, 'Change opponent')),
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
