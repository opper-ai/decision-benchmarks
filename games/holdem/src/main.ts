// AI Hold'em's page: opper.ai's chrome, the hero, and the room where everything happens: the lobby, the table (you
// against AI models, or AIs against each other with every card face up), the hand review and the end of the game.
// The page talks to a TableDriver only: the service's table (RemoteDriver, api/table/*), where the server deals and
// asks the models. A dev build with ?practice plays a LocalDriver instead, bots standing in for the models.
import { accountNotice, fetchMe, renderAccount, renderDrawerAccount, signIn, takeAuthError, walletNotice, type AccountView, type Me } from '../../../packages/kit/client/auth.ts';
import { appPath } from '../../../packages/kit/client/paths.ts';
import { warmUp } from '../../../packages/kit/client/transport.ts';
import { ModelWarming } from '../../../packages/kit/client/warming.ts';
import { track, trackClicks } from '../../../packages/kit/client/track.ts';
import { audio } from './audio.ts';
import { focusDialog, h, reducedMotion, wait } from './dom.ts';
import type { ActionMeta, StepResult, TableDriver, TableSnapshot } from './driver.ts';
import { LocalDriver } from './local-driver.ts';
import { reconnectBanner } from './views/reconnect.ts';
import { choiceOf, retryChoice } from './reconnect.ts';
import { RemoteDriver, TableError } from './remote-driver.ts';
import { isRouteHash } from './route-hash.ts';
import { warmTable } from './warm.ts';
import { SETS } from './roster.ts';
import { askAction } from './views/actions.ts';
import { endView } from './views/end.ts';
import { lobbyView, seatsOf, type LobbyAccess, type LobbyChoice } from './views/lobby.ts';
import { reviewView } from './views/review.ts';
import { TableUI } from './views/table.ts';
import { aHand, chips, levelText, ordinal, paced, personOf } from './view-model.ts';
import { ChatBox } from './views/chat.ts';
import { confirmDialog } from './views/confirm.ts';
import { preloadFaces } from './views/parts.ts';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
/** Practice, in a dev build only (?practice): bots stand in for the models, in the browser. Else the service's table. */
const PRACTICE = import.meta.env.DEV && new URLSearchParams(location.search).has('practice');
/** Which decision models are awake (a warm-up is one tiny /api/warm call), across the tables of this visit. */
const WARMING = new ModelWarming({ warmUp: async (model) => (await warmUp(model)).ok, now: () => Date.now() });
/** Who is signed in, and so who pays: read once, for the account bar and the lobby. */
const ME: Promise<Me> = fetchMe();

/** What the visitor can start: chat models need a player's sign-in (or the local key); decision models the free credits too. */
function accessOf(me: Me): LobbyAccess | undefined {
  // Unknown (the server could not be asked): let the table answer for itself.
  if (me.unavailable) return undefined;
  return { chat: me.mode === 'player' || me.mode === 'dev', decision: me.mode !== 'none' };
}

const SPEAKER_ON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
const SPEAKER_OFF = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M17 9l5 6M22 9l-5 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
/** The hand review (a list), and leaving the table (out through a door). */
const REVIEW_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="4" cy="6" r="1.4" fill="currentColor"/><circle cx="4" cy="12" r="1.4" fill="currentColor"/><circle cx="4" cy="18" r="1.4" fill="currentColor"/></svg>';
const LEAVE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M14 4H6v16h8" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M11 12h10M17 8l4 4-4 4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/** An icon from its markup (ours, above). */
function svg(markup: string): HTMLElement {
  const el = h('span.ic', { 'aria-hidden': 'true' });
  el.innerHTML = markup;
  return el;
}

/** The table's RemoteDriver while a game is on (Leave forgets the table through it). */
let liveRemote: RemoteDriver | null = null;

/** The phone layout in style.css (one row of buttons, a table the height of the screen). */
const PHONE = window.matchMedia('(max-width: 759px)');

chrome();
room();

