import { accountNotice, fetchMe, POOL_EMPTY_NOTICE, renderAccount, renderDrawerAccount, signIn, takeAuthError, updatePoolAmount, walletNotice, type AccountView } from '../../../packages/kit/client/auth.ts';
import { enterScore, fetchHighScores, placeFor, type Boards } from '../../../packages/kit/client/highscores.ts';
import { loadLeaderboard } from '../../../packages/kit/client/leaderboard.ts';
import { appPath } from '../../../packages/kit/client/paths.ts';
import { fetchSeed } from '../../../packages/kit/client/seeds.ts';
import { tag, track, trackClicks } from '../../../packages/kit/client/track.ts';
import { createHttpTransport, warmUp, type TransportHooks } from '../../../packages/kit/client/transport.ts';
import { DECISION_MODELS, DEFAULT_MODEL, isModelId, modelName } from '../../../packages/kit/shared/models.ts';
import { baselineName, baselineTransport, BASELINE_NAMES, isBaselineId, type BaselineName } from '../shared/baselines.ts';
import { createGame, moveToward, step, type GameState, type Heading, type Move } from '../shared/engine.ts';
import { BOARD, moveLetter, type PlayerRecording } from '../shared/player-check.ts';
import { DEFAULT_SPEED, isRaceSpeed, RACE_SPEEDS, RealtimeSnake, SPEED_NAMES, SPEED_STEP_MS, startClock, type RaceSpeed } from '../shared/race.ts';
import { loadDemo, RECORDINGS, type Demo, type DemoEntry } from './recordings.ts';
import { AI, drawBoard, PLAYER } from './render.ts';

trackClicks(appPath('/'), 'snake');

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const el = <K extends keyof HTMLElementTagNameMap>(tagName: K, text?: string, cls?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tagName);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
/** Watch replays a recording at this pace. */
const WATCH_STEP_MS = 90;
const OPPONENT_KEY = 'snake.opponent';
const SPEED_KEY = 'snake.speed';
const KEYS: Record<string, Heading> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right' };

// ---------- the opper.ai chrome: the phone menu, the account, the theme ----------
const drawer = $('#oc-drawer');
const menuButton = document.getElementById('oc-menu-button');
const setDrawer = (open: boolean) => {
  drawer.hidden = !open;
  menuButton?.setAttribute('aria-expanded', String(open));
};
menuButton?.addEventListener('click', () => setDrawer(drawer.hidden !== false));
const famToggle = $<HTMLButtonElement>('#oc-fam-toggle');
famToggle.addEventListener('click', () => {
  const open = famToggle.getAttribute('aria-expanded') !== 'true';
  famToggle.setAttribute('aria-expanded', String(open));
  $('#oc-fam').hidden = !open;
});
drawer.addEventListener('click', (e) => {
  if ((e.target as Element).closest('[data-close], a')) setDrawer(false);
});
// The theme follows the system while the visitor hasn't picked one on opper.ai (index.html sets it before the first paint).
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  let picked: string | null = null;
  try {
    picked = localStorage.getItem('theme');
  } catch {
    // storage blocked: follow the system
  }
  if (picked !== 'dark' && picked !== 'light') document.documentElement.classList.toggle('dark', e.matches);
});

const me = await fetchMe();
const authError = takeAuthError();
const accountEl = $('#account');
let account: AccountView = { kind: me.mode === 'player' ? 'player' : me.mode === 'pool' ? 'pool' : me.mode === 'dev' ? 'dev' : me.pool ? 'pool-empty' : 'signed-out', me };
const showAccount = (view: AccountView) => {
  account = view;
  renderAccount(accountEl, view);
  renderDrawerAccount($('#oc-drawer-account'), view);
};
showAccount({ ...account, notice: accountNotice(me, authError, false) });
if (me.mode === 'pool') {
  setInterval(() => {
    if (document.hidden || account.kind !== 'pool') return;
    void fetchMe().then((fresh) => {
      if (account.kind !== 'pool') return;
      if (fresh.mode === 'pool') {
        updatePoolAmount(accountEl, fresh.pool?.remainingUsd ?? null);
        updatePoolAmount($('#oc-drawer-account'), fresh.pool?.remainingUsd ?? null);
      } else if (fresh.mode === 'none' && fresh.pool && !fresh.unavailable) showAccount({ kind: 'pool-empty', me: fresh });
    });
  }, 60_000);
}

