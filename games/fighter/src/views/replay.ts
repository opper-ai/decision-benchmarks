import { downloadReplay } from '../api.ts';
import { TICK_MS } from '../../shared/match.ts';
import { ReplayPlayer, type Decision, type Replay } from '../../shared/replay.ts';
import { clockTime, h, money } from '../dom.ts';
import { Stage } from '../stage.ts';
import { bubblesAt, decisionsBySide } from './bubbles.ts';
import { decisionCard } from './decisions.ts';
import { statsView } from './stats.ts';
import { Timeline } from './timeline.ts';
import { audio } from '../audio.ts';
import { clipName, exportClip, exportSupported } from '../export.ts';
import { OUTCOME_COLORS, SIDES } from '../theme.ts';

/** A match played back: the stage, the decisions, stats and clip export. `link` is its address, for a recorded one. */
export function replayView(host: HTMLElement, r: Replay, opts: { link?: string; note?: string } = {}): () => void {
  const player = new ReplayPlayer(r);
  const bySide = decisionsBySide(r);
  const stageHost = h('div.stage-wrap');
  const stage = new Stage(stageHost, r.fighters);
  let state = player.stateAt(0);
  let pos = 0;
  let playing = true;
  let speed = 1;

  const playBtn = h('button.btn.icon', { type: 'button', title: 'Play / pause (space)' }, '❚❚');
  const timeEl = h('span.time');
  const speedSel = h('select.speed', { title: 'Speed' }, ...[0.25, 0.5, 1, 2, 4].map((x) => h('option', { value: x, selected: x === 1 }, `${x}x`)));
  const bubblesBox = h('input', { type: 'checkbox', checked: true, id: 'bubbles' }) as HTMLInputElement;
  const timeline = new Timeline(r, player.events, (t) => seek(t));

  const setPlaying = (p: boolean) => {
    playing = p && state.round.phase !== 'over';
    playBtn.textContent = playing ? '❚❚' : '▶';
    stage.paused = !playing;
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

  // Decision feed.
  const hideNeutral = h('input', { type: 'checkbox', checked: true, id: 'hide-neutral' }) as HTMLInputElement;
  const feed = h('div.feed');
  const cards: { d: Decision; el: HTMLElement }[] = [];
  const buildFeed = () => {
    feed.replaceChildren();
    cards.length = 0;
    for (const d of r.decisions) {
      if (hideNeutral.checked && (!d.outcome || d.outcome === 'neutral') && !d.fallback) continue;
      const el = decisionCard(d, r.fighters, (t) => {
        seek(t);
        setPlaying(false);
      });
      cards.push({ d, el });
      feed.append(el);
    }
  };
  hideNeutral.addEventListener('change', buildFeed);
  buildFeed();
  let userScrolledAt = 0;
  feed.addEventListener('wheel', () => (userScrolledAt = performance.now()), { passive: true });
  feed.addEventListener('touchmove', () => (userScrolledAt = performance.now()), { passive: true });
  let lastCurrent: HTMLElement | null = null;

  function sync(force = false): void {
    timeEl.textContent = `${clockTime(state.tick)} / ${clockTime(r.ticks)}`;
    timeline.head = state.tick;
    timeline.draw();
    // Current decision in the feed.
    let cur: HTMLElement | null = null;
    for (const c of cards) if (c.d.appliedTick <= state.tick) cur = c.el;
    if (cur !== lastCurrent) {
      lastCurrent?.classList.remove('current');
      cur?.classList.add('current');
      lastCurrent = cur;
      if (cur && (force || performance.now() - userScrolledAt > 4000)) feed.scrollTop = cur.offsetTop - feed.clientHeight / 2;
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

  playBtn.addEventListener('click', () => {
    if (state.round.phase === 'over') seek(0);
    setPlaying(!playing);
  });
  speedSel.addEventListener('change', () => {
    speed = Number(speedSel.value);
    stage.tickMs = TICK_MS / speed;
  });
  bubblesBox.addEventListener('change', () => (stage.renderer.showBubbles = bubblesBox.checked));

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest('input,select,textarea')) return;
    if (e.key === ' ') {
      e.preventDefault();
      playBtn.click();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setPlaying(false);
      seek(Math.max(0, Math.min(r.ticks, state.tick + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 60 : 1))));
    } else if (e.key === ']') nextDecision(1);
    else if (e.key === '[') nextDecision(-1);
    else if (e.key === 't' || e.key === 'T') {
      bubblesBox.checked = !bubblesBox.checked;
      stage.renderer.showBubbles = bubblesBox.checked;
    }
  };
  window.addEventListener('keydown', onKey);

  // Export.
  const exportBtn = h('button.btn', { type: 'button', title: 'Save a video clip' }, 'Export clip');
  const exportPanel = h('div.export', { hidden: true });
  exportBtn.addEventListener('click', () => {
    exportPanel.hidden = !exportPanel.hidden;
    if (!exportPanel.hidden) {
      setPlaying(false);
      fillExport();
    }
  });
  function fillExport(): void {
    if (!exportSupported()) {
      exportPanel.replaceChildren(h('p.note', null, 'This browser cannot encode video. Use a recent Chrome, Edge or Safari.'));
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
    const go = h('button.btn.primary', { type: 'button' }, 'Render');
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
          h('a.btn.primary', { href: url, download: name }, 'Download'),
          h('span.note', null, ` ${name}, ${(blob.size / 1e6).toFixed(1)} MB, rendered in ${secs} s`),
          h('video.preview', { src: url, controls: true, playsinline: true }),
        );
      } catch (e) {
        status.replaceChildren(h('span.note', null, (e as Error).name === 'AbortError' ? 'Cancelled.' : `Export failed: ${(e as Error).message}`));
      } finally {
        controller = null;
        go.textContent = 'Render';
      }
    });
    exportPanel.replaceChildren(
      h('div.export-row', null, h('label', null, 'Range', range), h('label', null, 'Size', size), h('label', null, 'Frame rate', fps)),
      h('div.export-row', null, h('label.check', null, sfx, ' Sound effects'), h('label.check', null, mus, ' Music'), h('label.check', null, bub, ' Thought bubbles')),
      h('div.export-row', null, go, h('span.note', null, 'Rendered frame by frame in your browser, usually faster than real time.')),
      status,
    );
  }

  // Tabs.
  const panelBody = h('div.panel-body');
  const tabDecisions = h('button.tab.active', { type: 'button' }, 'Decisions');
  const tabStats = h('button.tab', { type: 'button' }, 'Stats');
  const showDecisions = () => {
    tabDecisions.classList.add('active');
    tabStats.classList.remove('active');
    panelBody.replaceChildren(h('label.check', null, hideNeutral, ' Only decisions where something happened'), feed);
    lastCurrent = null;
    sync(true);
  };
  let statsEl: HTMLElement | null = null;
  const showStats = () => {
    tabStats.classList.add('active');
    tabDecisions.classList.remove('active');
    statsEl ??= statsView(r, player.events);
    panelBody.replaceChildren(statsEl);
  };
  tabDecisions.addEventListener('click', showDecisions);
  tabStats.addEventListener('click', showStats);

  const [a, b] = r.fighters;
  const winner = r.result.winner === null ? 'Draw' : `${r.fighters[r.result.winner].label} wins`;
  host.replaceChildren(
    h(
      'div.viewer',
      null,
      h(
        'div.viewer-main',
        null,
        h(
          'div.viewer-title',
          null,
          h(
            'h1',
            null,
            h('span', { style: { color: SIDES[0].deep } }, a.label),
            ' vs ',
            h('span', { style: { color: SIDES[1].deep } }, b.label),
          ),
          opts.note ? h('p.note', null, opts.note) : null,
          h('div.sub', null, `${winner}. ${r.mode === 'paused' ? 'Paused' : 'Real-time'} mode, ${r.track ?? 'assisted'} track, ${r.deadlineMs} ms deadline, ${r.decisions.length} decisions, ${money(r.costUsd)}.`, player.diverged !== null ? h('strong.warn', null, ` Replay diverged at ${clockTime(player.diverged)}.`) : ''),
        ),
        stageHost,
        h(
          'div.controls',
          null,
          playBtn,
          h('button.btn.icon', { type: 'button', title: 'Previous decision ([)', onclick: () => nextDecision(-1) }, '⏮'),
          h('button.btn.icon', { type: 'button', title: 'Next decision (])', onclick: () => nextDecision(1) }, '⏭'),
          timeEl,
          h('span.spacer'),
          h('label.check', { for: 'bubbles' }, bubblesBox, ' Thoughts'),
          speedSel,
          exportBtn,
        ),
        exportPanel,
        timeline.el,
        h(
          'div.legend.small',
          null,
          ...['hit', 'traded', 'punished', 'blocked', 'whiffed', 'defended'].map((o) => h('span', null, h('span.sq', { style: { background: OUTCOME_COLORS[o] } }), o === 'punished' ? 'got hit' : o)),
          h('span', null, h('span.sq.ko'), 'KO'),
          h('span.share', null, opts.link ? h('a', { href: opts.link }, 'Link to this match') : null, ' ', h('button.btn.small', { type: 'button', onclick: () => void downloadReplay(r) }, 'Download')),
        ),
      ),
      h('aside.panel', null, h('div.tabs', null, tabDecisions, tabStats), panelBody),
    ),
  );
  showDecisions();
  const at = Number(new URLSearchParams(location.hash.split('?')[1] ?? '').get('t'));
  if (at > 0) {
    seek(Math.min(r.ticks, at));
    setPlaying(false);
  } else {
    setPlaying(true);
  }
  audio.scene(true);
  return () => {
    audio.scene(false);
    window.removeEventListener('keydown', onKey);
    stage.destroy();
  };
}
