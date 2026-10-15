// A recorded game played back in the room: a share link (#/r/<code>) or a curated replay (#/demo/<file>). Every card
// face up, as a spectator sees a finished game, with play and pause, a move at a time, the speed, and a jump to any
// hand; at the end, the end poster with its share buttons.
import type { Recording } from '../shared/recording.ts';
import { audio } from './audio.ts';
import { focusDialog, h, reducedMotion, wait } from './dom.ts';
import type { SeatConfig, TableSnapshot } from './driver.ts';
import { ReplayDriver } from './replay-driver.ts';
import { endView } from './views/end.ts';
import { reviewView } from './views/review.ts';
import { TableUI } from './views/table.ts';
import { aHand, chips, levelText, ordinal, paced, personOf } from './view-model.ts';
import { ChatBox } from './views/chat.ts';
import type { ActionMeta } from './driver.ts';

export interface ReplayOptions {
  recording: Recording;
  /** What is playing: "A shared game", or a curated replay's title. */
  title: string;
  /** Back to the lobby. */
  onLeave(): void;
}

const PLAY = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 5v14l12-7z" fill="currentColor"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>';

/** Plays a recording in `host` until the signal aborts. Throws if the recording does not replay. */
export async function playReplay(host: HTMLElement, o: ReplayOptions, signal: AbortSignal): Promise<void> {
  const driver = new ReplayDriver(o.recording);
  const seats: SeatConfig[] = o.recording.players.map((p) => ({ kind: p.kind, id: p.id }));
  let speed = 1;
  let paused = false;
  let stepOnce = false;
  let jump: number | null = null;
  let wake: (() => void) | null = null;
  const nudge = () => {
    wake?.();
    wake = null;
  };
  /** Waits while paused, until play, a single move or a jump. */
  const gate = async () => {
    while (paused && !stepOnce && jump === null && !signal.aborted) await new Promise<void>((r) => (wake = r));
    stepOnce = false;
  };
  signal.addEventListener('abort', nudge, { once: true });

  // ---------- the toolbar ----------
  const level = h('div.level', { 'aria-live': 'polite' });
  const playBtn = h('button.tbtn.icon', { type: 'button', 'aria-label': 'Pause', 'aria-pressed': 'false', title: 'Play or pause (space)' });
  const drawPlay = () => {
    playBtn.innerHTML = paused ? PLAY : PAUSE;
    playBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    stepBtn.disabled = !paused;
  };
  const stepBtn = h('button.tbtn', { type: 'button', title: 'One move (→)', onclick: () => ((stepOnce = true), nudge()) }, 'Next move') as HTMLButtonElement;
  playBtn.addEventListener('click', () => {
    paused = !paused;
    drawPlay();
    nudge();
  });
  const speedGroup = h('div.speed', { role: 'radiogroup', 'aria-label': 'Speed' });
  for (const s of [1, 2, 4, 8]) {
    speedGroup.append(
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(s === speed), onclick: (e: Event) => {
        speed = s;
        speedGroup.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b === e.currentTarget)));
      } }, `${s}×`),
    );
  }
  const handSelect = h('select.hand-pick', { 'aria-label': 'Jump to a hand' }) as HTMLSelectElement;
  for (let i = 1; i <= driver.hands; i++) handSelect.append(h('option', { value: String(i) }, `Hand ${i}`));
  handSelect.addEventListener('change', () => {
    jump = Number(handSelect.value);
    nudge();
  });
  // The table chat: the dealer's lines, and what the models said and why (every card is up in a replay).
  const chat = new ChatBox({ people: seats.map(personOf), viewer: null });
  let said: { seat: number; meta: ActionMeta } | undefined;
  const reviewBtn = h('button.tbtn', { type: 'button', onclick: () => void openReview() }, 'Review');
  const toolbar = h(
    'div.toolbar',
    null,
    h('div.replay-title', null, h('span.replay-chip', null, 'Replay'), h('b', null, o.title), level),
    h('div.tools', null, playBtn, stepBtn, speedGroup, handSelect, chat.button, reviewBtn, h('button.tbtn', { type: 'button', onclick: o.onLeave }, 'Leave')),
  );
  drawPlay();
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'SELECT' || t.tagName === 'INPUT' || t.tagName === 'BUTTON') && e.key === ' ') return;
    if (e.key === ' ') playBtn.click();
    else if (e.key === 'ArrowRight' && paused) stepBtn.click();
    else return;
    e.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  signal.addEventListener('abort', () => window.removeEventListener('keydown', onKey), { once: true });

  // ---------- the table ----------
  let ui = new TableUI({ seats, viewer: null, speed: () => speed, reduced: reducedMotion });
  const tableHost = h('div.replay-table', null, ui.el);
  host.classList.add('watching');
  host.replaceChildren(toolbar, tableHost, chat.el);

  let overlay: HTMLElement | null = null;
  const closeOverlay = () => {
    overlay?.remove();
    overlay = null;
  };
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
      body = h('div.poster', { role: 'alertdialog', 'aria-label': 'The review did not open' }, h('h2', null, 'The review did not open'), h('p.sub', null, (e as Error).message), h('div.row', null, h('button.cta', { type: 'button', onclick: back }, 'Back to the replay')));
    }
    closeOverlay();
    overlay = h('div.overlay', null, body);
    host.append(overlay);
    restore = focusDialog(overlay);
  };


  let snap: TableSnapshot;
  let shown = 0;
  let knockedOut = 0;
  const drawLevel = (s: TableSnapshot) => {
    const t = levelText(s.view.level);
    level.replaceChildren(h('span', null, 'Hand ', h('b', null, `${s.hand} of ${driver.hands}`)), h('span.blinds', null, `Blinds ${t.blinds}`));
    handSelect.value = String(s.hand);
  };
  const playNew = async (s: TableSnapshot) => {
    const fresh = s.events.slice(shown);
    shown = s.events.length;
    chat.feed(fresh, s.hand, said);
    said = undefined;
    snap = s;
    await ui.play(fresh, s);
    drawLevel(s);
  };
  const restart = async (s: TableSnapshot) => {
    ui = new TableUI({ seats, viewer: null, speed: () => speed, reduced: reducedMotion });
    tableHost.replaceChildren(ui.el);
    shown = 0;
    knockedOut = s.eliminations.length;
    await playNew(s);
  };

  await restart(await driver.start());
  while (!signal.aborted) {
    if (jump !== null) {
      const n = jump;
      jump = null;
      closeOverlay();
      await restart(await driver.jumpTo(n));
      continue;
    }
    if (snap!.view.street === 'done') {
      await endOfHand();
      if (snap!.over) {
        await wait(paced(1200, speed, reducedMotion()));
        if (signal.aborted || jump !== null) continue;
        const review = await driver.review();
        closeOverlay();
        overlay = h('div.overlay', null, endView({ review, snapshot: snap!, watching: true, source: 'replay', again: 'Watch it again', onAgain: () => ((jump = 1), nudge()), onLobby: o.onLeave, lobby: 'Play your own', onReview: () => void openReview() }));
        host.append(overlay);
        focusDialog(overlay);
        audio.play('win');
        // Wait for a jump (Watch it again, or a hand picked) or the way out.
        paused = true;
        drawPlay();
        await new Promise<void>((r) => (wake = r));
        paused = false;
        drawPlay();
        continue;
      }
      await wait(paced(2000, speed, reducedMotion()));
      await gate();
      if (jump !== null || signal.aborted) continue;
      ui.relax();
      shown = 0;
      await playNew(await driver.nextHand());
      continue;
    }
    await gate();
    if (jump !== null || signal.aborted) continue;
    const seat = snap!.view.toAct!;
    const next = o.recording.hands[snap!.hand - 1]!.actions[driver.position().move];
    // The player's own talk said before this move (a recording keeps it: hands[i].talk), in the chat as it was said.
    for (const t of o.recording.hands[snap!.hand - 1]!.talk ?? []) if (t.after === driver.position().move) chat.heard(t.seat, t.say);
    // A moment to think: the move's own latency, shortened, at the replay's speed.
    ui.thinking(seat, null);
    await wait(paced(Math.min(1400, 350 + (next?.latencyMs ?? 0) / 4), speed, reducedMotion()));
    ui.stopThinking(seat);
    const r = await driver.step();
    ui.showMeta(r.seat, r.meta);
    said = { seat: r.seat, meta: r.meta };
    await playNew(r.snapshot);
  }

  /** Who won the hand, and who went out. */
  async function endOfHand(): Promise<void> {
    const awards = snap!.view.awards;
    const shownHands = new Map(snap!.events.flatMap((e) => (e.type === 'showdown' ? e.hands.map((x) => [x.seat, x.category] as const) : [])));
    const main = awards[0];
    if (main) {
      const total = awards.filter((a) => a.winners.join() === main.winners.join()).reduce((a, x) => a + x.amount, 0);
      const who = main.winners.map((w) => ui.nameOf(w)).join(' and ');
      const cat = shownHands.get(main.winners[0]!);
      ui.banner(`${who} ${main.winners.length > 1 ? 'split' : 'wins'} ${chips(total)}`, cat ? `with ${aHand(cat)}` : 'Everyone else folded');
    }
    for (const e of snap!.eliminations.slice(knockedOut)) {
      await wait(paced(1300, speed, reducedMotion()));
      audio.play('bust');
      const by = e.by.map((s) => ui.nameOf(s)).join(' and ');
      ui.banner(by ? `${by} knocks out ${ui.nameOf(e.seat)}` : `${ui.nameOf(e.seat)} is out`, `${ui.nameOf(e.seat)} finishes ${ordinal(e.place)}`, 'ko');
    }
    knockedOut = snap!.eliminations.length;
  }
}
