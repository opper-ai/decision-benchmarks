import { downloadReplay } from '../api.ts';
import { TICK_MS } from '../../shared/match.ts';
import { ReplayPlayer, type Decision, type Replay } from '../../shared/replay.ts';
import { clockTime, h, money } from '../dom.ts';
import { Stage } from '../stage.ts';
import { bubblesAt, decisionsBySide } from './bubbles.ts';
import { decisionCard } from './decisions.ts';
import { statsView } from './stats.ts';
import { Timeline } from './timeline.ts';
import { soundTool } from './audio-toggles.ts';
import { audio } from '../audio.ts';
import { clipName, exportClip, exportSupported } from '../export.ts';
import { OUTCOME_COLORS } from '../theme.ts';
import { fullscreenButton } from './fullscreen.ts';
import { activityDrawer } from './panel.ts';
import { clipLink, videoButton, type Clip } from './save.ts';
import { floorLabel, ICONS, menuTool, stageShell, toolButton } from './shell.ts';

export interface ReplayOptions {
  /** The recording's address on this page, for a recorded match (Copy link). */
  link?: string;
  music?: boolean;
  /** The page's primary button, shown on the stage's floor. */
  cta?: HTMLElement;
  /** What the floor says is on: a recording, or the match the visitor just played. */
  kind?: 'replay' | 'yours';
  /** A recorded match's highlight, made ahead (public/clips), to save as a video or a GIF. */
  clip?: Clip | null;
}

/**
 * A match played back: the stage with its tools on the floor, and under it Activity (the decisions, the stats, the
 * timeline, the downloads), folded away until asked for.
 */
