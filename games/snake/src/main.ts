import { accountNotice, fetchMe, renderAccount, renderDrawerAccount, takeAuthError, updatePoolAmount, type AccountView } from '../../../packages/kit/client/auth.ts';
import { enterScore, fetchHighScores, placeFor, type Boards } from '../../../packages/kit/client/highscores.ts';
import { fmt, loadLeaderboard, type Row } from '../../../packages/kit/client/leaderboard.ts';
import { logoFor } from '../../../packages/kit/client/logos.ts';
import { appPath } from '../../../packages/kit/client/paths.ts';
import { fetchSeed } from '../../../packages/kit/client/seeds.ts';
import { tag, track, trackClicks } from '../../../packages/kit/client/track.ts';
import { createGame, moveToward, step, type GameState, type Heading, type Move } from '../shared/engine.ts';
import { STEP_MS, startClock } from '../shared/play.ts';
import { BOARD, moveLetter, type PlayerRecording } from '../shared/player-check.ts';
import { CLIPS } from './clips.ts';
import { WATCH_STEP_MS } from './highlight.ts';
import { loadDemo, RECORDINGS, type Demo, type DemoEntry } from './recordings.ts';
import { AI, drawBoard, PLAYER, type Palette } from './render.ts';

trackClicks(appPath('/'), 'snake');

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const el = <K extends keyof HTMLElementTagNameMap>(tagName: K, text?: string, cls?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tagName);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
/** "Clef's", but "GPT-6 Luna Decisions'". */
const possessive = (name: string) => (name.endsWith('s') ? `${name}'` : `${name}'s`);
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

// The header's account, as on every opper.ai page. Playing Snake needs none: no model plays for a visitor here.
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

// ---------- the board: a model's recorded game (Watch), or yours (Play) ----------
const tv = $('#tv');
const board = $('#board');
const ctx = $<HTMLCanvasElement>('#canvas').getContext('2d')!;
const plateLabel = $('#plate-label');
const scoreEl = $('#score');
const stepsEl = $('#steps');
const hiScore = $('#hi-score');
const hiTip = $('#hi-tip');
const bannerEl = $('#banner');
const overlay = $('#overlay');
const saveBtn = $<HTMLButtonElement>('#save');
const saveMenu = $('#save-menu');
const playCta = $<HTMLButtonElement>('#play-cta');
const playLabel = $('#play-label');
const swipePad = $('#swipe-pad');
const noticeEl = $('#notice');
const chipsEl = $('#watch-chips');
const touchScreen = matchMedia('(pointer: coarse)').matches;

/** The snake's colours: a model's cyan in Watch, your green in Play. */
let palette: Palette = AI;
const show = (s: GameState | null) => {
  drawBoard(ctx, s, palette);
  scoreEl.textContent = String(s?.apples ?? 0);
  stepsEl.textContent = String(s?.steps ?? 0);
};
/** A word over the board: GET READY, 3, 2, 1, GAME OVER. */
const banner = (text: string | null, over = false) => {
  bannerEl.textContent = text ?? '';
  bannerEl.hidden = !text;
  bannerEl.classList.toggle('over', over);
};
let noticeTimer = 0;
const notice = (content: string | Node | null, ms = 12_000) => {
  noticeEl.replaceChildren(...(content === null ? [] : [content]));
  noticeEl.hidden = content === null;
  clearTimeout(noticeTimer);
  if (content !== null && ms) noticeTimer = window.setTimeout(() => (noticeEl.hidden = true), ms);
};
show(null);

type Mode = 'watch' | 'play';
/** Watch: a recording plays. Play: your game, from GET READY to its result card. */
let mode: Mode = 'watch';
/** Your game's clock is running (or counting down to it). */
let live = false;
/** Bumped to stop whatever loop runs (a recording, your game). */
let run = 0;
let watching: DemoEntry = RECORDINGS[0]!;

