import { clone, type GameEvent, type GameState } from '../shared/engine/engine.ts';
import { TICK_MS } from '../shared/match.ts';
import type { FighterMeta } from '../shared/replay.ts';
import { audio, cuesFor } from './audio.ts';
import { FightRenderer } from './render/renderer.ts';

/**
 * A canvas with a fight renderer and an animation loop. Feed it sim ticks with `tick()`; it interpolates
 * between the last two and draws at the display's refresh rate.
 */
export class Stage {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: FightRenderer;
  private prev: GameState | null = null;
  private curr: GameState | null = null;
  private tickAt = 0;
  private raf = 0;
  private last = 0;
  private ro: ResizeObserver;
  private dprQuery: MediaQueryList | null = null;
  /** How long one tick lasts on screen (ms): TICK_MS / playback speed. */
  tickMs = TICK_MS;
  paused = false;
  onFrame: ((dt: number) => void) | null = null;

  constructor(host: HTMLElement, meta: [FighterMeta, FighterMeta]) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stage';
    host.append(this.canvas);
    this.renderer = new FightRenderer(this.canvas, meta);
    this.ro = new ResizeObserver(() => this.renderer.resize());
    this.ro.observe(this.canvas);
    this.watchDpr();
    this.raf = requestAnimationFrame(this.loop);
  }

  /** A new sim state (copied). */
  tick(state: GameState, events: GameEvent[] = []): void {
    this.prev = this.curr ?? clone(state);
    this.curr = clone(state);
    this.tickAt = performance.now();
    this.renderer.setState(this.prev, this.curr);
    if (events.length) this.renderer.onEvents(events);
    // No sound when fast-forwarding: it would be a wall of noise.
    if (TICK_MS / this.tickMs <= 2) audio.play(cuesFor(events, this.prev, this.curr));
  }

  /** Jump to a state without interpolation or carried-over effects. */
  jump(state: GameState): void {
    this.curr = clone(state);
    this.prev = clone(state);
    this.tickAt = performance.now();
    this.renderer.setState(this.prev, this.curr);
    this.renderer.reset();
  }

  /**
   * The canvas is drawn at its displayed size times the device pixel ratio (see FightRenderer.resize). The ratio changes
   * with the browser's zoom or a move to another screen without the layout changing, so watch it too.
   */
  private watchDpr = () => {
    this.dprQuery?.removeEventListener('change', this.onDpr);
    this.dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.dprQuery.addEventListener('change', this.onDpr);
  };
  private onDpr = () => {
    this.renderer.resize();
    this.watchDpr();
  };

  private loop = (now: number) => {
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 1 / 60;
    this.last = now;
    this.onFrame?.(dt);
    const alpha = this.paused ? 1 : Math.max(0, Math.min(1, (now - this.tickAt) / this.tickMs));
    this.renderer.frame(alpha, this.paused ? 0 : dt);
    this.raf = requestAnimationFrame(this.loop);
  };

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.dprQuery?.removeEventListener('change', this.onDpr);
    this.canvas.remove();
  }
}