/** opper.ai's header and footer: the phone menu, the account, the theme. */
function chrome(): void {
  trackClicks(appPath('/'), 'holdem');
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
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    let picked: string | null = null;
    try {
      picked = localStorage.getItem('theme');
    } catch {
      // storage blocked: follow the system
    }
    if (picked !== 'dark' && picked !== 'light') document.documentElement.classList.toggle('dark', e.matches);
  });
  // Who pays for which seats (signed out: decision models on the free credits; the chat models on the player's own
  // credits) is the service's to decide; the lobby only says so up front.
  void ME.then((me) => showAccount(me));
}

function showAccount(me: Me, notice?: { notice: string; noticeLink?: string }): void {
  const view: AccountView = { kind: me.mode === 'player' ? 'player' : me.mode === 'pool' ? 'pool' : me.mode === 'dev' ? 'dev' : me.pool ? 'pool-empty' : 'signed-out', me, notice: accountNotice(me, takeAuthError(), false), ...notice };
  renderAccount($('#account'), view);
  renderDrawerAccount($('#oc-drawer-account'), view);
}

/**
 * The poster for a table that stopped: what went wrong, and what to do about it (sign in, top up, start again). With
 * `retry`, a table kept in this browser can be tried again (Try again) before going back to the lobby.
 */
function stoppedView(e: unknown, lobby: () => void, o: { title?: string; retry?: () => void } = {}): HTMLElement {
  const err = e instanceof TableError ? e : null;
  const title = o.title ?? (err?.kind === 'signin' || err?.kind === 'pool' ? 'Sign in to keep playing' : err?.kind === 'wallet' ? 'Your Opper wallet is empty' : err?.kind === 'expired' ? 'This table has closed' : 'The table stopped');
  const buttons: HTMLElement[] = [];
  if (o.retry) buttons.push(h('button.cta', { type: 'button', onclick: o.retry }, 'Try again'));
  if (err?.kind === 'signin' || err?.kind === 'pool') buttons.push(h('button.cta', { type: 'button', onclick: signIn }, 'Sign in with Opper'));
  if (err?.kind === 'wallet' && err.walletUrl) buttons.push(h('a.cta', { href: err.walletUrl, target: '_blank', rel: 'noopener' }, 'Top up your wallet'));
  buttons.push(buttons.length ? h('button.cta.quiet', { type: 'button', onclick: lobby }, 'Back to the lobby') : h('button.cta', { type: 'button', onclick: lobby }, 'Back to the lobby'));
  return h('div.overlay', null, h('div.poster', { role: 'alertdialog', 'aria-label': title }, h('h2', null, title), h('p.sub', null, (e as Error).message), h('div.row', null, ...buttons)));
}

/** The room: the lobby, then a game, then the lobby again. */
/**
 * Brings the room's top into view when a table starts: on a phone, "Deal me in" sits below the fold, and the table
 * would otherwise start above the screen. On a wide screen it leaves the page alone when the room's top is already on
 * screen; a phone's table is sized to fill the screen under the header (style.css), so there it always lines up.
 */
function showRoom(host: HTMLElement): void {
  const top = host.getBoundingClientRect().top;
  const header = 64;
  if (top >= header && top < visibleBottom() * 0.25 && !PHONE.matches) return;
  // At once: the room's content is replaced as the table starts, which would cut a smooth scroll short. To 68px under
  // the top (opper.ai's 60px header and a gap), as style.css sizes a phone's table; scrollIntoView would add the page's
  // scroll-padding for its section links to the room's own margin.
  window.scrollTo({ top: window.scrollY + top - 68, behavior: 'instant' });
}

/**
 * Where the screen the player can see ends, in the page's viewport coordinates: the visual viewport's bottom, so a
 * phone's browser toolbar over the page (Safari's) and a pinch zoom count. innerHeight where there is no visual viewport.
 */
function visibleBottom(): number {
  const vv = window.visualViewport;
  return vv ? vv.offsetTop + vv.height : window.innerHeight;
}