// ---------- the leaderboard, and where your apples would place on it ----------
/** The ranked models, best first (from the leaderboard, once it loads). */
let ranking: Row[] = [];
/** The best single game a ranked model played in the benchmark. */
let modelBest: { name: string; score: number } | null = null;
void loadLeaderboard($<HTMLTableElement>('#leaderboard-table'), appPath, { metric: 'Apples (mean ± margin)', fallbacks: 'Late steps', latency: 'Mean latency' }).then((rows) => {
  ranking = rows.ranked;
  // The first in the ranking with the most apples in one game.
  modelBest = rows.ranked.reduce<{ name: string; score: number } | null>((b, r) => (r.best > (b?.score ?? -1) ? { name: r.name, score: r.best } : b), null);
  showHighScore();
  if (scoresOpen) renderScores();
});
/** Your apples among the models' means: the place they would take, and the models just above and below it. */
function placeAmong(apples: number): { place: number; above: Row | null; below: Row | null } {
  const ahead = ranking.filter((r) => r.mean > apples).length;
  return { place: ahead + 1, above: ranking[ahead - 1] ?? null, below: ranking[ahead] ?? null };
}

// ---------- HIGH SCORE, and the players' high scores behind it ----------
let boards: Boards | null = null;
/** Your apples in the game on the board, while it runs. */
let yourApples = 0;
/**
 * The cabinet's HIGH SCORE and who holds it, as on jevman: the best game a model played in the benchmark, a player's
 * best, or yours once you pass them in the game you are playing.
 */
function highScore(): { score: number; who: string } {
  let hi = modelBest ? { score: modelBest.score, who: `Held by ${modelBest.name}, its best benchmark game` } : { score: 0, who: 'No high score yet' };
  const top = boards?.[BOARD]?.[0];
  if (top && top.score > hi.score) hi = { score: top.score, who: `Held by ${top.initials}, a player` };
  if (mode === 'play' && yourApples > hi.score) hi = { score: yourApples, who: "That's you, this game!" };
  return hi;
}
function showHighScore(): void {
  const hi = highScore();
  hiScore.textContent = String(hi.score);
  hiTip.textContent = hi.who;
}
void fetchHighScores().then((view) => {
  boards = view?.boards ?? null;
  showHighScore();
  if (scoresOpen) renderScores();
});

/** The high scores are open over the board (from HIGH SCORE); whatever plays waits meanwhile. */
let scoresOpen = false;
/** HIGH SCORE, clicked: the players' top ten over the board, the models' best game to beat above them. */
function openScores(): void {
  if (scoresOpen || !overlay.hidden) return;
  scoresOpen = true;
  closeSave();
  board.classList.add('dim');
  tv.classList.add('scores-open');
  setCta();
  renderScores();
  overlay.querySelector<HTMLElement>('.x')?.focus({ preventScroll: true });
  // Fresh scores: someone may have entered theirs since the page opened.
  void fetchHighScores().then((view) => {
    if (!view || !scoresOpen) return;
    boards = view.boards;
    showHighScore();
    renderScores();
  });
}
function renderScores(): void {
  const card = el('div', undefined, 'card arc hsc');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'High scores');
  const x = el('button', 'X', 'x');
  x.type = 'button';
  x.setAttribute('aria-label', 'Close');
  x.addEventListener('click', closeScores);
  card.append(x, el('p', 'High scores', 'over-title hs-title'), el('p', 'Your apples in a game here. The server replays every game before it takes a score.', 'tap'));
  const body = el('div', undefined, 'hs-body');
  if (modelBest) {
    const beat = el('p', undefined, 'tobeat');
    beat.append(el('span', 'To beat'), el('span', `${modelBest.name} · ${modelBest.score}`));
    body.append(beat);
  }
  const list = boards?.[BOARD] ?? [];
  if (list.length) {
    const ol = el('ol', undefined, 'dots');
    list.forEach((l, i) => {
      const li = el('li');
      const name = el('span', undefined, 'nm');
      name.append(el('span', String(i + 1), 'rk'), l.initials);
      const lead = el('span', undefined, 'lead');
      lead.setAttribute('aria-hidden', 'true');
      li.append(name, lead, el('span', String(l.score), 'num'));
      ol.append(li);
    });
    body.append(ol);
  } else body.append(el('p', boards ? 'No scores yet. Be the first!' : 'The high scores are not available right now.', 'tap'));
  const go = el('button', undefined, 'press');
  go.type = 'button';
  const tri = el('span', '', 'tri');
  tri.setAttribute('aria-hidden', 'true');
  go.append(tri, el('span', live ? 'Back to your game' : 'Play'));
  go.addEventListener('click', () => {
    closeScores();
    if (!live) void play();
  });
  body.append(go);
  card.append(body);
  overlay.replaceChildren(card);
  overlay.hidden = false;
}
function closeScores(): void {
  if (!scoresOpen) return;
  scoresOpen = false;
  overlay.hidden = true;
  overlay.replaceChildren();
  board.classList.remove('dim');
  tv.classList.remove('scores-open');
  setCta();
  syncSave();
}
const hiCell = $('.arcade-top .mid');
tag(hiCell, 'click_highscores', { source: 'board' });
hiCell.addEventListener('click', openScores);
hiCell.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openScores();
  }
});

