import type { GameEvent } from '../../shared/engine/engine.ts';
import { MOVE_LABELS, type MoveId } from '../../shared/engine/moves.ts';
import type { Replay } from '../../shared/replay.ts';
import { matchStats, type FighterStats } from '../../shared/stats.ts';
import { clockTime, h, money, pct } from '../dom.ts';
import { SIDES } from '../theme.ts';

const SVG = 'http://www.w3.org/2000/svg';
function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...children: (Node | string)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.append(c);
  return el;
}

export function statsView(r: Replay, events: GameEvent[]): HTMLElement {
  const st = matchStats(r);
  const colors = [SIDES[0].deep, SIDES[1].deep];
  return h(
    'div.stats',
    null,
    statTable(st, colors),
    h('h3', null, 'Damage dealt over the match'),
    damageChart(r, events, colors),
    h('h3', null, 'Move mix'),
    h('div.mix-grid', null, ...st.map((f, i) => moveMix(f, colors[i]))),
    h('h3', null, 'Calibration'),
    h('p.fnote', null, 'Descriptive only: confidence in the chosen move against whether that exchange was won (the model was asked how likely each move is to be the best choice, not whether it wins, so this is not a forecast score). Exchanges where nothing happened are left out.'),
    calibrationChart(st, colors),
  );
}

function statTable(st: [FighterStats, FighterStats], colors: string[]): HTMLElement {
  const rows: [string, (f: FighterStats) => string][] = [
    ['Result', (f) => `${f.result} (${f.roundsWon} ${f.roundsWon === 1 ? 'round' : 'rounds'})`],
    ['Damage dealt / taken', (f) => `${f.dealt} / ${f.taken}`],
    ['Decisions', (f) => String(f.decisions)],
    ['Latency p50 / p95', (f) => `${Math.round(f.latency.p50)} / ${Math.round(f.latency.p95)} ms`],
    ['Answers after free to act', (f) => `${f.late} (${(f.waitTicks / 60).toFixed(1)} s waiting)`],
    ['Questions cancelled', (f) => String(f.cancellations)],
    ['Fallbacks', (f) => `${Object.values(f.fallbacks).reduce((a, b) => a + b, 0)} (${pct(f.fallbackRate)})`],
    ['Hit / blocked / whiffed / got hit', (f) => `${f.outcomes.hit ?? 0} / ${f.outcomes.blocked ?? 0} / ${f.outcomes.whiffed ?? 0} / ${f.outcomes.punished ?? 0}`],
    ['Cost', (f) => `${money(f.costUsd)} (${f.inputTokens.toLocaleString()} input tokens)`],
  ];
  return h(
    'div.table-wrap',
    null,
    h(
      'table.stat-table',
      null,
      h('thead', null, h('tr', null, h('th', null, ''), ...st.map((f, i) => h('th', null, h('span.dot', { style: { background: colors[i] } }), f.label)))),
      h('tbody', null, ...rows.map(([label, fn]) => h('tr', null, h('th', null, label), ...st.map((f) => h('td', null, fn(f)))))),
    ),
  );
}

function damageChart(r: Replay, events: GameEvent[], colors: string[]): HTMLElement {
  const W = 360;
  const H = 200;
  const pad = { l: 32, r: 64, t: 12, b: 24 };
  const series: { tick: number; v: number }[][] = [[{ tick: 0, v: 0 }], [{ tick: 0, v: 0 }]];
  for (const e of events) {
    if (e.kind === 'hit' || e.kind === 'armor') {
      const ser = series[e.f];
      ser.push({ tick: e.tick, v: ser[ser.length - 1].v });
      ser.push({ tick: e.tick, v: ser[ser.length - 1].v + e.dmg });
    }
  }
  for (const ser of series) ser.push({ tick: r.ticks, v: ser[ser.length - 1].v });
  const maxV = Math.max(10, ...series.map((x) => x[x.length - 1].v));
  const X = (t: number) => pad.l + (t / Math.max(1, r.ticks)) * (W - pad.l - pad.r);
  const Y = (v: number) => H - pad.b - (v / maxV) * (H - pad.t - pad.b);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Cumulative damage dealt by each fighter over the match' });
  // Recessive grid.
  for (let k = 0; k <= 4; k++) {
    const v = (maxV / 4) * k;
    svg.append(s('line', { x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v), class: 'grid' }));
    svg.append(s('text', { x: pad.l - 6, y: Y(v) + 4, class: 'axis', 'text-anchor': 'end' }, String(Math.round(v))));
  }
  // Round boundaries.
  for (const rd of r.result.rounds) {
    svg.append(s('line', { x1: X(rd.tick), x2: X(rd.tick), y1: pad.t, y2: H - pad.b, class: 'grid dashed' }));
    svg.append(s('text', { x: X(rd.tick) - 4, y: H - pad.b + 16, class: 'axis', 'text-anchor': 'end' }, `R${rd.n}`));
  }
  series.forEach((ser, i) => {
    svg.append(s('path', { d: ser.map((p, k) => `${k ? 'L' : 'M'}${X(p.tick).toFixed(1)},${Y(p.v).toFixed(1)}`).join(''), fill: 'none', stroke: colors[i], 'stroke-width': 2 }));
    const last = ser[ser.length - 1];
    svg.append(s('text', { x: X(last.tick) + 6, y: Y(last.v) + 4, class: 'label' }, `${r.fighters[i].label.split(' ')[0]} ${last.v}`));
  });
  // Crosshair + tooltip.
  const cross = s('line', { y1: pad.t, y2: H - pad.b, class: 'cross', visibility: 'hidden' });
  svg.append(cross);
  const tip = h('div.tip', { hidden: true });
  const wrap = h('div.chart-wrap', null, svg, tip);
  const valueAt = (ser: { tick: number; v: number }[], t: number) => {
    let v = 0;
    for (const p of ser) if (p.tick <= t) v = p.v;
    return v;
  };
  svg.addEventListener('pointermove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * W;
    if (x < pad.l || x > W - pad.r) return;
    const t = ((x - pad.l) / (W - pad.l - pad.r)) * r.ticks;
    cross.setAttribute('x1', String(x));
    cross.setAttribute('x2', String(x));
    cross.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.replaceChildren(
      h('div.tip-t', null, clockTime(t)),
      ...series.map((ser, i) => h('div', null, h('span.dot', { style: { background: colors[i] } }), `${r.fighters[i].label}: ${valueAt(ser, t)}`)),
    );
    const px = ev.clientX - rect.left;
    tip.style.left = `${Math.min(rect.width - 150, px + 12)}px`;
    tip.style.top = '8px';
  });
  svg.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  });
  return wrap;
}

