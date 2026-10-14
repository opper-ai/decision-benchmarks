import type { GameEvent } from '../../shared/engine/engine.ts';
import type { Decision, Replay } from '../../shared/replay.ts';

import { OUTCOME_COLORS as OUTCOME_COLOR } from '../theme.ts';

/**
 * The scrubber: a decision marker per fighter row coloured by outcome, round and KO marks, and a playhead.
 * Drawn on a canvas because a match has around a thousand decisions.
 */
export class Timeline {
  readonly el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dragging = false;
  head = 0;

  private r: Replay;
  private events: GameEvent[];
  private onSeek: (tick: number) => void;

  constructor(r: Replay, events: GameEvent[], onSeek: (tick: number) => void) {
    this.r = r;
    this.events = events;
    this.onSeek = onSeek;
    this.el = document.createElement('canvas');
    this.el.className = 'timeline';
    this.el.setAttribute('aria-label', 'Match timeline: drag to seek');
    this.ctx = this.el.getContext('2d')!;
    const seek = (ev: PointerEvent) => {
      const rect = this.el.getBoundingClientRect();
      const t = Math.round(((ev.clientX - rect.left) / rect.width) * r.ticks);
      this.onSeek(Math.max(0, Math.min(r.ticks, t)));
    };
    this.el.addEventListener('pointerdown', (ev) => {
      this.dragging = true;
      this.el.setPointerCapture(ev.pointerId);
      seek(ev);
    });
    this.el.addEventListener('pointermove', (ev) => this.dragging && seek(ev));
    this.el.addEventListener('pointerup', () => (this.dragging = false));
    new ResizeObserver(() => this.draw()).observe(this.el);
  }

  draw(): void {
    const rect = this.el.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(100, rect.width);
    const H = Math.max(40, rect.height);
    if (this.el.width !== Math.round(W * dpr)) {
      this.el.width = Math.round(W * dpr);
      this.el.height = Math.round(H * dpr);
    }
    const c = this.ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Activity is in the page's theme (only the stage is paper in both): the card behind is the canvas's CSS background,
    // and the ink (the rounds' bands, the quiet moves, the playhead) its CSS color.
    c.clearRect(0, 0, W, H);
    const ink = getComputedStyle(this.el).color;
    const X = (t: number) => (t / Math.max(1, this.r.ticks)) * W;
    const rowH = (H - 10) / 2;
    const rows = [4, 6 + rowH];
    // Rounds.
    c.fillStyle = ink;
    c.globalAlpha = 0.05;
    this.r.result.rounds.forEach((rd, k) => k % 2 === 0 && c.fillRect(X(k ? this.r.result.rounds[k - 1].tick : 0), 0, X(rd.tick) - X(k ? this.r.result.rounds[k - 1].tick : 0), H));
    c.globalAlpha = 1;
    const draw = (d: Decision) => {
      const x = X(d.appliedTick);
      const y = rows[d.fighter];
      const important = d.outcome && d.outcome !== 'neutral';
      c.fillStyle = important ? OUTCOME_COLOR[d.outcome!]! : ink;
      c.globalAlpha = important ? 1 : 0.14;
      const w = important ? 3 : 1.5;
      c.fillRect(x - w / 2, y + (important ? 0 : rowH * 0.3), w, important ? rowH : rowH * 0.4);
      c.globalAlpha = 1;
      if (d.fallback) {
        c.strokeStyle = '#C2255C';
        c.lineWidth = 1;
        c.strokeRect(x - 2, y, 4, rowH);
      }
    };
    // Neutral first so outcomes draw on top.
    for (const d of this.r.decisions) if (!d.outcome || d.outcome === 'neutral') draw(d);
    for (const d of this.r.decisions) if (d.outcome && d.outcome !== 'neutral') draw(d);
    for (const e of this.events) {
      if (e.kind === 'ko') {
        c.fillStyle = '#E5484D';
        c.beginPath();
        const x = X(e.tick);
        c.moveTo(x, H / 2 - 5);
        c.lineTo(x + 5, H / 2);
        c.lineTo(x, H / 2 + 5);
        c.lineTo(x - 5, H / 2);
        c.fill();
      }
    }
    // Playhead.
    c.fillStyle = ink;
    c.fillRect(X(this.head) - 1, 0, 2, H);
  }
}