// ---------- pause: a click on the board, or P ----------
/** The visitor paused the game on the board (a recording, or yours). */
let paused = false;
/** Whether whatever plays should wait: paused, or the high scores open over it. */
const waiting = () => paused || scoresOpen;
function setPaused(p: boolean): void {
  paused = p;
  tv.classList.toggle('paused', p);
  setCta();
}
/** A step's wait, and on through a pause. False once another loop took over the board. */
async function waitFor(mine: number, ms: number): Promise<boolean> {
  await sleep(ms);
  while (mine === run && waiting()) await sleep(60);
  return mine === run;
}
function togglePause(): void {
  if (!overlay.hidden) return; // a card is open: it has its own buttons
  setPaused(!paused);
}
// A click on the board pauses it, another resumes (not on its cards or the save button and menu). A swipe on it steers
// instead; with the save menu open, a click only closes it.
let swiped = false;
board.addEventListener('click', (e) => {
  const t = e.target as Element;
  // A target no longer in the page was a card's button that just started a game: not a click on the board itself.
  if (!t.isConnected || t.closest('.overlay, .save-btn, .save-menu')) return;
  if (!saveMenu.hidden) return closeSave();
  if (swiped) return;
  togglePause();
});
// Your game in a hidden tab would lose its clock (browsers slow timers there): it waits for you instead.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && live && !paused && overlay.hidden) setPaused(true);
});

