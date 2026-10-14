// Jev Fighter's page: a game to play against the models, not a benchmark. opper.ai's chrome, the hero, the stage
// playing a recorded match (model against model) with "Fight an AI" on its floor and Activity folding out under it, a
// chip per recording, then How it works. Watch plays recordings only: no model is called for a visitor who did not ask
// to fight.
import { accountNotice, fetchMe, POOL_EMPTY_NOTICE, renderAccount, renderDrawerAccount, signIn, takeAuthError, updatePoolAmount, walletNotice, type AccountView, type Me } from '../../../packages/kit/client/auth.ts';
import { appPath } from '../../../packages/kit/client/paths.ts';
import { tag, track, trackClicks } from '../../../packages/kit/client/track.ts';
import type { TransportHooks } from '../../../packages/kit/client/transport.ts';
import type { Replay } from '../shared/replay.ts';
import { getDemo, getDemos, type Demo } from './api.ts';
import { audio } from './audio.ts';
import { h } from './dom.ts';
import type { Plan } from './players.ts';
import { live, pickerCard, type Setup } from './views/fight.ts';
import { posesView } from './views/poses.ts';
import { replayView } from './views/replay.ts';
import { clipFor, clipLink } from './views/save.ts';
import { ICONS, menuTool, stageShell } from './views/shell.ts';
import { stillView } from './views/still.ts';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const DEMO = /^#\/(?:watch|still)\/([a-z0-9][a-z0-9-]*\.fight\.json\.gz)/;

// A recorded match's frame on its own, filling the window (#/still/<file>?t=<tick>): for the poster and embeds.
// The pose sheet (#/poses) is a tool for tuning the animation.
const special = location.hash.startsWith('#/still/') ? 'still' : location.hash === '#/poses' ? 'poses' : null;
if (special) {
  const host = h('div.tool');
  document.body.replaceChildren(host);
  document.body.classList.add('tool-page');
  const file = DEMO.exec(location.hash)?.[1];
  if (special === 'poses') posesView(host);
  else if (file) {
    const r = await getDemo(file).catch(() => null);
    if (r) stillView(host, r, Number(new URLSearchParams(location.hash.split('?')[1] ?? '').get('t')) || 0);
  }
} else await page();