/** Whether a decision model can be paid for: the free credits, a signed-in player's wallet, or a local key. */
let canUseAI = me.mode !== 'none';
// Signed out, every listed model shows (to sign in for); a key lists the ones it can play.
const models = (me.models ?? DECISION_MODELS.map((m) => m.id)).filter(isModelId);
const hooks: TransportHooks = {
  onSignedOut: () => {
    canUseAI = false;
    showAccount({ kind: 'signed-out', me, notice: 'Signed out. Sign in to race a decision model.' });
  },
  onPoolEmpty: () => {
    canUseAI = false;
    showAccount({ kind: 'pool-empty', me, notice: POOL_EMPTY_NOTICE });
  },
  onWalletEmpty: (url) => showAccount({ ...account, ...walletNotice(url) }),
};
const transport = createHttpTransport(hooks);

// ---------- the boards ----------
const arena = $('#arena');
const tvYou = $('#tv-you');
const aiCtx = $<HTMLCanvasElement>('#canvas-ai').getContext('2d')!;
const youCtx = $<HTMLCanvasElement>('#canvas-you').getContext('2d')!;
const aiLabel = $('#ai-label');
const aiScore = $('#ai-score');
const aiSteps = $('#ai-steps');
const youScore = $('#you-score');
const youSteps = $('#you-steps');
const hiScore = $('#hi-score');
const hiTip = $('#hi-tip');
const overlay = $('#overlay');
const playCta = $<HTMLButtonElement>('#play-cta');
const playLabel = $('#play-label');
const swipePad = $('#swipe-pad');
const noticeEl = $('#notice');
const touchScreen = matchMedia('(pointer: coarse)').matches;

const banner = (which: 'ai' | 'you', text: string | null, over = false) => {
  const b = $(`#banner-${which}`);
  b.textContent = text ?? '';
  b.hidden = !text;
  b.classList.toggle('over', over);
};
const showAi = (s: GameState | null, label?: string) => {
  drawBoard(aiCtx, s, AI);
  if (label !== undefined) aiLabel.textContent = label;
  aiScore.textContent = String(s?.apples ?? 0);
  aiSteps.textContent = String(s?.steps ?? 0);
};
const showYou = (s: GameState) => {
  drawBoard(youCtx, s, PLAYER);
  youScore.textContent = String(s.apples);
  youSteps.textContent = String(s.steps);
};
let noticeTimer = 0;
const notice = (content: string | Node | null, ms = 12_000) => {
  noticeEl.replaceChildren(...(content === null ? [] : [content]));
  noticeEl.hidden = content === null;
  clearTimeout(noticeTimer);
  if (content !== null && ms) noticeTimer = window.setTimeout(() => (noticeEl.hidden = true), ms);
};
showAi(null);

// ---------- the players' high scores ----------
let boards: Boards | null = null;
const hsList = $('#hs-list');
function showHighScores(): void {
  const list = boards?.[BOARD] ?? [];
  hiScore.textContent = String(list[0]?.score ?? 0);
  hiTip.textContent = list[0] ? `${list[0].initials}: ${list[0].score} apples` : 'No high score yet';
  if (!boards) {
    hsList.replaceChildren(el('li', 'The high scores are not available right now.', 'none'));
    return;
  }
  if (!list.length) {
    hsList.replaceChildren(el('li', 'No scores yet: race an AI and put yours first.', 'none'));
    return;
  }
  hsList.replaceChildren(
    ...list.map((l, i) => {
      const li = el('li');
      li.append(el('span', String(i + 1), 'rk'), el('span', l.initials), el('b', String(l.score)));
      return li;
    }),
  );
}
void fetchHighScores().then((view) => {
  boards = view?.boards ?? null;
  showHighScores();
});

// ---------- the leaderboard ----------
void loadLeaderboard($<HTMLTableElement>('#leaderboard-table'), appPath, { metric: 'Apples (mean ± margin)' });

// ---------- Watch: recorded games only ----------
const demos = new Map<string, Promise<Demo | null>>();
const demoFor = (e: DemoEntry) => {
  let p = demos.get(e.model);
  if (!p) {
    p = loadDemo(appPath(`/${e.path}`));
    demos.set(e.model, p);
    void p.then((d) => d ?? demos.delete(e.model));
  }
  return p;
};
let watching: DemoEntry = RECORDINGS[0]!;
/** Bumped to stop whatever loop runs (a recording, a race). */
let run = 0;
const chipsEl = $('#watch-chips');
function renderChips(): void {
  chipsEl.replaceChildren(
    ...RECORDINGS.map((e) => {
      const b = el('button', undefined, 'chip');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(e.model === watching.model));
      b.append(el('span', e.name));
      const sub = el('span', '', 'sub');
      void demoFor(e).then((d) => (sub.textContent = d ? `${d.final.apples}` : ''));
      b.append(sub);
      b.addEventListener('click', () => {
        if (mode === 'race') return;
        watching = e;
        renderChips();
        void watch();
      });
      return tag(b, 'click_watch', { source: e.model });
    }),
  );
}