// ---------- the watched game's highlight, to save ----------
// Two ways to the same two files, as on jevman: the ↓ in the board's corner, and the ↓ on the chip being watched.
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
function downloadIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ width: '15', height: '15', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const path = document.createElementNS(ns, 'path');
  for (const [k, v] of Object.entries({ d: 'M8 2.5V10M5 7.2l3 3 3-3M3 13h10', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) path.setAttribute(k, v);
  svg.append(path);
  return svg;
}
/** A link that downloads the model's highlight (the 18 s MP4 or the 10 s GIF), counted as click_download. */
function clipLink(model: string, format: 'mp4' | 'gif', source: string): HTMLAnchorElement {
  const clip = CLIPS[model]!;
  const a = el('a');
  a.href = appPath(`/clips/${clip.file}.${format}`);
  a.download = `snake-${clip.file}-highlight.${format}`;
  return tag(a, 'click_download', { source, model, format });
}
/** The board's ↓ shows while a recording with a highlight plays; your game or another model closes its menu. */
function syncSave(): void {
  const model = mode === 'watch' && CLIPS[watching.model] ? watching.model : null;
  saveBtn.hidden = model === null;
  if (model) saveBtn.setAttribute('aria-label', `Save ${possessive(watching.name)} highlight`);
  closeSave();
}
function closeSave(): void {
  saveMenu.hidden = true;
  saveBtn.setAttribute('aria-expanded', 'false');
}
function openSave(): void {
  if (mode !== 'watch' || !CLIPS[watching.model]) return;
  const model = watching.model;
  const fmts = el('div', undefined, 'fmts');
  fmts.append(Object.assign(clipLink(model, 'mp4', 'board'), { textContent: 'MP4' }), Object.assign(clipLink(model, 'gif', 'board'), { textContent: 'GIF' }));
  saveMenu.replaceChildren(el('p', 'Save this game', 't'), el('p', 'Its best 18 seconds', 's'), fmts);
  saveMenu.setAttribute('aria-label', `Save ${possessive(watching.name)} highlight`);
  saveMenu.hidden = false;
  saveBtn.setAttribute('aria-expanded', 'true');
}
saveBtn.addEventListener('click', () => (saveMenu.hidden ? openSave() : closeSave()));
// Picking a file starts its download and closes the menu.
saveMenu.addEventListener('click', (e) => {
  if ((e.target as Element).closest('a')) setTimeout(closeSave);
});
/** The chip being watched, with a ↓ behind it that opens the same two files in the page's own look. */
function withDownload(e: DemoEntry, chip: HTMLButtonElement): HTMLElement {
  const clip = CLIPS[e.model]!;
  const pick = el('span', undefined, 'chip-pick');
  const dl = el('button', undefined, 'chip-dl');
  dl.type = 'button';
  dl.setAttribute('aria-label', `Save ${possessive(e.name)} highlight`);
  dl.setAttribute('aria-haspopup', 'true');
  dl.setAttribute('aria-expanded', 'false');
  dl.setAttribute('aria-controls', 'chip-menu');
  dl.append(downloadIcon());
  const menu = el('div', undefined, 'chip-menu');
  menu.id = 'chip-menu';
  menu.hidden = true;
  const item = (format: 'mp4' | 'gif', label: string, meta: string) => {
    const a = clipLink(e.model, format, 'chips');
    a.append(downloadIcon(), el('b', label), el('small', meta));
    return a;
  };
  menu.append(el('p', `${possessive(e.name)} best 18 seconds`, 't'), item('mp4', 'Video', `MP4 · ${mb(clip.mp4)}`), item('gif', 'GIF', `10 s · ${mb(clip.gif)}`));
  dl.addEventListener('click', () => setChipMenu(menu.hidden !== false));
  menu.addEventListener('click', (ev) => {
    if ((ev.target as Element).closest('a')) setTimeout(() => setChipMenu(false));
  });
  pick.append(chip, dl, menu);
  return pick;
}
/** Opens or closes the watched chip's menu, kept inside the window on a narrow screen. */
function setChipMenu(open: boolean): void {
  const menu = chipsEl.querySelector<HTMLElement>('.chip-menu');
  const dl = chipsEl.querySelector<HTMLElement>('.chip-dl');
  if (!menu || !dl) return;
  menu.hidden = !open;
  dl.setAttribute('aria-expanded', String(open));
  if (!open) return;
  menu.style.left = '0px';
  const over = menu.getBoundingClientRect().right - (document.documentElement.clientWidth - 12);
  if (over > 0) menu.style.left = `${-over}px`;
}
const chipMenuOpen = () => chipsEl.querySelector('.chip-menu:not([hidden])') !== null;
// A click anywhere else closes the high scores and the save menus.
document.addEventListener('click', (e) => {
  const t = e.target as Element;
  if (!t.isConnected) return; // a card's button the card replaced
  if (scoresOpen && !t.closest('.overlay .card, .arcade-top .mid')) closeScores();
  if (!saveMenu.hidden && !t.closest('.board')) closeSave();
  if (chipMenuOpen() && !t.closest('.chip-pick')) setChipMenu(false);
});

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
/** The chips under the board, as jevman's: each model's mark and name; the one playing carries its highlight's ↓. */
function renderChips(): void {
  chipsEl.replaceChildren(
    ...RECORDINGS.map((e) => {
      const b = el('button', undefined, 'chip');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(mode === 'watch' && e.model === watching.model));
      b.title = `${possessive(e.name)} recorded benchmark game`;
      const logo = logoFor(e.model);
      if (logo) b.append(logo);
      b.append(e.name);
      b.addEventListener('click', () => {
        // Mid-game too: a chip ends your game and plays its recording.
        if (mode === 'watch' && e.model === watching.model) return;
        watching = e;
        void watch();
      });
      tag(b, 'click_watch', { source: 'chips', model: e.model });
      return mode === 'watch' && e.model === watching.model && CLIPS[e.model] ? withDownload(e, b) : b;
    }),
  );
  syncSave();
}

/**
 * The button in the cabinet's bottom strip, as jevman's: Play while watching; New game while your game is paused; else
 * out of the way (your game, its game-over card, the high scores have their own).
 */