function moveMix(f: FighterStats, color: string): HTMLElement {
  const entries = (Object.entries(f.moves) as [MoveId, NonNullable<FighterStats['moves'][MoveId]>][]).sort((a, b) => b[1].uses - a[1].uses);
  const max = Math.max(1, ...entries.map(([, m]) => m.uses));
  return h(
    'div.mix',
    null,
    h('div.mix-title', null, h('span.dot', { style: { background: color } }), f.label),
    ...entries.map(([id, m]) => {
      const tip = `${MOVE_LABELS[id]}: ${m.uses} uses, ${m.outcomes.hit ?? 0} hit, ${m.outcomes.blocked ?? 0} blocked, ${m.outcomes.whiffed ?? 0} whiffed, ${m.outcomes.punished ?? 0} got hit, ${m.dealt} damage`;
      return h(
        'div.mix-row',
        { title: tip },
        h('span.mix-name', null, MOVE_LABELS[id]),
        h('span.mix-bar', null, h('span', { style: { width: `${(m.uses / max) * 100}%`, background: color } })),
        h('span.mix-n', null, String(m.uses)),
      );
    }),
  );
}

function calibrationChart(st: [FighterStats, FighterStats], colors: string[]): HTMLElement {
  const W = 300;
  const H = 260;
  const pad = { l: 40, r: 12, t: 12, b: 34 };
  const X = (v: number) => pad.l + v * (W - pad.l - pad.r);
  const Y = (v: number) => H - pad.b - v * (H - pad.t - pad.b);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart calib', role: 'img', 'aria-label': 'Reliability diagram per fighter' });
  for (let k = 0; k <= 4; k++) {
    svg.append(s('line', { x1: X(0), x2: X(1), y1: Y(k / 4), y2: Y(k / 4), class: 'grid' }));
    svg.append(s('text', { x: X(0) - 6, y: Y(k / 4) + 4, class: 'axis', 'text-anchor': 'end' }, `${k * 25}%`));
    svg.append(s('text', { x: X(k / 4), y: H - pad.b + 14, class: 'axis', 'text-anchor': 'middle' }, `${k * 25}%`));
  }
  svg.append(s('text', { x: X(0.5), y: H - 4, class: 'axis', 'text-anchor': 'middle' }, 'confidence in chosen move'));
  svg.append(s('line', { x1: X(0), y1: Y(0), x2: X(1), y2: Y(1), class: 'diag' }));
  const maxN = Math.max(1, ...st.flatMap((f) => f.calibration.bins.map((b) => b.n)));
  st.forEach((f, i) => {
    const pts = f.calibration.bins.filter((b) => b.n > 0);
    if (pts.length > 1) svg.append(s('path', { d: pts.map((b, k) => `${k ? 'L' : 'M'}${X(b.meanConfidence)},${Y(b.winRate)}`).join(''), fill: 'none', stroke: colors[i], 'stroke-width': 2, opacity: 0.6 }));
    for (const b of pts) {
      const c = s('circle', { cx: X(b.meanConfidence), cy: Y(b.winRate), r: 4 + 6 * Math.sqrt(b.n / maxN), fill: colors[i], stroke: '#ffffff', 'stroke-width': 2 });
      c.append(s('title', {}, `${f.label}: ${b.n} decisions at ${Math.round(b.meanConfidence * 100)}% confidence won ${Math.round(b.winRate * 100)}%`));
      svg.append(c);
    }
  });
  return h(
    'div.calib-wrap',
    null,
    svg,
    h(
      'div.legend',
      null,
      ...st.map((f, i) =>
        h('div', null, h('span.dot', { style: { background: colors[i] } }), `${f.label}: ${f.calibration.n} decisions${f.calibration.uncalibrated ? `, ${f.calibration.uncalibrated} without probabilities` : ''}`),
      ),
    ),
  );
}