type Mode = 'watch' | 'race';
let mode: Mode = 'watch';

async function watch(): Promise<void> {
  const mine = ++run;
  mode = 'watch';
  overlay.hidden = true;
  arena.classList.remove('racing');
  tvYou.hidden = true;
  swipePad.hidden = true;
  setCta('play');
  banner('ai', null);
  const entry = watching;
  showAi(null, entry.name);
  const demo = await demoFor(entry);
  if (mine !== run) return;
  if (!demo) {
    banner('ai', "This recording didn't load");
    return;
  }
  for (;;) {
    let s = createGame(demo.seed);
    showAi(s, entry.name);
    banner('ai', null);
    for (const m of demo.moves) {
      await sleep(WATCH_STEP_MS);
      if (mine !== run) return;
      s = step(s, m);
      showAi(s);
    }
    banner('ai', `Game over: ${s.apples} apples`, true);
    await sleep(3000);
    if (mine !== run) return;
  }
}

// ---------- Play: you and an AI, side by side on the same board ----------
function setCta(kind: 'play' | 'stop'): void {
  playCta.classList.toggle('stop', kind === 'stop');
  playLabel.textContent = kind === 'play' ? 'Race an AI' : 'Stop';
}

const storedOpponent = (() => {
  try {
    return localStorage.getItem(OPPONENT_KEY);
  } catch {
    return null;
  }
})();
let opponent: string = storedOpponent && (isBaselineId(storedOpponent) || (canUseAI && models.includes(storedOpponent as never))) ? storedOpponent : canUseAI ? (me.defaultModel && isModelId(me.defaultModel) ? me.defaultModel : DEFAULT_MODEL) : 'baseline/flood';
let speed: RaceSpeed = (() => {
  try {
    const v = localStorage.getItem(SPEED_KEY);
    return isRaceSpeed(v) ? v : DEFAULT_SPEED;
  } catch {
    return DEFAULT_SPEED;
  }
})();
const stepsASecond = (sp: RaceSpeed) => String(Math.round((1000 / SPEED_STEP_MS[sp]) * 10) / 10);
const opponentName = (id: string) => (isBaselineId(id) ? baselineName(id) : modelName(id));

function showPicker(): void {
  const card = el('div', undefined, 'card arc');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Pick the AI to race');
  const x = el('button', 'X', 'x');
  x.type = 'button';
  x.setAttribute('aria-label', 'Close');
  x.addEventListener('click', () => void watch());
  card.append(x, el('p', 'Race an AI on the same board', 'ttl'));
  const list = el('ul', undefined, 'roster');
  const option = (id: string, label: string, note: string, enabled: boolean) => {
    const li = el('li');
    const b = el('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(id === opponent));
    if (!enabled) b.setAttribute('aria-disabled', 'true');
    b.append(el('span', label, 'nm'), el('span', '', 'lead'), el('span', note, 'tagline'));
    b.addEventListener('click', () => {
      if (!enabled) return;
      opponent = id;
      try {
        localStorage.setItem(OPPONENT_KEY, id);
      } catch {
        // not remembered
      }
      showPicker();
    });
    li.append(b);
    return li;
  };
  list.append(el('li', undefined, 'colh'));
  list.lastElementChild!.append(el('span', 'Decision models'), el('span', canUseAI ? 'via Opper' : 'sign in'));
  for (const id of models) list.append(option(id, modelName(id), '', canUseAI));
  const bh = el('li', undefined, 'colh');
  bh.append(el('span', 'Baselines'), el('span', 'free'));
  list.append(bh);
  for (const n of BASELINE_NAMES) list.append(option(`baseline/${n}`, baselineName(`baseline/${n}`), 'script', true));
  card.append(list);
  if (!canUseAI) {
    const tap = el('p', undefined, 'tap warn');
    const why = account.kind === 'pool-empty' ? 'The free credits are used up.' : 'No decision model can play here without an Opper account.';
    tap.append(`${why} `);
    if (me.loginAvailable) {
      const login = el('button', 'Sign in with Opper');
      login.type = 'button';
      login.addEventListener('click', signIn);
      tap.append(login, ' to race one on your own account, or race a baseline: they are free.');
    } else tap.append('Race a baseline: they are free.');
    card.append(tap);
  }
  const speeds = el('div', undefined, 'speeds');
  speeds.setAttribute('role', 'radiogroup');
  speeds.setAttribute('aria-label', 'Speed');
  speeds.append(el('span', 'Speed', 'speeds-h'));
  for (const sp of RACE_SPEEDS) {
    const b = el('button', SPEED_NAMES[sp]);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(sp === speed));
    b.addEventListener('click', () => {
      speed = sp;
      try {
        localStorage.setItem(SPEED_KEY, sp);
      } catch {
        // not remembered
      }
      showPicker();
    });
    speeds.append(b);
  }
  card.append(speeds);
  card.append(el('p', `Both boards move ${stepsASecond(speed)} steps a second. Faster speeds give the AI less time to think.`, 'tap'));
  card.append(el('p', touchScreen ? 'Swipe to steer.' : 'Arrow keys or WASD to steer.', 'tap'));
  const press = el('button', undefined, 'press');
  press.type = 'button';
  press.append(el('span', '', 'tri'), el('span', 'Press start'));
  press.addEventListener('click', () => void race(opponent));
  card.append(press);
  overlay.replaceChildren(card);
  overlay.hidden = false;
  press.focus();
}