function setCta(): void {
  playCta.hidden = scoresOpen || (mode === 'play' && !(live && paused));
  playLabel.textContent = live ? 'New game' : 'Play';
}

async function watch(): Promise<void> {
  const mine = ++run;
  mode = 'watch';
  live = false;
  yourApples = 0;
  closeScores();
  setPaused(false);
  overlay.hidden = true;
  overlay.replaceChildren();
  tv.classList.remove('you');
  swipePad.hidden = true;
  palette = AI;
  setCta();
  banner(null);
  notice(null);
  showHighScore();
  renderChips();
  const entry = watching;
  plateLabel.textContent = entry.name;
  show(null);
  const demo = await demoFor(entry);
  if (mine !== run) return;
  if (!demo) {
    banner("This recording didn't load");
    return;
  }
  for (;;) {
    let s = createGame(demo.seed);
    show(s);
    banner(null);
    for (const m of demo.moves) {
      if (!(await waitFor(mine, WATCH_STEP_MS))) return;
      s = step(s, m);
      show(s);
    }
    banner(`Game over: ${s.apples} apples`, true);
    if (!(await waitFor(mine, 3000))) return;
  }
}

// ---------- Play: your own game, on the models' clock ----------
/** Directions keyed or swiped while you play, oldest first (two at most, so a quick double turn works). */
let queued: Heading[] = [];
const steer = (h: Heading) => {
  if (!live || waiting()) return;
  if (queued.length < 2) queued.push(h);
  swipePad.dataset.dir = h;
};
/** Your next step: the oldest keyed direction that isn't a U-turn, else straight on. */
function yourMove(s: GameState): Move {
  while (queued.length) {
    const m = moveToward(s.heading, queued.shift()!);
    if (m) return m;
  }
  return 'straight';
}

/** A game of your own, on a board the server deals, at the speed every model plays: a step every 275 ms. */
async function play(): Promise<void> {
  const mine = ++run;
  mode = 'play';
  live = true;
  yourApples = 0;
  closeScores();
  closeSave();
  setPaused(false);
  overlay.hidden = true;
  overlay.replaceChildren();
  tv.classList.add('you');
  swipePad.hidden = !touchScreen;
  palette = PLAYER;
  setCta();
  queued = [];
  delete swipePad.dataset.dir;
  renderChips();
  plateLabel.textContent = 'You';
  showHighScore();
  track('play_start', { game: 'snake' });
  show(null);
  banner('Get ready');
  const issued = await fetchSeed();
  if (mine !== run) return;
  const seed = issued?.seed ?? Math.floor(Math.random() * 2 ** 31);
  if (!issued) notice("The server didn't deal this board, so this game can't go on the high scores. Have fun anyway.", 0);
  let you = createGame(seed);
  show(you);
  for (const n of ['3', '2', '1']) {
    banner(n);
    if (!(await waitFor(mine, 600))) return;
  }
  banner(null);
  let moves = '';
  await new Promise<void>((resolve) => {
    startClock(STEP_MS, () => {
      if (mine !== run) {
        resolve();
        return false;
      }
      // Paused, or the high scores open: the clock ticks on, the board waits.
      if (waiting()) return true;
      const move = yourMove(you);
      you = step(you, move);
      moves += moveLetter(move);
      show(you);
      if (you.apples !== yourApples) {
        yourApples = you.apples;
        showHighScore();
      }
      if (!you.over) return true;
      resolve();
      return false;
    });
  });
  if (mine !== run) return;
  live = false;
  setCta();
  swipePad.hidden = true;
  notice(null);
  track('play_end', { game: 'snake', apples: String(you.apples) });
  showResult({ state: you, moves }, issued?.token ?? null);
}