async function page(): Promise<void> {
  trackClicks(appPath('/'), 'fighter');

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

  let me: Me = await fetchMe();
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
        } else if (fresh.mode === 'none' && fresh.pool && !fresh.unavailable) {
          me = fresh;
          showAccount({ kind: 'pool-empty', me: fresh });
        }
      });
    }, 60_000);
  }
  /** What the transport tells the page when a model call cannot be paid for; the picker reads `me` afresh. */
  const hooks: TransportHooks = {
    onSignedOut: () => {
      me = { ...me, mode: me.pool ? 'pool' : 'none', user: undefined };
      showAccount({ kind: 'signed-out', me, notice: 'Signed out. Sign in to fight a decision model.' });
    },
    onPoolEmpty: () => {
      if (me.pool) me = { ...me, pool: { ...me.pool, open: false } };
      showAccount({ kind: 'pool-empty', me, notice: POOL_EMPTY_NOTICE });
    },
    onWalletEmpty: (url) => showAccount({ ...account, ...walletNotice(url) }),
  };

  // ---------- the stage: a recording (Watch), the picker, a live fight ----------
  const viewer = $('#viewer');
  const overlay = $('#overlay');
  // The page's one primary button: on the stage's floor of whichever view shows, as jevman's PLAY VS AI is in its cabinet.
  const ctaLabel = h('span', null, 'Fight an AI');
  const cta = h('button.fight-cta', { type: 'button', id: 'play-cta' }, h('span.tri', { 'aria-hidden': 'true' }), ctaLabel) as HTMLButtonElement;
  const noticeEl = $('#notice');
  const chipsEl = $('#watch-chips');
  let cleanup: () => void = () => {};
  /** Pauses the recording on the stage, if one plays. */
  let pause: () => void = () => {};
  let mode: 'watch' | 'fight' = 'watch';
  /** Bumped by every switch, so a recording that loads late doesn't replace what came after it. */
  let run = 0;

  const setCta = (kind: 'fight' | 'stop') => {
    cta.classList.toggle('stop', kind === 'stop');
    ctaLabel.textContent = kind === 'fight' ? 'Fight an AI' : 'Stop the fight';
  };
  const notice = (text: string | null) => {
    noticeEl.textContent = text ?? '';
    noticeEl.hidden = text === null;
  };
  const closePicker = () => {
    overlay.hidden = true;
    overlay.replaceChildren();
  };
  const switchTo = (next: () => () => void) => {
    run += 1;
    cleanup();
    cleanup = () => {};
    pause = () => {};
    closePicker();
    cleanup = next();
  };

  const demos: Demo[] = await getDemos().catch(() => []);
  const loaded = new Map<string, Promise<Replay | null>>();
  const demoFor = (d: Demo) => {
    let p = loaded.get(d.file);
    if (!p) {
      p = getDemo(d.file).catch(() => null);
      loaded.set(d.file, p);
      void p.then((r) => r ?? loaded.delete(d.file));
    }
    return p;
  };
  let watching: Demo | null = demos.find((d) => d.file === DEMO.exec(location.hash)?.[1]) ?? demos[0] ?? null;
  const short = (title: string) => title.replace(/ baseline\b/g, '');

  /** The playing chip's save menu, rebuilt with the chips. */
  let chipMenu: { destroy: () => void } | null = null;
  /** A chip per recording, no scores (they would give the result away). The playing one saves its highlight. */
  function renderChips(): void {
    chipMenu?.destroy();
    chipMenu = null;
    chipsEl.replaceChildren(
      ...demos.map((d) => {
        const on = mode === 'watch' && d === watching;
        const b = h('button.chip', { type: 'button', role: 'radio', 'aria-checked': String(on), title: d.note ?? d.title }, on ? h('span.chip-dot', { 'aria-hidden': 'true' }) : null, h('span', null, short(d.title)));
        b.addEventListener('click', () => {
          watching = d;
          void watch(true);
        });
        const chip = tag(b, 'click_watch', { source: d.file });
        const clip = clipFor(d.file);
        if (!on || !clip) return chip;
        // Its ⤓ opens the highlight to save, a video or a GIF, as jevman's chips do.
        const name = short(d.title);
        const dl = h('button.chip-save', { type: 'button', 'aria-label': `Save ${name}'s highlight`, title: 'Save its highlight: a video or a GIF', html: ICONS.download }) as HTMLButtonElement;
        const holder = h('span.chip-holder', null, h('span.chip-split', null, chip, dl));
        chipMenu = menuTool(dl, h('div', { 'aria-label': `Save ${name}'s highlight` }, h('p.tmenu-title', null, 'Its best 18 seconds'), clipLink(clip, 'mp4', 'chips'), clipLink(clip, 'gif', 'chips')), holder);
        return holder;
      }),
    );
  }

  /** The stage with a line in place of a match (loading, or none to show), and the button on its floor all the same. */
  function placeholder(text: string): void {
    viewer.replaceChildren(h('div.viewer', null, stageShell(h('div.fstage.empty', null, h('p', null, text)), null, cta).box));
  }

  /** Plays the chosen recording on the stage; `music` once the visitor picked it (not on page load). */
  async function watch(music = false): Promise<void> {
    mode = 'watch';
    setCta('fight');
    notice(null);
    renderChips();
    const d = watching;
    switchTo(() => {
      placeholder(d ? 'Loading the match...' : 'No recorded matches yet.');
      return () => {};
    });
    if (!d) return;
    const mine = run;
    const r = await demoFor(d);
    if (mine !== run) return;
    if (!r) {
      placeholder("This recording didn't load.");
      return;
    }
    const v = replayView(viewer, r, { link: `#/watch/${d.file}`, music, cta, clip: clipFor(d.file) });
    cleanup = v;
    pause = v.pause;
  }

  function watchLast(r: Replay): void {
    mode = 'watch';
    setCta('fight');
    renderChips();
    switchTo(() => {
      const v = replayView(viewer, r, { cta, kind: 'yours' });
      pause = v.pause;
      return v;
    });
    notice("The match you just played. It isn't saved anywhere: download it from Activity to keep it.");
  }

  function startFight(setup: Setup, plans: [Plan, Plan]): void {
    track('play_start', { game: 'fighter', opponent: `${setup.left} vs ${setup.right}` });
    mode = 'fight';
    setCta('stop');
    renderChips();
    notice(null);
    switchTo(() =>
      live(viewer, setup, plans, {
        cta,
        // The match just played: replayed here, kept nowhere else.
        watch: (r) => watchLast(r),
        again: () => startFight(setup, plans),
        change: () => openPicker(),
        ended: () => {
          setCta('fight');
          track('play_end', { game: 'fighter', opponent: `${setup.left} vs ${setup.right}` });
        },
      }),
    );
    viewer.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function openPicker(): void {
    // The recording pauses under the picker (its play button carries on).
    pause();
    const card = pickerCard({ me, hooks, signIn, poolEmpty: account.kind === 'pool-empty', close: closePicker, start: startFight });
    overlay.replaceChildren(card);
    overlay.hidden = false;
    card.querySelector<HTMLElement>('.fight-go:not([disabled])')?.focus({ preventScroll: true });
    overlay.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  cta.addEventListener('click', () => {
    if (cta.classList.contains('stop')) {
      void watch();
      return;
    }
    openPicker();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePicker();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!drawer.hidden) return setDrawer(false);
    if (!overlay.hidden) return closePicker();
  });
  window.addEventListener('hashchange', () => {
    const file = DEMO.exec(location.hash)?.[1];
    const d = demos.find((x) => x.file === file);
    if (d) {
      watching = d;
      void watch(true);
      $('#stage').scrollIntoView({ behavior: 'smooth' });
    }
  });
  audio.scene(false);
  await watch();
}