playCta.addEventListener('click', () => {
  if (mode === 'race') return void watch();
  run += 1; // the recording pauses under the picker
  showPicker();
});

/** Directions keyed or swiped while racing, oldest first (two at most, so a quick double turn works). */
let queued: Heading[] = [];
const steer = (h: Heading) => {
  if (mode !== 'race') return;
  if (queued.length < 2) queued.push(h);
};
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!drawer.hidden) return setDrawer(false);
    if (mode === 'race' || !overlay.hidden) return void watch();
  }
  if (mode !== 'race' || e.altKey || e.ctrlKey || e.metaKey) return;
  const h = KEYS[e.key];
  if (!h) return;
  if (e.target instanceof Element && e.target.closest('input, textarea')) return;
  e.preventDefault();
  steer(h);
});
/** Swipes on your board or the strip under it. */
for (const area of [tvYou, swipePad]) {
  let start: { x: number; y: number } | null = null;
  area.addEventListener('pointerdown', (e) => (start = { x: e.clientX, y: e.clientY }));
  area.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.hypot(dx, dy) < 24) return;
    steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
    start = { x: e.clientX, y: e.clientY };
  });
  for (const end of ['pointerup', 'pointercancel', 'pointerleave'] as const) area.addEventListener(end, () => (start = null));
}

/** Your next step: the oldest keyed direction that isn't a U-turn, else straight on. */
function yourMove(s: GameState): Move {
  while (queued.length) {
    const m = moveToward(s.heading, queued.shift()!);
    if (m) return m;
  }
  return 'straight';
}

async function race(id: string): Promise<void> {
  const mine = ++run;
  mode = 'race';
  overlay.hidden = true;
  arena.classList.add('racing');
  tvYou.hidden = false;
  swipePad.hidden = !touchScreen;
  setCta('stop');
  queued = [];
  notice(null);
  const name = opponentName(id);
  const baseline = isBaselineId(id);
  const sp = speed;
  track('play_start', { game: 'snake', opponent: id, speed: sp });
  showYou(createGame(0));
  showAi(null, name);
  banner('you', 'Get ready');
  // A sleepy model would answer its first questions too late: wake it while the board is dealt.
  banner('ai', baseline ? 'Get ready' : `Waking up ${name}`);
  const [issued, warm] = await Promise.all([fetchSeed(), baseline ? Promise.resolve({ ok: true } as const) : warmUp(id, hooks)]);
  if (mine !== run) return;
  if (!warm.ok) {
    notice(warm.account ? warm.error : `${name} didn't wake up in time. Try again, or race a baseline.`);
    return void watch();
  }
  const seed = issued?.seed ?? Math.floor(Math.random() * 2 ** 31);
  if (!issued) notice("The server didn't deal this board, so this game can't go on the high scores. Have fun anyway.");
  const start = createGame(seed);
  showYou(start);
  showAi(start, name);
  for (const n of ['3', '2', '1']) {
    banner('you', n);
    banner('ai', n);
    await sleep(600);
    if (mine !== run) return;
  }
  banner('you', null);
  banner('ai', null);
  // One clock for both boards: each tick steps you, then the AI (with its answer if it is in, else the fallback).
  const ai = new RealtimeSnake({
    transport: baseline ? baselineTransport(id.slice('baseline/'.length) as BaselineName) : transport,
    seed,
    ...(baseline ? {} : { requestModel: id }),
    timeoutMs: 2000,
  });
  let you = start;
  let moves = '';
  let told = false;
  await new Promise<void>((resolve) => {
    startClock(SPEED_STEP_MS[sp], () => {
      if (mine !== run) {
        ai.stop();
        resolve();
        return false;
      }
      if (!you.over) {
        const move = yourMove(you);
        you = step(you, move);
        moves += moveLetter(move);
        showYou(you);
        if (you.over) banner('you', `Game over: ${you.apples} apples`, true);
      }
      if (!ai.over) {
        ai.tick();
        showAi(ai.state);
        if (ai.over) banner('ai', `Game over: ${ai.state.apples} apples`, true);
      }
      if (you.over && !ai.over && !told) {
        told = true;
        notice(`${name} is still playing.`, 0);
      }
      if (you.over && ai.over) {
        resolve();
        return false;
      }
      return true;
    });
  });
  if (mine !== run) return;
  notice(null);
  track('play_end', { game: 'snake', opponent: id, speed: sp, apples: String(you.apples) });
  showResult(id, { state: you, moves }, ai.state.apples, issued?.token ?? null, sp, { fallbacks: ai.fallbacks, steps: ai.steps.length });
}

