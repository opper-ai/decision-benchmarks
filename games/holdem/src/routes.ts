// The page's second script (after main.ts): the Replays and Leaderboard sections, and the replay routes. A share link
// (#/r/<code>) or a curated replay (#/demo/<file>) takes the room over from the lobby main.ts drew; leaving a replay,
// or opening one while a table is live, loads the page afresh, so a replay never shares the room with a running game.
// #/still/<file>[?hand=<n>&kind=<highlight kind>] draws the poster from a curated replay's best moment (or hand n's, or
// the best of a kind), alone over the page at
// 1280×720 (poster.ts; scripts/poster.ts photographs it).
import { appPath } from '../../../packages/kit/client/paths.ts';
import { track } from '../../../packages/kit/client/track.ts';
import { h } from './dom.ts';
import { posterData, posterLayout, POSTER_H, POSTER_W } from './poster.ts';
import { ReplayDriver } from './replay-driver.ts';
import { playReplay } from './replay-view.ts';
import { canvasMeasure, drawItems, loadFaces, loadFonts } from './share-image.ts';
import { isRouteHash, parseRoute, tidyRouteHash, type Route } from './route-hash.ts';
import { decodeGame } from './share.ts';
import { mountLeaderboard } from './views/leaderboard.ts';
import { DEMO_FILE, loadDemo, parseDemoIndex, watchList, type DemoEntry } from './views/watch-list.ts';


const room = document.querySelector<HTMLElement>('#room')!;
let entries: DemoEntry[] = [];

/** Back to the page without a route: the lobby. */
function leave(): void {
  history.replaceState(null, '', location.pathname + location.search);
  location.reload();
}

/** A route's replay in the room, or a poster saying why it can't play. */
async function route(): Promise<void> {
  // Every route-looking address draws something: main.ts drew no lobby for it.
  const r = parseRoute(location.hash);
  if (!r) return;
  // A link with a ")" or "." from the sentence it was pasted in: the address as it should be.
  const tidy = tidyRouteHash(location.hash);
  if (tidy !== location.hash) history.replaceState(null, '', location.pathname + location.search + tidy);
  if (r.kind === 'still') return still(r);
  room.scrollIntoView({ block: 'start' });
  const ac = new AbortController();
  try {
    if (r.kind === 'broken') throw new Error('The link is not complete. Copy the whole link and open it again.');
    if (r.kind === 'link') {
      const decoded = decodeGame(r.code);
      if (!decoded.ok) throw new Error(decoded.error);
      track('replay_open', { game: 'holdem', kind: 'link' });
      await playReplay(room, { recording: decoded.recording, title: 'A shared game', onLeave: leave }, ac.signal);
      return;
    }
    const file = decodeURIComponent(r.file);
    if (!DEMO_FILE.test(file)) throw new Error('There is no such replay.');
    const entry = entries.find((e) => e.file === file);
    const recording = await loadDemo(appPath(`/demo/${file}`));
    track('replay_open', { game: 'holdem', kind: 'demo', file });
    await playReplay(room, { recording, title: entry?.title ?? 'A recorded game', onLeave: leave }, ac.signal);
  } catch (e) {
    ac.abort();
    room.classList.remove('watching');
    room.replaceChildren(
      h('div.route-error', null, h('div.poster', { role: 'alert' }, h('h2', null, 'This game does not open'), h('p.sub', null, (e as Error).message), h('div.row', null, h('button.cta', { type: 'button', onclick: leave }, 'Back to the lobby')))),
    );
  }
}

/** The poster from a curated replay, alone over the page at 1280×720; <html data-still> says when it is drawn (or why not). */
async function still(r: Extract<Route, { kind: 'still' }>): Promise<void> {
  const file = decodeURIComponent(r.file);
  const params = new URLSearchParams(r.query);
  const hand = Number(params.get('hand')) || undefined;
  const kind = (['bluff', 'semi_bluff', 'hero_call', 'bad_beat', 'folded_winner', 'cooler', 'biggest_pot'] as const).find((k) => k === params.get('kind'));
  const host = h('div', { style: `position:fixed;inset:0;z-index:10000;background:#1c100a;overflow:hidden` });
  document.body.append(host);
  try {
    if (!DEMO_FILE.test(file)) throw new Error('There is no such replay.');
    const driver = new ReplayDriver(await loadDemo(appPath(`/demo/${file}`)));
    await driver.jumpTo(driver.hands);
    while (driver.snapshot().view.toAct !== null) await driver.step();
    const data = posterData(await driver.review(), hand, kind);
    if (!data) throw new Error('This replay has no moment to show.');
    await loadFonts();
    const items = posterLayout(data, canvasMeasure());
    const canvas = h('canvas', { width: String(POSTER_W), height: String(POSTER_H), style: `display:block;width:${POSTER_W}px;height:${POSTER_H}px` }) as HTMLCanvasElement;
    drawItems(canvas.getContext('2d')!, items, await loadFaces(items, appPath));
    host.append(canvas);
    document.documentElement.dataset.still = 'ready';
  } catch (e) {
    host.append(h('p', { style: 'color:#f3e8cd;font:20px sans-serif;padding:24px' }, (e as Error).message));
    document.documentElement.dataset.still = 'failed';
  }
}

async function replays(): Promise<void> {
  const host = document.querySelector<HTMLElement>('#replays-list');
  if (!host) return;
  try {
    const res = await fetch(appPath('/demo/index.json'));
    entries = res.ok ? parseDemoIndex(await res.json()) : [];
  } catch {
    entries = [];
  }
  host.replaceChildren(
    watchList({
      entries,
      onOpen: (e) => (location.hash = `#/demo/${encodeURIComponent(e.file)}`),
    }),
  );
}

const table = document.querySelector<HTMLTableElement>('#leaderboard-table');
if (table) void mountLeaderboard(table, appPath);
// The list first, so a replay knows its title.
void replays().then(route);
// Into a route, out of one (Back from a replay), or from one route to another: the page loads afresh, so the room
// holds either the lobby or the replay, never a replay with the lobby's address.
let current = location.hash;
window.addEventListener('hashchange', () => {
  const was = current;
  current = location.hash;
  if (isRouteHash(location.hash) || isRouteHash(was)) location.reload();
});