/** On your turn, scrolls just far enough that your buttons are on screen, above a phone's browser toolbar. */
function keepInView(el: HTMLElement): void {
  const below = el.getBoundingClientRect().bottom - visibleBottom() + 12;
  if (below > 0) window.scrollBy({ top: below, behavior: reducedMotion() ? 'instant' : 'smooth' });
}

function room(): void {
  const host = $('#room');
  let choice: LobbyChoice = { mode: 'play', setId: 'decision', models: [...SETS.find((s) => s.id === 'decision')!.models] };
  let leave: AbortController | null = null;

  let access: LobbyAccess | undefined;
  let inLobby = false;
  const lobby = () => {
    leave?.abort();
    // A share link or a curated replay (routes.ts) owns the room: no lobby over it, now or when sign-in resolves.
    if (isRouteHash(location.hash)) return;
    inLobby = true;
    host.classList.remove('watching', 'all-up');
    // A table kept in this browser (a reload, a page that dropped): one tap to sit back down, never a surprise.
    const saved = PRACTICE ? null : RemoteDriver.saved();
    host.replaceChildren(
      lobbyView({
        initial: choice,
        practice: PRACTICE,
        access,
        onStart: (c) => {
          choice = c;
          inLobby = false;
          void game(c);
        },
        onSignIn: signIn,
        resume: saved
          ? {
              saved,
              onResume: () => {
                choice = choiceOf(saved);
                inLobby = false;
                void game(choice, true);
              },
              onDiscard: () => {
                new RemoteDriver().forget();
                lobby();
              },
            }
          : undefined,
      }),
    );
  };
  /**
   * The player leaves the table (Leave, Change the table, Back to the lobby): nothing is kept to resume. The table's own
   * driver forgets it, which also cancels its requests in flight, so no late answer keeps it again.
   */
  const leaveTable = () => {
    if (!PRACTICE) (liveRemote ?? new RemoteDriver()).forget();
    liveRemote = null;
    lobby();
  };
  // Once the server says who is signed in, the lobby says what they can start.
  void ME.then((me) => {
    access = accessOf(me);
    if (inLobby) lobby();
  });

  /** A new table for a choice, or (resume) the table kept in this browser. */
  const game = async (c: LobbyChoice, resume = false) => {
    leave?.abort();
    showRoom(host);
    const ac = new AbortController();
    leave = ac;
    /** The table answered start (or resume): from then on the table kept in this browser is this game's. */
    let started = false;
    try {
      await playGame(host, c, ac.signal, { again: () => void game(c), lobby: leaveTable, started: () => (started = true) }, resume);
    } catch (e) {
      if ((e as Error).name === 'AbortError' || ac.signal.aborted) return;
      if (!(e instanceof TableError)) console.error(e);
      if (e instanceof TableError && e.kind === 'wallet') void ME.then((me) => showAccount(me, walletNotice(e.walletUrl ?? me.walletUrl)));
      host.querySelector('.reconnect')?.remove();
      // The connection gave up: the table is still kept, so it can be tried again. A kept table the server no longer
      // has (expired, stale) was cleared by the driver: that game has closed.
      const again = retryChoice({ gaveUp: e instanceof TableError && (e.kind === 'failed' || e.kind === 'rate'), started, resumed: resume, saved: PRACTICE ? null : RemoteDriver.saved() });
      const closed = resume && e instanceof TableError && !again && e.kind !== 'signin' && e.kind !== 'wallet' && e.kind !== 'pool';
      const stopped = stoppedView(e, leaveTable, { ...(closed ? { title: 'That game has closed' } : {}), ...(again ? { retry: () => ((choice = again), void game(again, true)) } : {}) });
      host.append(stopped);
      focusDialog(stopped);
    }
  };

  lobby();
}