function showResult(id: string, you: { state: GameState; moves: string }, aiApples: number | null, token: string | null, sp: RaceSpeed, aiSteps: { fallbacks: number; steps: number }): void {
  mode = 'watch';
  setCta('play');
  swipePad.hidden = true;
  const name = opponentName(id);
  const card = el('div', undefined, 'card arc');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Result');
  const youWin = aiApples === null || you.state.apples > aiApples;
  const tie = aiApples !== null && you.state.apples === aiApples;
  card.append(el('p', tie ? 'A tie' : youWin ? 'You win' : `${name} wins`, 'over-title'));
  const vs = el('ul', undefined, 'versus');
  const line = (who: string, apples: number | null, win: boolean) => {
    const li = el('li', undefined, win ? 'win' : undefined);
    li.append(el('span', who), el('span', '', 'lead'), el('span', apples === null ? '-' : String(apples)));
    return li;
  };
  vs.append(line('You', you.state.apples, youWin && !tie), line(name, aiApples, !youWin && !tie));
  card.append(vs);
  const late = aiSteps.fallbacks ? ` ${name} was late on ${aiSteps.fallbacks} of ${aiSteps.steps} steps.` : '';
  card.append(el('p', `${SPEED_NAMES[sp]} speed, ${stepsASecond(sp)} steps a second.${late}`, 'tap'));
  const score = you.state.apples;
  const place = token ? placeFor(boards, BOARD, score) : null;
  if (token && place !== null) {
    const made = el('div', undefined, 'made');
    made.append(el('p', place === 1 ? 'A new high score' : `Your apples make #${place}`, 'made-title'));
    const form = el('form', undefined, 'initials');
    const input = el('input');
    input.maxLength = 3;
    input.placeholder = 'AAA';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Your initials, three letters');
    const send = el('button', 'Enter', 'press');
    send.type = 'submit';
    const status = el('p', 'Your initials, three letters', 'tap');
    form.append(input, send);
    made.append(form, status);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const initials = input.value.toUpperCase().replace(/[^A-Z]/g, '');
      if (initials.length !== 3) {
        status.textContent = 'Three letters, A to Z';
        return;
      }
      send.setAttribute('aria-disabled', 'true');
      status.textContent = 'Checking your game';
      const recording: PlayerRecording = { format: 1, game: 'snake', seedToken: token, moves: you.moves };
      void enterScore(BOARD, initials, recording).then((r) => {
        send.removeAttribute('aria-disabled');
        if (!r.ok) {
          status.textContent = r.error;
          return;
        }
        boards = r.boards;
        showHighScores();
        status.textContent = r.place ? `You're #${r.place} on the board` : 'Saved, but it no longer makes the top ten';
        form.hidden = true;
      });
    });
    card.append(made);
    queueMicrotask(() => input.focus());
  } else if (token && score > 0) card.append(el('p', 'Not enough apples for the top ten this time.', 'tap'));
  const btns = el('div', undefined, 'over-btns');
  const again = el('button', undefined, 'press');
  again.type = 'button';
  again.append(el('span', '', 'tri'), el('span', 'Race again'));
  again.addEventListener('click', () => void race(id));
  const back = el('button', 'Watch', 'press alt');
  back.type = 'button';
  back.addEventListener('click', () => void watch());
  btns.append(again, back);
  card.append(btns);
  overlay.replaceChildren(card);
  overlay.hidden = false;
  if (!(token && place !== null)) again.focus();
}

renderChips();
void watch();
