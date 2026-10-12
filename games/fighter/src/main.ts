import { POOL_EMPTY_NOTICE, poolAmount, signIn, signOut, takeAuthError, walletNotice } from '../../../packages/kit/client/auth.ts';
import type { TransportHooks } from '../../../packages/kit/client/transport.ts';
import type { Replay } from '../shared/replay.ts';
import { getDemo, getMe, type Me } from './api.ts';
import { audio } from './audio.ts';
import { h } from './dom.ts';
import './style.css';
import { fightView } from './views/fight.ts';
import { leaderboardView } from './views/leaderboard.ts';
import { posesView } from './views/poses.ts';
import { replayView } from './views/replay.ts';
import { stillView } from './views/still.ts';
import { watchView } from './views/watch.ts';

// One page, routed by the address's hash (#/watch, #/leaderboard, ...), so it works below any base path.
const app = document.getElementById('app')!;
let me: Me = { mode: 'none', walletUrl: 'https://platform.opper.ai/wallet', loginAvailable: false };
let notice: { text: string; link?: string } | null = null;
let cleanup: () => void = () => {};
/** The match just played on this page: Watch can replay it, nothing else keeps it. */
let lastMatch: Replay | null = null;

const account = h('div.account', { 'aria-live': 'polite' });

/** Who plays the models: the free credits, your Opper account or the local key; and sign in or out. */
function paintAccount(): void {
  const parts: (Node | string)[] = [];
  if (me.mode === 'player') {
    parts.push(h('span', null, me.user?.email ?? me.user?.name ?? 'Signed in'), h('button.btn.small', { type: 'button', onclick: () => void signOut() }, 'Sign out'));
  } else {
    if (me.mode === 'pool') {
      const amount = me.pool?.open === false ? null : poolAmount(me.pool?.remainingUsd ?? null);
      parts.push(h('span.credits', { title: 'Free credits: a shared pool for everyone to try the models' }, me.pool?.open === false ? 'Free credits used up' : `Free credits${amount ? ` ${amount}` : ''}`));
    } else if (me.mode === 'dev') parts.push(h('span.badge', { title: 'Models play on the key in .env' }, 'Local key'));
    if (me.loginAvailable) parts.push(h('button.btn.small.primary', { type: 'button', onclick: signIn }, 'Login with Opper'));
  }
  if (notice) parts.push(notice.link ? h('a.notice', { href: notice.link, target: '_blank', rel: 'noopener' }, notice.text) : h('span.notice', null, notice.text));
  account.replaceChildren(...parts);
}

const setNotice = (text: string, link?: string) => {
  notice = { text, ...(link ? { link } : {}) };
  paintAccount();
};

/** What the transport tells the page when a model call cannot be paid for. */
const hooks: TransportHooks = {
  onSignedOut: () => {
    me = { ...me, mode: me.pool ? 'pool' : 'none', user: undefined };
    setNotice('Your Opper sign-in has expired. Sign in again to keep playing.');
  },
  onPoolEmpty: () => {
    if (me.pool) me = { ...me, pool: { ...me.pool, open: false } };
    setNotice(POOL_EMPTY_NOTICE);
  },
  onWalletEmpty: (url) => {
    const w = walletNotice(url);
    setNotice(w.notice, w.noticeLink);
  },
};

function header(path: string): HTMLElement {
  const link = (href: string, text: string, active: boolean) => h(`a.nav${active ? '.active' : ''}`, { href }, text);
  const toggle = (key: 'sound' | 'music', label: string, icon: string) => {
    const b = h('button.btn.small.toggle', { type: 'button', 'aria-pressed': String(audio.settings[key]), title: `${label} on/off`, html: `${icon}<span>${label}</span>` });
    b.addEventListener('click', () => audio.set({ [key]: !audio.settings[key] }));
    audio.onChange(() => b.setAttribute('aria-pressed', String(audio.settings[key])));
    return b;
  };
  const SPEAKER = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
  const NOTE = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M9 18V6l11-2v12" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="17.5" cy="16" r="2.5" fill="currentColor"/></svg>';
  return h(
    'header.top',
    null,
    h('a.logo', { href: '#/' }, 'Jev Fighter'),
    h('nav', null, link('#/', 'Play', path === '/' || path === ''), link('#/watch', 'Watch', path.startsWith('/watch') || path === '/replay'), link('#/leaderboard', 'Leaderboard', path === '/leaderboard')),
    h('div.audio-toggles', null, toggle('sound', 'Sound', SPEAKER), toggle('music', 'Music', NOTE)),
    account,
  );
}

async function route(): Promise<void> {
  cleanup();
  cleanup = () => {};
  audio.scene(false);
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/';
  // A recorded match's frame on its own, filling the window (#/still/<file>?t=<tick>): for posters and embeds.
  const still = /^\/still\/([a-z0-9][a-z0-9-]*\.fight\.json\.gz)$/.exec(path);
  if (still) {
    const r = await getDemo(still[1]!).catch(() => null);
    if (r) cleanup = stillView(app, r, Number(new URLSearchParams(location.hash.split('?')[1] ?? '').get('t')) || 0);
    return;
  }
  const main = h('main');
  app.replaceChildren(header(path), main);
  paintAccount();
  const demo = /^\/watch\/([a-z0-9][a-z0-9-]*\.fight\.json\.gz)$/.exec(path);
  try {
    if (demo) {
      main.append(h('p.note.page', null, 'Loading the match...'));
      const r = await getDemo(demo[1]!);
      cleanup = replayView(main, r, { link: `#/watch/${demo[1]}` });
    } else if (path === '/replay' && lastMatch) {
      cleanup = replayView(main, lastMatch, { note: 'The match you just played. It is not saved anywhere: download it to keep it.' });
    } else if (path.startsWith('/watch')) {
      await watchView(main);
    } else if (path === '/leaderboard') {
      await leaderboardView(main);
    } else if (path === '/poses') {
      posesView(main);
    } else {
      cleanup = fightView(main, {
        me,
        hooks,
        signIn,
        watch: (r) => {
          lastMatch = r;
          navigate('#/replay');
        },
        navigate,
      });
    }
  } catch (e) {
    main.replaceChildren(h('div.page', null, h('h1', null, 'Something went wrong'), h('p', null, (e as Error).message)));
  }
}

/** Goes to `hash`; going to the page already shown starts it afresh (a new fight). */
export function navigate(hash: string): void {
  if (location.hash === hash || (hash === '#/' && !location.hash)) void route();
  else location.hash = hash;
}

window.addEventListener('hashchange', () => void route());

const authError = takeAuthError();
if (authError) notice = { text: authError };
me = await getMe();
if (me.unavailable && !notice) notice = { text: "Couldn't reach the server" };
void route();