export function replayView(host: HTMLElement, r: Replay, opts: ReplayOptions = {}): (() => void) & { pause: () => void } {
  const player = new ReplayPlayer(r);
  const bySide = decisionsBySide(r);
  const stageHost = h('div.fstage.pausable', { title: 'Click to play or pause (space)' });
  const stage = new Stage(stageHost, r.fighters);
  // Paused: a large play sign over the stage. A toggle also flashes the new state's sign for a moment.
  const pausedSign = h('div.stage-paused', { 'aria-hidden': 'true' }, h('span', { html: ICONS.play }));
  const flash = h('div.stage-flash', { 'aria-hidden': 'true' });
  // The progress line on the stage's bottom edge: drag it to seek. The full timeline is in Activity.
  const progFill = h('i');
  const prog = h('div.prog', { title: 'Drag to seek' }, progFill);
  stageHost.append(pausedSign, flash, prog);
  let state = player.stateAt(0);
  let pos = 0;
  let playing = true;
  let speed = 1;

  const playTool = toolButton('Pause', ICONS.pause);
  playTool.classList.add('tool-play');
  const thoughtsTool = toolButton('Thoughts (T)', ICONS.thoughts);
  thoughtsTool.setAttribute('aria-pressed', 'true');
  // Speed: a square tool showing the speed, opening the five to pick from.
  const speedBtn = toolButton('Speed', '1×');
  speedBtn.classList.add('txt');
  const speeds: [number, string][] = [[0.25, '¼×'], [0.5, '½×'], [1, '1×'], [2, '2×'], [4, '4×']];
  const speedOpts = speeds.map(([x, short]) => {
    const b = h('button.tmenu-opt', { type: 'button', role: 'menuitemradio', 'aria-checked': String(x === 1) }, h('span', null, `${x}×`), x === 1 ? h('small', null, 'normal') : null);
    b.addEventListener('click', () => {
      speed = x;
      stage.tickMs = TICK_MS / x;
      speedBtn.textContent = short;
      speedOpts.forEach((o, k) => o.setAttribute('aria-checked', String(speeds[k]![0] === x)));
      speedMenu.close();
    });
    return b;
  });
  const speedMenu = menuTool(speedBtn, h('div', { 'aria-label': 'Speed' }, ...speedOpts));
  // Save: the highlight as a video or a GIF (made ahead for a recorded match; for the match just played, its video is
  // made here), or a clip of your own choosing (the export panel under the stage).
  const saveBtn = toolButton('Save a video or a GIF', ICONS.download);
  const customClip = h('button.tmenu-opt', { type: 'button', role: 'menuitem' }, h('span.tmenu-icon', { html: ICONS.scissors }), h('span', null, 'Custom clip…'));
  const saveMenu = menuTool(
    saveBtn,
    h(
      'div',
      { 'aria-label': 'Save' },
      h('p.tmenu-title', null, opts.clip ? 'Its best 18 seconds' : 'Your match'),
      ...(opts.clip ? [clipLink(opts.clip, 'mp4', 'floor'), clipLink(opts.clip, 'gif', 'floor')] : [videoButton(r, 'floor')]),
      customClip,
    ),
  );
  const timeEl = h('span.time');
  const timeline = new Timeline(r, player.events, (t) => seek(t));

  const setThoughts = (on: boolean) => {
    stage.renderer.showBubbles = on;
    thoughtsTool.setAttribute('aria-pressed', String(on));
  };
  const setPlaying = (p: boolean) => {
    playing = p && state.round.phase !== 'over';
    playTool.innerHTML = playing ? ICONS.pause : ICONS.play;
    playTool.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    playTool.title = playing ? 'Pause (space)' : 'Play (space)';
    stage.paused = !playing;
    stageHost.classList.toggle('paused', !playing);
    // The music and the effects stand still with the fight.
    audio.hold(!playing);
  };
  const togglePlay = () => {
    if (state.round.phase === 'over') seek(0);
    setPlaying(!playing);
  };
  /** Play or pause from the stage or the keyboard, with a flash of the new state on the stage. */
  const toggle = () => {
    togglePlay();
    flash.innerHTML = playing ? ICONS.play : ICONS.pause;
    flash.classList.remove('show');
    void flash.offsetWidth; // restart the animation
    flash.classList.add('show');
  };

  function seek(t: number): void {
    state = player.stateAt(t);
    pos = state.tick;
    stage.jump(state);
    sync(true);
  }

  const nextDecision = (dir: 1 | -1) => {
    const ticks = r.decisions.map((d) => d.appliedTick).filter((t) => (dir > 0 ? t > state.tick : t < state.tick - 1));
    if (!ticks.length) return;
    seek(dir > 0 ? Math.min(...ticks) : Math.max(...ticks));
    setPlaying(false);
  };

  // The decision feed: every move, or only the key moments (where something happened).
  let keyOnly = true;
  const feed = h('div.feed');
  const cards: { d: Decision; el: HTMLElement }[] = [];
  const buildFeed = () => {
    feed.replaceChildren();
    cards.length = 0;
    for (const d of r.decisions) {
      if (keyOnly && (!d.outcome || d.outcome === 'neutral') && !d.fallback) continue;
      const el = decisionCard(d, r.fighters, (t) => {
        seek(t);
        setPlaying(false);
      });
      cards.push({ d, el });
      feed.append(el);
    }
  };
  let userScrolledAt = 0;
  feed.addEventListener('wheel', () => (userScrolledAt = performance.now()), { passive: true });
  feed.addEventListener('touchmove', () => (userScrolledAt = performance.now()), { passive: true });
  let lastCurrent: HTMLElement | null = null;

  // The result only shows once the match has played to its end: the facts must not spoil it.
  const winner = r.result.winner === null ? 'a draw' : `${r.fighters[r.result.winner].label} wins`;
  const resultEl = h('span.result', { hidden: true }, ` · ${winner}`);

  function sync(force = false): void {
    timeEl.textContent = `${clockTime(state.tick)} / ${clockTime(r.ticks)}`;
    progFill.style.width = `${(state.tick / Math.max(1, r.ticks)) * 100}%`;
    resultEl.hidden = state.tick < player.endTick;
    timeline.head = state.tick;
    timeline.draw();
    // Current decision in the feed.
    let cur: HTMLElement | null = null;
    for (const c of cards) if (c.d.appliedTick <= state.tick) cur = c.el;
    if (cur !== lastCurrent) {
      lastCurrent?.classList.remove('current');
      cur?.classList.add('current');
      lastCurrent = cur;
      if (cur && feed.clientHeight && (force || performance.now() - userScrolledAt > 4000)) feed.scrollTop = cur.offsetTop - feed.clientHeight / 2;
    }
    updateBubbles();
  }

  /** Thought bubbles from the decision log, aged by replay time. */
  function updateBubbles(): void {
    const b = bubblesAt(bySide, state.tick, performance.now());
    stage.renderer.bubbles[0] = b[0];
    stage.renderer.bubbles[1] = b[1];
  }

  stage.onFrame = (dt) => {
    if (!playing) {
      // Keep bubble ages pinned to the replay time while paused.
      updateBubbles();
      return;
    }
    pos += dt * 60 * speed;
    let advanced = false;
    while (state.tick < Math.floor(pos) && state.round.phase !== 'over') {
      const events = player.advance(state);
      stage.tick(state, events);
      advanced = true;
    }
    if (state.round.phase === 'over' && state.tick >= player.endTick) setPlaying(false);
    if (advanced) sync();
  };
  stage.tick(state);

  playTool.addEventListener('click', togglePlay);
  thoughtsTool.addEventListener('click', () => setThoughts(!stage.renderer.showBubbles));
  stageHost.addEventListener('click', () => toggle());

  let dragging = false;
  const seekAt = (ev: PointerEvent) => {
    const rect = prog.getBoundingClientRect();
    seek(Math.max(0, Math.min(r.ticks, Math.round(((ev.clientX - rect.left) / rect.width) * r.ticks))));
  };
  prog.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation();
    dragging = true;
    prog.setPointerCapture(ev.pointerId);
    seekAt(ev);
  });
  prog.addEventListener('pointermove', (ev) => dragging && seekAt(ev));
  prog.addEventListener('pointerup', () => (dragging = false));
  // A seek is no play/pause.
  prog.addEventListener('click', (ev) => ev.stopPropagation());

  // Space, [ ] and T work while nothing else has focus (the page itself) or the viewer has it (a click in it gives it
  // focus). A focused button, link or field keeps its own keys, and a dialog over the page (the picker) keeps them all.
  // The arrows only work in the viewer, so they still scroll the page elsewhere.
  if (!host.hasAttribute('tabindex')) host.tabIndex = -1;
  const onPointer = (e: PointerEvent) => {
    if (!(e.target as HTMLElement).closest('button,a,input,select,textarea,summary')) host.focus({ preventScroll: true });
  };
  host.addEventListener('pointerdown', onPointer);
  const onKey = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
    const active = document.activeElement;
    const inViewer = host.contains(active);
    if (!inViewer && active !== document.body && active !== null && active !== document.documentElement) return;
    if ((e.target as HTMLElement)?.closest?.('input,select,textarea,button,a,summary,[contenteditable]')) return;
    if (document.querySelector('[role="dialog"]')) return;
    if (e.key === ' ') {
      e.preventDefault();
      toggle();
    } else if (!inViewer && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      return;
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setPlaying(false);
      seek(Math.max(0, Math.min(r.ticks, state.tick + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 60 : 1))));
    } else if (e.key === ']') nextDecision(1);
    else if (e.key === '[') nextDecision(-1);
    else if (e.key === 't' || e.key === 'T') setThoughts(!stage.renderer.showBubbles);
  };
  window.addEventListener('keydown', onKey);

  // The stage, its floor and its tools.
  const { box, tools } = stageShell(stageHost, floorLabel(opts.kind === 'yours' ? 'Your match' : 'Replay', r.fighters), opts.cta ?? null);
  const fs = fullscreenButton(box);
  fs.el.className = 'tbtn';
  tools.append(playTool, thoughtsTool, speedMenu.el, soundTool(), saveMenu.el, fs.el);

  // Export: the clip settings open under the stage.
  const exportPanel = h('div.export', { hidden: true });
  const toggleExport = () => {
    // The export settings sit under the stage, out of sight in fullscreen.
    fs.exit();
    exportPanel.hidden = !exportPanel.hidden;
    if (!exportPanel.hidden) {
      setPlaying(false);
      fillExport();
      exportPanel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  };
  customClip.addEventListener('click', toggleExport);
  function fillExport(): void {
    if (!exportSupported()) {
      exportPanel.replaceChildren(h('p.fnote', null, 'This browser cannot encode video. Use a recent Chrome, Edge or Safari.'));
      return;
    }
    const range = h(
      'select',
      { id: 'x-range' },
      ...[
        ['10', 'From here, 10 s'],
        ['20', 'From here, 20 s'],
        ['30', 'From here, 30 s'],
        ['rest', 'From here to the end'],
        ['all', 'Whole match'],
      ].map(([v, t]) => h('option', { value: v, selected: v === '20' }, t)),
    ) as HTMLSelectElement;
    const size = h('select', { id: 'x-size' }, h('option', { value: '1280x720', selected: true }, '720p'), h('option', { value: '1920x1080' }, '1080p'), h('option', { value: '1080x1080' }, 'Square 1080')) as HTMLSelectElement;
    const fps = h('select', { id: 'x-fps' }, h('option', { value: '60', selected: true }, '60 fps'), h('option', { value: '30' }, '30 fps')) as HTMLSelectElement;
    const sfx = h('input', { type: 'checkbox', checked: audio.settings.sound }) as HTMLInputElement;
    const mus = h('input', { type: 'checkbox', checked: audio.settings.music }) as HTMLInputElement;
    const bub = h('input', { type: 'checkbox', checked: stage.renderer.showBubbles }) as HTMLInputElement;
    const go = h('button.fbtn.primary', { type: 'button' }, 'Render');
    const status = h('div.export-status');
    const bar = h('div.progress', null, h('span'));
    let controller: AbortController | null = null;
    go.addEventListener('click', async () => {
      if (controller) {
        controller.abort();
        return;
      }
      const from = range.value === 'all' ? 0 : state.tick;
      const to = range.value === 'all' || range.value === 'rest' ? r.ticks : Math.min(r.ticks, from + Number(range.value) * 60);
      const [w, hh] = size.value.split('x').map(Number);
      controller = new AbortController();
      go.textContent = 'Cancel';
      status.textContent = '';
      status.append(bar);
      const fill = bar.firstElementChild as HTMLElement;
      const t0 = performance.now();
      try {
        const blob = await exportClip(r, player, {
          from,
          to,
          width: w,
          height: hh,
          fps: Number(fps.value) as 30 | 60,
          sound: sfx.checked,
          music: mus.checked,
          bubbles: bub.checked,
          signal: controller.signal,
          onProgress: (f, phase) => {
            fill.style.width = `${Math.round(f * 100)}%`;
            fill.dataset.phase = phase;
          },
        });
        const url = URL.createObjectURL(blob);
        const name = clipName(r, from);
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        status.replaceChildren(
          h('a.fbtn.primary', { href: url, download: name }, 'Download'),
          h('span.fnote', null, ` ${name}, ${(blob.size / 1e6).toFixed(1)} MB, rendered in ${secs} s`),
          h('video.preview', { src: url, controls: true, playsinline: true }),
        );
      } catch (e) {
        status.replaceChildren(h('span.fnote', null, (e as Error).name === 'AbortError' ? 'Cancelled.' : `Export failed: ${(e as Error).message}`));
      } finally {
        controller = null;
        go.textContent = 'Render';
      }
    });
    exportPanel.replaceChildren(
      h('div.export-head', null, h('p.kicker', null, 'Save a clip'), h('button.linkish', { type: 'button', onclick: () => toggleExport() }, 'Close')),
      h('div.export-row', null, h('label', null, 'Range', range), h('label', null, 'Size', size), h('label', null, 'Frame rate', fps)),
      h('div.export-row', null, h('label.check', null, sfx, ' Sound effects'), h('label.check', null, mus, ' Music'), h('label.check', null, bub, ' Thought bubbles')),
      h('div.export-row', null, go, h('span.fnote', null, 'Rendered frame by frame in your browser, usually faster than real time.')),
      status,
    );
  }

  // Activity: tabs and the match's facts, the timeline with step by decision, then the feed (or the stats) beside what
  // the colors mean and the downloads.
  const tabEvery = h('button.dtab', { type: 'button', role: 'tab' }, 'Every move');
  const tabKey = h('button.dtab', { type: 'button', role: 'tab' }, 'Key moments');
  const tabStats = h('button.dtab', { type: 'button', role: 'tab' }, 'Stats');
  const mainEl = h('div.drawer-main.panel-body');
  const selectTab = (t: HTMLElement) => {
    for (const x of [tabEvery, tabKey, tabStats]) x.setAttribute('aria-selected', String(x === t));
  };
  const showFeed = (key: boolean) => {
    keyOnly = key;
    buildFeed();
    selectTab(key ? tabKey : tabEvery);
    mainEl.replaceChildren(feed);
    lastCurrent = null;
    sync(true);
  };
  let statsEl: HTMLElement | null = null;
  const showStats = () => {
    selectTab(tabStats);
    statsEl ??= statsView(r, player.events);
    mainEl.replaceChildren(statsEl);
  };
  tabEvery.addEventListener('click', () => showFeed(false));
  tabKey.addEventListener('click', () => showFeed(true));
  tabStats.addEventListener('click', showStats);

  const facts = h(
    'span.facts',
    null,
    `${r.decisions.length} decisions · ${money(r.costUsd)} · ${r.mode === 'paused' ? 'paused' : 'real time'} · ${r.track ?? 'assisted'} track · ${r.deadlineMs} ms deadline`,
    resultEl,
    player.diverged !== null ? h('strong.warn', null, ` · Replay diverged at ${clockTime(player.diverged)}`) : '',
  );
  const legend = h(
    'div.legend',
    null,
    ...['hit', 'traded', 'punished', 'blocked', 'whiffed', 'defended'].map((o) => h('span', null, h('span.sq', { style: { background: OUTCOME_COLORS[o] } }), o === 'punished' ? 'got hit' : o)),
    h('span', null, h('span.sq.ko'), 'KO'),
  );
  // The match as data (it replays exactly, so anyone can check the result): for developers, so the quietest.
  const rawRecording = h('button.linkish.raw', { type: 'button', title: 'The whole match as a gzipped JSON recording: it replays exactly', onclick: () => void downloadReplay(r) }, 'Raw recording (.fight.json.gz)');
  let copyLink: HTMLElement | null = null;
  if (opts.link) {
    const href = new URL(opts.link, location.href).href;
    const btn = h('button.fbtn', { type: 'button' }, h('span.ico', { html: ICONS.link }), 'Copy link');
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(href);
        btn.lastChild!.textContent = 'Copied';
        setTimeout(() => (btn.lastChild!.textContent = 'Copy link'), 1600);
      } catch {
        // No clipboard here: show the link itself.
        btn.replaceWith(h('a.fbtn', { href }, h('span.ico', { html: ICONS.link }), 'Link to this match'));
      }
    });
    copyLink = btn;
  }
  const body = h(
    'div.drawer-body',
    null,
    h('div.drawer-head', null, h('div.dtabs', { role: 'tablist', 'aria-label': 'Activity' }, tabEvery, tabKey, tabStats), facts),
    h(
      'div.drawer-step',
      null,
      h('button.fbtn.icon', { type: 'button', title: 'Previous decision ([)', 'aria-label': 'Previous decision', html: ICONS.prev, onclick: () => nextDecision(-1) }),
      h('button.fbtn.icon', { type: 'button', title: 'Next decision (])', 'aria-label': 'Next decision', html: ICONS.next, onclick: () => nextDecision(1) }),
      timeEl,
      timeline.el,
    ),
    h(
      'div.drawer-cols',
      null,
      mainEl,
      h('aside.drawer-side', null, h('div.side-block', null, h('p.kicker', null, 'What the colors mean'), legend), h('div.side-block', null, h('p.kicker', null, 'Save and share'), h('div.save-btns', null, ...(opts.clip ? [clipLink(opts.clip, 'mp4', 'activity', 'pill'), clipLink(opts.clip, 'gif', 'activity', 'pill')] : [videoButton(r, 'activity', 'pill')]), copyLink, rawRecording))),
    ),
  );

  const viewer = h('div.viewer');
  const act = activityDrawer(viewer, body);
  viewer.append(box, act.drawer, act.tab, exportPanel);
  host.replaceChildren(viewer);
  showFeed(true);
  act.onOpen(() => {
    lastCurrent = null;
    sync(true);
  });
  const at = Number(new URLSearchParams(location.hash.split('?')[1] ?? '').get('t'));
  if (at > 0) {
    seek(Math.min(r.ticks, at));
    setPlaying(false);
  } else {
    setPlaying(true);
  }
  audio.scene(opts.music ?? true);
  const stop = () => {
    audio.scene(false);
    audio.hold(false);
    fs.destroy();
    speedMenu.destroy();
    saveMenu.destroy();
    window.removeEventListener('keydown', onKey);
    host.removeEventListener('pointerdown', onPointer);
    stage.destroy();
  };
  return Object.assign(stop, { pause: () => setPlaying(false) });
}