/** A game at the table: a new one, or (resume) the table this browser kept (RemoteDriver.saved()). */
async function playGame(host: HTMLElement, choice: LobbyChoice, signal: AbortSignal, nav: { again(): void; lobby(): void; started?(): void }, resume = false): Promise<void> {
  const seats = seatsOf(choice);
  const watching = choice.mode === 'watch';
  let speed = 1;
  const local = PRACTICE ? new LocalDriver() : null;
  // A bad connection: "Reconnecting…" over the table while the driver tries again, gone when it answers.
  const reconnect = reconnectBanner(signal);
  const driver: TableDriver = local ?? (liveRemote = new RemoteDriver({ onConnection: reconnect.update }));
  /** A resumed table catching up on the hand in play: at once, without its sounds. */
  let restoring = false;
  const ui = new TableUI({ seats, viewer: watching ? null : 0, speed: () => (restoring ? 1000 : watching || spectating ? speed : 1), reduced: () => restoring || reducedMotion() });
  /** Play mode, after you went out: the AIs play on, faster, and you watch. */
  let spectating = false;

  // ---------- the toolbar ----------
  const level = h('div.level', { 'aria-live': 'polite' });
  const tools = h('div.tools');
  // The table chat: the dealer's lines, the models' talk (and why, once the cards are up), and in play your own.
  const chat = new ChatBox({
    people: seats.map(personOf),
    mode: watching ? 'watch' : 'play',
    viewer: watching ? null : 0,
    ...(watching ? {} : { onSay: (text: string) => driver.say?.(text) ?? null }),
  });
  // Your lines back from the table, as it placed them: the chat marks them said.
  driver.onSaid = (lines) => chat.said(lines);
  driver.onTalkRefused = (lines, why) => chat.unsaid(lines.length, why);
  if (watching) {
    const group = h('div.speed', { role: 'radiogroup', 'aria-label': 'Speed' });
    for (const s of [1, 2, 4, 8]) {
      group.append(
        h('button', {
          type: 'button',
          role: 'radio',
          'aria-checked': String(s === speed),
          onclick: (e: Event) => {
            speed = s;
            if (local) local.thinkScale = 1 / s;
            group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b === e.currentTarget)));
          },
        }, `${s}×`),
      );
    }
    tools.append(group);
  }
  // A phone opens the chat from here (a wide screen has it beside the table).
  tools.append(chat.button);
  // Off until the table has started: before that there is nothing to review.
  // Review and Leave: words on a wide screen, icons on a phone, where the toolbar is one line (style.css).
  const reviewBtn = h('button.tbtn.word', { type: 'button', disabled: true, 'aria-label': 'Review', title: 'Review the hands', onclick: () => void openReview() }, svg(REVIEW_ICON), h('span.lbl', null, 'Review')) as HTMLButtonElement;
  const soundBtn = h('button.tbtn.icon', { type: 'button', 'aria-label': 'Sound', 'aria-pressed': String(audio.on), title: 'Sound on or off', onclick: () => audio.set(!audio.on) });
  const drawSound = () => {
    soundBtn.innerHTML = audio.on ? SPEAKER_ON : SPEAKER_OFF;
    soundBtn.setAttribute('aria-pressed', String(audio.on));
  };
  drawSound();
  signal.addEventListener('abort', audio.onChange(drawSound), { once: true });
  /** A game is on (it has started and is not over): Leave asks first, as leaving ends it (the table is not kept). */
  let live = false;
  const askLeave = () => {
    if (!live) return nav.lobby();
    if (host.querySelector('.confirm-veil')) return;
    const looking = watching || spectating;
    host.append(
      confirmDialog({
        title: looking ? 'Stop watching this table?' : 'Leave this table?',
        text: looking ? 'The game will end.' : 'Your game will end.',
        yes: 'Leave',
        no: looking ? 'Keep watching' : 'Keep playing',
        onYes: nav.lobby,
      }),
    );
  };
  tools.append(reviewBtn, soundBtn, h('button.tbtn.word', { type: 'button', 'aria-label': 'Leave', title: 'Leave the table', onclick: askLeave }, svg(LEAVE_ICON), h('span.lbl', null, 'Leave')));
  if (PRACTICE) tools.prepend(h('span.practice', { title: 'Bots stand in for the models (?practice)' }, 'Practice'));
  const toolbar = h('div.toolbar', null, level, tools);
  const actions = h('div.actions', { hidden: true });
  // Every face first, for a moment at most (the lobby has usually loaded them): the table opens with faces, not discs.
  await Promise.race([preloadFaces(seats.map(personOf)), wait(1200)]);
  if (signal.aborted) return;
  host.classList.toggle('watching', watching);
  host.classList.remove('all-up');
  host.replaceChildren(toolbar, ui.el, actions, chat.el, reconnect.el);

  const drawLevel = (s: TableSnapshot) => {
    const t = levelText(s.view.level);
    // On a phone the three share a line, "Hand 12 · 50/100 · 75/150 in 3 hands", and "Blinds" is left off (style.css).
    level.replaceChildren(h('span', null, 'Hand ', h('b', null, String(s.hand))), h('span.blinds', null, h('span.lbl', null, 'Blinds '), t.blinds), ...(t.next ? [h('span.next', null, t.next)] : []));
  };

  // ---------- the hand review, the end ----------
  let overlay: HTMLElement | null = null;
  const closeOverlay = () => {
    overlay?.remove();
    overlay = null;
  };
  /** The review opens over the table, or over the end or bust poster, which comes back when it closes. */
  const openReview = async (hand?: number) => {
    const under = overlay?.querySelector('.review') ? null : overlay;
    let restore: () => void = () => {};
    const back = () => {
      closeOverlay();
      if (under) host.append((overlay = under));
      restore();
    };
    let body: HTMLElement;
    try {
      body = reviewView({ review: await driver.review(), hand, onClose: back });
    } catch (e) {
      // Offline, an expired table, too early: say so instead of doing nothing.
      body = h('div.poster', { role: 'alertdialog', 'aria-label': 'The review did not open' }, h('h2', null, 'The review did not open'), h('p.sub', null, (e as Error).message), h('div.row', null, h('button.cta', { type: 'button', onclick: back }, 'Back to the table')));
    }
    if (signal.aborted) return;
    closeOverlay();
    overlay = h('div.overlay', null, body);
    host.append(overlay);
    overlay.scrollTop = 0;
    restore = focusDialog(overlay);
  };

  /** The answer's own move, its words and why: the chat puts them on its move (playNew). */
  let said: { seat: number; meta: ActionMeta } | undefined;
  const logStep = (r: StepResult) => {
    said = { seat: r.seat, meta: r.meta };
  };

  // ---------- the game ----------
  // Wake the decision models first (a cold one would fold its first actions to the fallback); say so if it takes a while.
  if (!local && !resume) {
    // The player can start without waiting (a cold model's fallback plays until it wakes), or leave.
    let skip: () => void = () => {};
    const skipped = new Promise<void>((resolve) => (skip = resolve));
    signal.addEventListener('abort', skip, { once: true });
    const waking = h(
      'div.overlay',
      null,
      h(
        'div.poster',
        { role: 'status' },
        h('h2', null, 'Waking the models…'),
        h('p.sub', null, 'Idle models take a few seconds to wake up.'),
        h('div.row', null, h('button.cta', { type: 'button', onclick: () => skip() }, 'Start now'), h('button.cta.quiet', { type: 'button', onclick: nav.lobby }, 'Leave')),
      ),
    );
    await Promise.race([warmTable(choice.models, WARMING, { onSlow: () => !signal.aborted && host.append(waking) }), skipped]);
    waking.remove();
    if (signal.aborted) return;
  }
  let snap = resume && driver instanceof RemoteDriver ? await driver.resume() : await driver.start({ seats });
  nav.started?.();
  live = !snap.over;
  reviewBtn.disabled = false;
  track(resume ? 'play_resume' : 'play_start', { game: 'holdem', mode: choice.mode, set: choice.setId, opponents: choice.models.join(',') });
  let shown = 0;
  let knockedOut = 0;
  /** Play mode, out of the game: every card face up and the models' thinking from now on, as in watch mode. */
  let seeingAll = false;
  const spectate = () => {
    if (watching || seeingAll) return;
    seeingAll = true;
    ui.seeAll();
    host.classList.add('all-up');
  };
  /** The chat already has these events (a resume laid the hand in play out with what was said): playNew skips it once. */
  let chatLaidOut = false;
  const playNew = async (s: TableSnapshot) => {
    const fresh = s.events.slice(shown);
    shown = s.events.length;
    snap = s;
    if (s.spectating) spectate();
    if (chatLaidOut) chatLaidOut = false;
    else chat.feed(fresh, s.hand, said);
    said = undefined;
    await ui.play(fresh, s);
    drawLevel(s);
  };
  if (resume) {
    // Back at a kept table: the hand in play laid out again at once and silently (deal, bets, folds), without
    // announcing who went out before.
    knockedOut = snap.eliminations.length;
    // The hand's chat as it went: the models' words (and reasoning only where it was shown) and your own lines.
    const so = driver.handSoFar?.();
    if (so) {
      chat.history([{ hand: snap.hand, events: snap.events, actions: so.metas, talk: so.talk }]);
      chatLaidOut = true;
    }
    restoring = true;
    audio.hushed = true;
    try {
      await playNew(snap);
    } finally {
      restoring = false;
      audio.hushed = false;
    }
    if (!watching && snap.viewer !== null && snap.places[snap.viewer] !== null && !snap.over) {
      spectating = true;
      speed = 4;
    }
  } else await playNew(snap);

  while (!signal.aborted) {
    if (snap.view.street === 'done') {
      await endOfHand();
      if (signal.aborted) return;
      if (snap.over) {
        live = false;
        host.querySelector('.confirm-veil')?.remove();
        await wait(paced(1200, speed, reducedMotion()));
        if (signal.aborted) return;
        const review = await driver.review();
        if (signal.aborted) return;
        closeOverlay();
        const place = snap.viewer === null ? null : snap.places[snap.viewer];
        track('play_end', { game: 'holdem', mode: choice.mode, set: choice.setId, hands: String(snap.hand), ...(place ? { place: String(place) } : {}) });
        overlay = h('div.overlay', null, endView({ review, snapshot: snap, watching, onAgain: nav.again, onLobby: nav.lobby, onReview: () => void openReview() }));
        // The poster in view: on a phone, the room's top under the header, so its buttons are on the screen.
        showRoom(host);
        host.append(overlay);
        focusDialog(overlay);
        audio.play(snap.viewer !== null && snap.places[snap.viewer] === 1 ? 'win' : 'bust');
        return;
      }
      if (!watching && !spectating && snap.viewer !== null && snap.places[snap.viewer] !== null) {
        await busted();
        spectating = true;
        speed = 4;
        if (local) local.thinkScale = 1 / speed;
      } else if (watching || spectating) await wait(paced(2400, speed, reducedMotion()));
      else await handOver();
      if (signal.aborted) return;
      ui.relax();
      shown = 0;
      await playNew(await driver.nextHand());
      continue;
    }
    let r: StepResult;
    if (snap.turn) {
      audio.play('turn');
      const asked = askAction(actions, snap.turn, signal, { pot: snap.view.pot, bb: snap.view.blinds.bb });
      keepInView(actions);
      const action = await asked;
      try {
        r = await driver.act(action);
      } catch (e) {
        // Not now (not your turn, not legal): say so and ask again. A table that is gone stops the game.
        if (e instanceof TableError && e.kind !== 'refused' && e.kind !== 'rate') throw e;
        actions.hidden = false;
        actions.replaceChildren(h('p.error-line', { role: 'alert' }, (e as Error).message));
        await wait(1500);
        continue;
      }
    } else {
      const seat = snap.view.toAct!;
      ui.thinking(seat, snap.timeBankMs);
      try {
        r = await driver.step(signal);
      } catch (e) {
        // Too fast for the free credits' fair use: wait a moment and ask again.
        if (e instanceof TableError && e.kind === 'rate') {
          await wait(1500);
          continue;
        }
        throw e;
      } finally {
        ui.stopThinking(seat);
      }
      ui.showMeta(r.seat, r.meta);
    }
    if (signal.aborted) return;
    logStep(r);
    await playNew(r.snapshot);
  }

  /** Who won the hand, and who went out. */
  async function endOfHand(): Promise<void> {
    const awards = snap.view.awards;
    const shownHands = new Map(snap.events.flatMap((e) => (e.type === 'showdown' ? e.hands.map((x) => [x.seat, x.category] as const) : [])));
    const main = awards[0];
    if (main) {
      const winners = main.winners;
      const total = awards.filter((a) => a.winners.join() === winners.join()).reduce((a, x) => a + x.amount, 0);
      const who = winners.map((w) => (w === snap.viewer ? 'You' : ui.nameOf(w))).join(' and ');
      const verb = winners.length > 1 ? 'split' : who === 'You' ? 'win' : 'wins';
      const cat = shownHands.get(winners[0]!);
      ui.banner(`${who} ${verb} ${chips(total)}`, cat ? `with ${aHand(cat)}` : 'Everyone else folded');
    }
    const fresh = snap.eliminations.slice(knockedOut);
    knockedOut = snap.eliminations.length;
    for (const e of fresh) {
      await wait(paced(1500, speed, reducedMotion()));
      audio.play('bust');
      const by = e.by.map((s) => (s === snap.viewer ? 'You' : ui.nameOf(s))).join(' and ');
      const out = e.seat === snap.viewer ? 'you' : ui.nameOf(e.seat);
      ui.banner(by ? `${by} ${by === 'You' ? 'knock' : 'knocks'} out ${out}` : `${out} is out`, `${e.seat === snap.viewer ? 'You finish' : `${ui.nameOf(e.seat)} finishes`} ${ordinal(e.place)}`, 'ko');
    }
  }

  /** Play mode: you are out, the others play on. Watch them finish, or start again. */
  function busted(): Promise<void> {
    return new Promise((resolve) => {
      const e = snap.eliminations.find((x) => x.seat === snap.viewer)!;
      const by = e.by.map((s) => ui.nameOf(s)).join(' and ');
      closeOverlay();
      overlay = h(
        'div.overlay',
        null,
        h(
          'div.poster',
          { role: 'dialog', 'aria-label': 'You are out' },
          h('h2', null, `You finished ${ordinal(e.place)}`),
          h('p.sub', null, by ? `${by} knocked you out in hand ${e.hand}.` : `You went out in hand ${e.hand}.`),
          h(
            'div.row',
            null,
            h('button.cta', { type: 'button', onclick: () => (closeOverlay(), resolve()) }, 'Watch the rest'),
            h('button.cta.quiet', { type: 'button', onclick: nav.again }, 'Play again'),
            h('button.cta.quiet', { type: 'button', onclick: nav.lobby }, 'Change the table'),
          ),
        ),
      );
      host.append(overlay);
      focusDialog(overlay);
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  /** Play mode, between hands: deal the next one, or look back at this one first. */
  function handOver(): Promise<void> {
    return new Promise((resolve) => {
      const go = () => {
        window.removeEventListener('keydown', onKey);
        signal.removeEventListener('abort', go);
        actions.hidden = true;
        actions.replaceChildren();
        resolve();
      };
      const onKey = (e: KeyboardEvent) => {
        const t = e.target as HTMLElement | null;
        if (overlay || host.querySelector('.confirm-veil') || e.metaKey || e.ctrlKey || e.altKey || t?.tagName === 'INPUT') return;
        if (e.key === 'n' || e.key === 'N') go();
      };
      const deal = h('button.cta', { type: 'button', onclick: go }, 'Deal the next hand');
      actions.replaceChildren(h('div.handover', null, deal, h('button.cta.quiet', { type: 'button', onclick: () => void openReview(snap.hand) }, 'Review this hand')), h('p.hint', null, 'Key: N deals the next hand'));
      actions.hidden = false;
      deal.focus({ preventScroll: true });
      window.addEventListener('keydown', onKey);
      signal.addEventListener('abort', go, { once: true });
    });
  }
}