/** GAME OVER: your apples, where they would place among the models, and your initials if they make the top ten. */
function showResult(you: { state: GameState; moves: string }, token: string | null): void {
  const apples = you.state.apples;
  const card = el('div', undefined, 'card arc');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Game over');
  card.append(el('p', 'Game over', 'over-title'), el('p', `${apples} ${apples === 1 ? 'apple' : 'apples'}`, 'you-apples'));
  if (ranking.length) {
    const { place, above, below } = placeAmong(apples);
    card.append(el('p', place === 1 ? 'That tops every model on the leaderboard' : `That would rank #${place} of ${ranking.length + 1} on the leaderboard`, 'ttl'));
    const vs = el('ol', undefined, 'dots versus-models');
    const line = (rank: number, name: string, value: string, model?: string) => {
      const li = el('li', undefined, model ? undefined : 'you');
      const nm = el('span', undefined, 'nm');
      nm.append(el('span', String(rank), 'rk'));
      const logo = model ? logoFor(model) : null;
      if (logo) nm.append(logo);
      nm.append(name);
      const lead = el('span', undefined, 'lead');
      lead.setAttribute('aria-hidden', 'true');
      li.append(nm, lead, el('span', value, 'num'));
      return li;
    };
    if (above) vs.append(line(place - 1, above.name, fmt(above.mean), above.model));
    vs.append(line(place, 'You', String(apples)));
    if (below) vs.append(line(place + 1, below.name, fmt(below.mean), below.model));
    card.append(vs, el('p', "A model's apples are its mean over 100 games, played on this clock.", 'tap'));
  }
  const place = token ? placeFor(boards, BOARD, apples) : null;
  if (token && place !== null) {
    const made = el('div', undefined, 'made');
    made.append(el('p', place === 1 ? "Top of the players' board" : `#${place} on the players' board`, 'made-title'));
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
        showHighScore();
        status.textContent = r.place ? `You're #${r.place} on the players' board` : 'Saved, but it no longer makes the top ten';
        form.hidden = true;
      });
    });
    card.append(made);
    queueMicrotask(() => input.focus());
  } else if (token && apples > 0) card.append(el('p', boards ? 'Not enough apples for the top ten this time.' : "The high scores aren't available right now, so this game can't go on them.", 'tap'));
  const btns = el('div', undefined, 'over-btns');
  const again = el('button', undefined, 'press');
  again.type = 'button';
  again.append(el('span', '', 'tri'), el('span', 'Play again'));
  again.addEventListener('click', () => void play());
  const back = el('button', 'Watch', 'press alt');
  back.type = 'button';
  back.addEventListener('click', () => void watch());
  btns.append(again, back);
  card.append(btns);
  overlay.replaceChildren(card);
  overlay.hidden = false;
  if (!(token && place !== null)) again.focus();
}

tag(playCta, 'click_play', { source: 'board' });
playCta.addEventListener('click', () => void play());

window.addEventListener('keydown', (e) => {
  // Typing initials: every key is the input's (Escape too, so it can't throw away a game not yet entered).
  if (e.target instanceof Element && e.target.closest('input, textarea')) return;
  if (e.key === 'Escape') {
    if (!drawer.hidden) return setDrawer(false);
    if (scoresOpen) return closeScores();
    if (!saveMenu.hidden) return closeSave();
    if (chipMenuOpen()) return setChipMenu(false);
    if (mode === 'play') return void watch();
  }
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'p' || e.key === 'P') return togglePause();
  if (!live) return;
  const h = KEYS[e.key];
  if (!h) return;
  e.preventDefault();
  steer(h);
});
/**
 * Phones, as on jevman: swipe anywhere on the cabinet (the board, the strips above and below it, the pad) while you
 * play, steering as soon as the finger has moved far enough, like a joystick. Never on a card over the board, which
 * must still scroll.
 */
let touchStart: { x: number; y: number } | null = null;
tv.addEventListener(
  'touchstart',
  (e) => {
    swiped = false;
    if (!live || (e.target instanceof Element && e.target.closest('#overlay'))) return void (touchStart = null);
    const t = e.touches[0]!;
    touchStart = { x: t.clientX, y: t.clientY };
  },
  { passive: true },
);
tv.addEventListener(
  'touchmove',
  (e) => {
    if (!touchStart) return;
    const t = e.touches[0]!;
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 18) return;
    swiped = true;
    steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
    touchStart = { x: t.clientX, y: t.clientY }; // a second swipe in the same touch turns again
    e.preventDefault(); // no page scroll while steering
  },
  { passive: false },
);
tv.addEventListener('touchend', () => (touchStart = null), { passive: true });

void watch();
