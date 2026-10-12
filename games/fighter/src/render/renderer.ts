import { MAX_HP, MAX_METER, PASSIVE_BLEED_TICKS, PASSIVE_WARN_TICKS, TICK_HZ, type GameEvent, type GameState, type Side } from '../../shared/engine/engine.ts';
import { MOVE_LABELS, type MoveId } from '../../shared/engine/moves.ts';
import type { FighterMeta } from '../../shared/replay.ts';
import { lerpPose, poseFor } from './pose.ts';
import { BONES, PoseSpring, Ragdoll, solve, type Joints, type Vec } from './rig.ts';
import { CYAN, DISPLAY_FONT, NAVY, PEACH, SIDES, STAGE } from '../theme.ts';

export interface Bubble {
  thinking: boolean;
  /** performance.now() when the question was asked or answered. */
  since: number;
  top: { move: MoveId; p: number }[];
  fallback?: string | null;
  latencyMs?: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  life: number;
  max: number;
  color: string;
  kind: 'ink' | 'spark' | 'dust';
}

interface Banner {
  text: string;
  sub?: string;
  t0: number;
  dur: number;
  color: string;
}

const INK = NAVY;
const FONT = DISPLAY_FONT;
const KO_RED = '#E5484D';

const TIPS: Partial<Record<MoveId, (keyof Joints)[]>> = {
  jab: ['handF'],
  jab_straight: ['handF'],
  straight: ['handB'],
  low_kick: ['toeF'],
  low_kick_sweep: ['toeF'],
  high_kick: ['toeB'],
  uppercut: ['handB'],
  sweep: ['toeF'],
  throw: ['handF'],
  jump_kick: ['toeF'],
  special: ['handF', 'handB'],
};

/** Small deterministic hash for render-only variety. */
function hash(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

export class FightRenderer {
  showBubbles = true;
  bubbles: [Bubble | null, Bubble | null] = [null, null];
  private ctx: CanvasRenderingContext2D;
  private W = 0;
  private H = 0;
  private dpr = 1;
  private prev: GameState | null = null;
  private curr: GameState | null = null;
  private springs = [new PoseSpring(), new PoseSpring()];
  private ragdolls: [Ragdoll | null, Ragdoll | null] = [null, null];
  private particles: Particle[] = [];
  private rings: { x: number; y: number; t0: number; color: string; size: number }[] = [];
  private cracks: { x: number; seed: number; t0: number }[] = [];
  private banners: Banner[] = [];
  private floats: { text: string; side: Side; t0: number }[] = [];
  private trails: [Vec[][], Vec[][]] = [[], []];
  private flash: [number, number] = [-1, -1];
  private shake = { amp: 0, t0: 0 };
  private cam = { x: 5, ppb: 100, init: false };
  private ghostHp: [number, number] = [MAX_HP, MAX_HP];
  private paper: HTMLCanvasElement | null = null;
  private lastRound = 0;
  private time = 0;

  /** Clock for bubble ages (ms). The exporter swaps in a virtual one. */
  now: () => number = () => performance.now();

  constructor(
    private canvas: HTMLCanvasElement,
    private meta: [FighterMeta, FighterMeta],
    /** Render at this exact size (CSS px, dpr 1) instead of the canvas's layout size. */
    private fixed?: { width: number; height: number },
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  resize(): void {
    const rect = this.fixed ?? this.canvas.getBoundingClientRect();
    this.dpr = this.fixed ? 1 : Math.min(2, window.devicePixelRatio || 1);
    this.W = Math.max(320, rect.width);
    this.H = Math.max(180, rect.height);
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    this.paper = null;
    this.cam.init = false;
  }

  /** New simulation tick. `prev` is the state one tick earlier (for interpolation). */
  setState(prev: GameState, curr: GameState): void {
    this.prev = prev;
    this.curr = curr;
    if (curr.round.n !== this.lastRound) {
      this.lastRound = curr.round.n;
      this.cracks = [];
      this.ragdolls = [null, null];
      this.ghostHp = [curr.fighters[0].hp, curr.fighters[1].hp];
      if (curr.round.phase === 'intro') this.banner(`Round ${curr.round.n}`, 1.3, INK);
    }
    for (const i of [0, 1] as const) if (curr.fighters[i].phase !== 'ko') this.ragdolls[i] = null;
  }

  /** Forget transient effects (after a seek). Springs snap on the next frame. */
  reset(): void {
    this.particles = [];
    this.rings = [];
    this.banners = [];
    this.trails = [[], []];
    this.ragdolls = [null, null];
    this.springs = [new PoseSpring(), new PoseSpring()];
    this.cam.init = false;
    this.lastRound = this.curr?.round.n ?? 0;
    if (this.curr) this.ghostHp = [this.curr.fighters[0].hp, this.curr.fighters[1].hp];
  }

  onEvents(events: GameEvent[]): void {
    const now = this.time;
    for (const e of events) {
      if (e.kind === 'hit' || e.kind === 'armor') {
        const x = e.x / 1000;
        const y = e.y / 1000;
        const def = (1 - e.f) as Side;
        const away = e.f === 0 ? 1 : -1;
        const n = 8 + e.dmg;
        for (let k = 0; k < n; k++) {
          const a = (hash(e.tick * 31 + k) - 0.5) * 2.4 + (away > 0 ? 0 : Math.PI);
          const sp = 1.5 + hash(e.tick * 17 + k) * (2 + e.dmg * 0.25);
          this.particles.push({
            x,
            y,
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp * 0.8 + 1.2,
            r: 0.018 + hash(k * 7 + e.tick) * 0.04 + e.dmg * 0.002,
            life: 0,
            max: 0.5 + hash(k + e.tick) * 0.4,
            color: k % 3 === 0 ? SIDES[e.f].deep : k % 3 === 1 ? INK : SIDES[e.f].fill,
            kind: 'ink',
          });
        }
        this.rings.push({ x, y, t0: now, color: e.kind === 'armor' ? '#3C3CAF' : INK, size: 0.25 + e.dmg * 0.025 });
        this.flash[def] = now;
        this.shake = { amp: 4 + e.dmg * 0.9, t0: now };
        if (e.kind === 'hit' && e.knockdown) {
          this.cracks.push({ x: this.curr ? this.curr.fighters[def].x / 1000 + away * 0.4 : x, seed: e.tick, t0: now });
          if (this.cracks.length > 4) this.cracks.shift();
          this.dust(x + away * 0.5, 10);
        }
      } else if (e.kind === 'block') {
        const x = e.x / 1000;
        const y = e.y / 1000;
        for (let k = 0; k < 7; k++) {
          const a = (hash(e.tick * 13 + k) - 0.5) * 2 + (e.f === 0 ? Math.PI : 0);
          this.particles.push({ x, y, vx: Math.cos(a) * 3, vy: Math.sin(a) * 3, r: 0.02, life: 0, max: 0.18, color: '#ffffff', kind: 'spark' });
        }
        this.rings.push({ x, y, t0: now, color: '#7A8794', size: 0.18 });
        this.shake = { amp: 2, t0: now };
      } else if (e.kind === 'ko') {
        const f = this.curr?.fighters[e.f];
        if (f) {
          const j = this.lastJoints[e.f] ?? solve(this.springs[e.f].update(poseFor(f, 0, false), 0), f.x / 1000, f.y / 1000, e.f === 0 ? 1 : -1);
          this.ragdolls[e.f] = new Ragdoll(j, e.f === 0 ? -1 : 1, 3.2, e.f === 0 ? 1 : -1);
        }
        this.banner('K.O.', 2.2, KO_RED);
        this.shake = { amp: 14, t0: now };
      } else if (e.kind === 'penalty') {
        this.floats.push({ text: `-${e.dmg}`, side: e.f, t0: now });
      } else if (e.kind === 'round_start') {
        this.banner('Fight!', 0.9, 'gradient');
      } else if (e.kind === 'round_end' && e.result.reason === 'time') {
        this.banner('Time', 1.4, INK);
      } else if (e.kind === 'match_end') {
        const text = e.winner === null ? 'Draw' : `${this.meta[e.winner].label} wins`;
        this.banner(text, 6, e.winner === null ? INK : SIDES[e.winner].fill);
      } else if (e.kind === 'start' && (e.move === 'jump' || e.move === 'jump_kick' || e.move === 'backdash')) {
        const f = this.curr?.fighters[e.f];
        if (f) this.dust(f.x / 1000, 4);
      }
    }
  }

  private lastJoints: [Joints | null, Joints | null] = [null, null];

  private banner(text: string, dur: number, color: string): void {
    this.banners = this.banners.filter((b) => this.time - b.t0 < 0.15 && b.text !== text);
    this.banners.push({ text, t0: this.time, dur, color });
  }

  private dust(x: number, n: number): void {
    for (let k = 0; k < n; k++) {
      const s = hash(Math.floor(this.time * 1000) + k);
      this.particles.push({ x, y: 0.03, vx: (s - 0.5) * 2.2, vy: 0.3 + s * 0.6, r: 0.06 + s * 0.06, life: 0, max: 0.5 + s * 0.3, color: '#C5CFD8', kind: 'dust' });
    }
  }

  /** Draw a frame. `alpha` interpolates between the last two sim states; `dt` in seconds. */
  frame(alpha: number, dt: number): void {
    this.time += dt;
    const s = this.curr;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawPaper();
    if (!s || !this.prev) return;
    const prev = this.prev;
    const lerp = (a: number, b: number) => a + (b - a) * alpha;

    // Fighter positions, interpolated.
    const pos = ([0, 1] as const).map((i) => ({
      x: lerp(prev.fighters[i].x, s.fighters[i].x) / 1000,
      y: lerp(prev.fighters[i].y, s.fighters[i].y) / 1000,
    }));

    // Camera: keep both fighters framed, never show beyond the stage.
    const groundY = this.H * 0.83;
    const gapBL = Math.abs(pos[1].x - pos[0].x);
    const viewW = Math.max(5.2, Math.min(11.8, gapBL + 4));
    const ppb = Math.min(this.W / viewW, (groundY - 70) / 2.35);
    const visW = this.W / ppb;
    let cx = (pos[0].x + pos[1].x) / 2;
    cx = Math.max(Math.min(cx, 10.9 - visW / 2), -0.9 + visW / 2);
    if (visW > 11.8) cx = 5;
    if (!this.cam.init || dt === 0) {
      this.cam = { x: cx, ppb, init: true };
    } else {
      const k = 1 - Math.exp(-dt * 5);
      this.cam.x += (cx - this.cam.x) * k;
      this.cam.ppb += (ppb - this.cam.ppb) * k;
    }
    const sh = this.shake.amp * Math.max(0, 1 - (this.time - this.shake.t0) / 0.25);
    const ox = sh ? (hash(Math.floor(this.time * 60)) - 0.5) * sh * 2 : 0;
    const oy = sh ? (hash(Math.floor(this.time * 60) + 7) - 0.5) * sh * 2 : 0;
    const P = this.cam.ppb;
    const toScreen = (v: Vec): Vec => ({ x: this.W / 2 + (v.x - this.cam.x) * P + ox, y: groundY - v.y * P + oy });

    this.drawWorld(toScreen, groundY + oy, P);

    // Fighters.
    const winner = s.round.phase === 'over' ? s.winner : s.round.phase === 'outro' ? (s.results[s.results.length - 1]?.winner ?? null) : null;
    const order: Side[] = s.fighters[0].phase === 'ko' || s.fighters[0].phase === 'knockdown' ? [0, 1] : [1, 0];
    for (const i of order) {
      const f = s.fighters[i];
      const pf = prev.fighters[i];
      const dir = i === 0 ? 1 : -1;
      let joints: Joints;
      const rag = this.ragdolls[i];
      if (rag) {
        rag.step(dt);
        joints = rag.joints();
      } else {
        const target = lerpPose(poseFor(pf, this.time, winner === i), poseFor(f, this.time, winner === i), alpha);
        // Snappier while striking so short active frames still read.
        const fast = f.phase === 'active' || f.phase === 'hitstun' || f.phase === 'startup';
        const pose = this.springs[i].update(target, Math.min(dt, 1 / 30), fast ? 52 : 30);
        let x = pos[i].x;
        if (s.hitstop > 0 && this.time - this.flash[i] < 0.2) x += (hash(Math.floor(this.time * 90) + i) - 0.5) * 0.05;
        joints = solve(pose, x, pos[i].y, dir);
      }
      this.lastJoints[i] = joints;
      this.trackTrail(i, f, joints);
      this.drawShadow(toScreen, pos[i].x, pos[i].y, P);
      this.drawTrail(i, toScreen, P);
      const flashing = this.time - this.flash[i] < 0.07;
      this.drawFighter(joints, toScreen, P, flashing ? '#ffffff' : SIDES[i].fill);
    }

    this.drawFx(toScreen, P, dt);
    this.drawFloats(toScreen, P);
    if (this.showBubbles) {
      const heads = this.lastJoints.map((j) => (j ? toScreen(j.head).x : this.W / 2));
      const mid = (heads[0] + heads[1]) / 2;
      for (const i of [0, 1] as const) this.drawBubble(i, toScreen, P, mid);
    }
    this.drawHud(s, dt);
    this.drawBanners();
  }

  private drawPaper(): void {
    const ctx = this.ctx;
    if (!this.paper) {
      const c = document.createElement('canvas');
      c.width = Math.round(this.W * this.dpr);
      c.height = Math.round(this.H * this.dpr);
      const g = c.getContext('2d')!;
      g.fillStyle = STAGE;
      g.fillRect(0, 0, c.width, c.height);
      // The brand gradient as two soft glows: cyan up left, peach down right.
      const glow = (x: number, y: number, r: number, color: string) => {
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, color);
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr;
        g.fillRect(0, 0, c.width, c.height);
      };
      glow(c.width * 0.08, c.height * 0.05, c.width * 0.55, 'rgba(140,236,242,0.30)');
      glow(c.width * 0.95, c.height * 0.9, c.width * 0.55, 'rgba(249,181,140,0.28)');
      // Fine grain so it reads as paper, not a flat fill.
      for (let k = 0; k < (c.width * c.height) / 140; k++) {
        const x = hash(k * 3) * c.width;
        const y = hash(k * 3 + 1) * c.height;
        g.fillStyle = hash(k * 3 + 2) > 0.5 ? 'rgba(27,46,64,0.035)' : 'rgba(255,255,255,0.5)';
        g.fillRect(x, y, 1.2 * this.dpr, 1.2 * this.dpr);
      }
      this.paper = c;
    }
    ctx.drawImage(this.paper, 0, 0, this.W, this.H);
  }

  private drawWorld(toScreen: (v: Vec) => Vec, groundY: number, P: number): void {
    const ctx = this.ctx;
    // Dot grid, fixed to the world.
    ctx.fillStyle = 'rgba(27,46,64,0.13)';
    const step = 0.5;
    const left = this.cam.x - this.W / 2 / P - 1;
    const right = this.cam.x + this.W / 2 / P + 1;
    for (let gx = Math.floor(left / step) * step; gx < right; gx += step) {
      for (let gy = step; gy < (groundY / P) + 1; gy += step) {
        const p = toScreen({ x: gx, y: gy });
        if (p.y < 0 || p.y > groundY - 6) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Ground band with hatching.
    ctx.fillStyle = '#EDF1F5';
    ctx.fillRect(0, groundY, this.W, this.H - groundY);
    ctx.strokeStyle = 'rgba(27,46,64,0.28)';
    ctx.lineWidth = 1.4;
    const hatch = 0.22;
    for (let gx = Math.floor(left / hatch) * hatch; gx < right; gx += hatch) {
      const p = toScreen({ x: gx, y: 0 });
      ctx.beginPath();
      ctx.moveTo(p.x, groundY + 6);
      ctx.lineTo(p.x - 9, groundY + 19);
      ctx.stroke();
    }
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-10, groundY);
    ctx.lineTo(this.W + 10, groundY);
    ctx.stroke();
    // Stage edges.
    for (const wx of [0.5 - 0.35, 9.5 + 0.35]) {
      const p = toScreen({ x: wx, y: 0 });
      ctx.strokeStyle = 'rgba(27,46,64,0.2)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 8]);
      ctx.beginPath();
      ctx.moveTo(p.x, groundY);
      ctx.lineTo(p.x, groundY - 3.2 * P);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Cracks from knockdowns.
    for (const c of this.cracks) this.drawCrack(c, toScreen, P);
  }

  private drawCrack(c: { x: number; seed: number; t0: number }, toScreen: (v: Vec) => Vec, P: number): void {
    const ctx = this.ctx;
    const grow = Math.min(1, (this.time - c.t0) / 0.12);
    const o = toScreen({ x: c.x, y: 0 });
    ctx.strokeStyle = INK;
    ctx.lineCap = 'round';
    for (let b = 0; b < 4; b++) {
      const r = (k: number) => hash(c.seed * 97 + b * 13 + k);
      let x = o.x;
      let y = o.y;
      let a = (b / 3 - 0.5) * 2.4 + (r(0) - 0.5) * 0.5;
      ctx.lineWidth = 2.4 - b * 0.25;
      ctx.beginPath();
      ctx.moveTo(x, y);
      const segs = 2 + Math.floor(r(1) * 3);
      for (let k = 0; k < segs * grow; k++) {
        const len = (0.06 + r(k + 2) * 0.1) * P;
        a += (r(k + 9) - 0.5) * 0.9;
        x += Math.sin(a) * len;
        y += Math.abs(Math.cos(a)) * len * 0.35 + 1;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  private drawShadow(toScreen: (v: Vec) => Vec, x: number, y: number, P: number): void {
    const p = toScreen({ x, y: 0 });
    const k = Math.max(0.35, 1 - y / 1.5);
    this.ctx.fillStyle = `rgba(27,46,64,${0.12 * k})`;
    this.ctx.beginPath();
    this.ctx.ellipse(p.x, p.y + 2, 0.42 * P * k, 0.06 * P * k, 0, 0, Math.PI * 2);
    this.ctx.fill();
  }

  private drawFighter(j: Joints, toScreen: (v: Vec) => Vec, P: number, color: string): void {
    const ctx = this.ctx;
    const w = 0.082 * P;
    const outline = w + Math.max(3, 0.03 * P);
    const S = (k: keyof Joints) => toScreen(j[k]);
    const limbs: (keyof Joints)[][] = [
      ['shoulder', 'elbowB', 'handB'],
      ['hip', 'kneeB', 'ankleB', 'toeB'],
      ['hip', 'shoulder'],
      ['hip', 'kneeF', 'ankleF', 'toeF'],
      ['shoulder', 'elbowF', 'handF'],
    ];
    const strokePath = (pts: Vec[], width: number, style: string) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
      ctx.stroke();
    };
    const back = limbs.slice(0, 2);
    const front = limbs.slice(2);
    // Back limbs slightly darker for depth.
    for (const l of back) {
      strokePath(l.map(S), outline, INK);
      strokePath(l.map(S), w, shade(color, -0.18));
    }
    for (const l of front) strokePath(l.map(S), outline, INK);
    for (const l of front) strokePath(l.map(S), w, color);
    // Fists.
    for (const k of ['handF', 'handB'] as const) {
      const p = S(k);
      ctx.fillStyle = k === 'handB' ? shade(color, -0.18) : color;
      ctx.strokeStyle = INK;
      ctx.lineWidth = Math.max(2.5, 0.022 * P);
      ctx.beginPath();
      ctx.arc(p.x, p.y, w * 0.72, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // Head.
    const h = S('head');
    ctx.fillStyle = color;
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(3, 0.03 * P);
    ctx.beginPath();
    ctx.arc(h.x, h.y, BONES.headR * P, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  private trackTrail(i: Side, f: GameState['fighters'][number], j: Joints): void {
    const tips = f.atk ? TIPS[f.atk] : undefined;
    const live = tips && (f.phase === 'active' || (f.phase === 'recovery' && f.frame <= 3));
    const tr = this.trails[i];
    if (live) {
      tips.forEach((k, idx) => {
        tr[idx] ??= [];
        tr[idx].push({ ...j[k] });
        if (tr[idx].length > 7) tr[idx].shift();
      });
    } else {
      for (const t of tr) t.shift();
    }
  }

  private drawTrail(i: Side, toScreen: (v: Vec) => Vec, P: number): void {
    const ctx = this.ctx;
    for (const t of this.trails[i]) {
      if (!t || t.length < 2) continue;
      for (let k = 1; k < t.length; k++) {
        const a = toScreen(t[k - 1]);
        const b = toScreen(t[k]);
        const f = k / t.length;
        ctx.strokeStyle = `rgba(27,46,64,${0.2 * f})`;
        ctx.lineWidth = 0.12 * P * f;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
  }

  private drawFx(toScreen: (v: Vec) => Vec, P: number, dt: number): void {
    const ctx = this.ctx;
    this.particles = this.particles.filter((p) => (p.life += dt) < p.max);
    for (const p of this.particles) {
      if (p.kind === 'ink') {
        p.vy -= 9 * dt;
        p.vx *= 1 - 2 * dt;
      } else if (p.kind === 'dust') {
        p.vx *= 1 - 3 * dt;
        p.vy *= 1 - 2 * dt;
      } else {
        p.vx *= 1 - 6 * dt;
        p.vy *= 1 - 6 * dt;
      }
      p.x += p.vx * dt;
      p.y = Math.max(0.01, p.y + p.vy * dt);
      const s = toScreen(p);
      const k = 1 - p.life / p.max;
      if (p.kind === 'spark') {
        ctx.strokeStyle = INK;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x - p.vx * 0.05 * P, s.y + p.vy * 0.05 * P);
        ctx.stroke();
      } else if (p.kind === 'dust') {
        ctx.fillStyle = `rgba(140,155,170,${0.35 * k})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, p.r * P * (1.5 - k * 0.5), 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = p.color;
        ctx.globalAlpha = Math.min(1, k * 1.5);
        ctx.beginPath();
        const speed = Math.hypot(p.vx, p.vy);
        const ang = Math.atan2(-p.vy, p.vx);
        ctx.ellipse(s.x, s.y, p.r * P * (1 + speed * 0.08), p.r * P, ang, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    this.rings = this.rings.filter((r) => this.time - r.t0 < 0.22);
    for (const r of this.rings) {
      const k = (this.time - r.t0) / 0.22;
      const s = toScreen(r);
      ctx.strokeStyle = r.color;
      ctx.globalAlpha = 1 - k;
      ctx.lineWidth = 4 * (1 - k) + 1;
      // Impact burst: short radial strokes.
      const n = 10;
      for (let a = 0; a < n; a++) {
        const ang = (a / n) * Math.PI * 2 + r.t0;
        const r0 = r.size * P * (0.3 + k * 0.8);
        const r1 = r0 + r.size * P * 0.5 * (1 - k);
        ctx.beginPath();
        ctx.moveTo(s.x + Math.cos(ang) * r0, s.y + Math.sin(ang) * r0);
        ctx.lineTo(s.x + Math.cos(ang) * r1, s.y + Math.sin(ang) * r1);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  /** Passivity penalty ticks rise from the fighter's head. */
  private drawFloats(toScreen: (v: Vec) => Vec, P: number): void {
    const ctx = this.ctx;
    this.floats = this.floats.filter((f) => this.time - f.t0 < 0.9);
    for (const f of this.floats) {
      const j = this.lastJoints[f.side];
      if (!j) continue;
      const k = (this.time - f.t0) / 0.9;
      const p = toScreen({ x: j.head.x, y: j.head.y + BONES.headR + 0.15 + k * 0.4 });
      ctx.globalAlpha = 1 - k;
      ctx.font = `700 ${Math.round(P * 0.28)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#C2255C';
      ctx.fillText(f.text, p.x, p.y);
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
    }
  }

  private drawBubble(i: Side, toScreen: (v: Vec) => Vec, P: number, mid: number): void {
    const b = this.bubbles[i];
    const j = this.lastJoints[i];
    if (!b || !j || this.ragdolls[i]) return;
    const age = (this.now() - b.since) / 1000;
    if (!b.thinking && age > 1.6) return;
    const ctx = this.ctx;
    const head = toScreen(j.head);
    const w = Math.min(176, this.W * 0.42);
    const rows = b.thinking ? 1 : Math.min(3, b.top.length);
    const h = 14 + rows * 17;
    // Left fighter's bubble stays left of the midpoint, right fighter's right of it.
    let x = i === 0 ? Math.min(head.x - w + 24, mid - w - 6) : Math.max(head.x - 24, mid + 6);
    x = Math.max(6, Math.min(this.W - w - 6, x));
    const y = Math.max(78, head.y - BONES.headR * P - h - 22);
    const fade = b.thinking ? 1 : Math.min(1, (1.6 - age) / 0.4);
    ctx.globalAlpha = fade;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    roundRect(ctx, x, y, w, h, 10);
    ctx.fill();
    ctx.stroke();
    // Thought dots toward the head.
    for (let k = 0; k < 2; k++) {
      const tx = head.x + (x + w / 2 - head.x) * (0.35 + k * 0.3);
      const ty = head.y - BONES.headR * P - 6 - k * 9;
      ctx.beginPath();
      ctx.arc(tx, ty, 3 + k * 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.font = '600 12px "Wix Madefor Text", ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    if (b.thinking) {
      const dots = '.'.repeat(1 + (Math.floor(this.now() / 250) % 3));
      ctx.fillStyle = '#5B6B7A';
      ctx.fillText(`thinking${dots}`, x + 10, y + h / 2);
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(age * 1000)} ms`, x + w - 10, y + h / 2);
      ctx.textAlign = 'left';
    } else {
      b.top.slice(0, rows).forEach((t, k) => {
        const ry = y + 15 + k * 17;
        const barW = (w - 20) * t.p;
        ctx.fillStyle = k === 0 ? SIDES[i].fill : 'rgba(27,46,64,0.07)';
        ctx.fillRect(x + 10, ry - 7, barW, 14);
        ctx.fillStyle = INK;
        ctx.fillText(MOVE_LABELS[t.move], x + 13, ry);
        ctx.textAlign = 'right';
        ctx.fillText(`${Math.round(t.p * 100)}%`, x + w - 10, ry);
        ctx.textAlign = 'left';
      });
      if (b.fallback) {
        ctx.fillStyle = '#C2255C';
        ctx.fillText(`fallback: ${b.fallback}`, x + 10, y + h - 4);
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawHud(s: GameState, dt: number): void {
    const ctx = this.ctx;
    const W = this.W;
    const compact = W < 560;
    const barH = compact ? 14 : 20;
    const top = compact ? 14 : 22;
    const timerR = compact ? 19 : 26;
    const cx = W / 2;
    const margin = compact ? 30 : 64;
    const barW = cx - timerR - 14 - margin;
    for (const i of [0, 1] as const) {
      const f = s.fighters[i];
      // The ghost bar trails the real one.
      this.ghostHp[i] = Math.max(f.hp, this.ghostHp[i] - dt * 30);
      if (this.ghostHp[i] < f.hp) this.ghostHp[i] = f.hp;
      const x0 = i === 0 ? margin : cx + timerR + 14;
      const skew = 8;
      const frac = f.hp / MAX_HP;
      const ghost = this.ghostHp[i] / MAX_HP;
      const bar = (from: number, to: number, fill: string) => {
        // Fills from the outside in: left bar anchored at the center side.
        const a = i === 0 ? x0 + barW * (1 - to) : x0 + barW * from;
        const b = i === 0 ? x0 + barW * (1 - from) : x0 + barW * to;
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.moveTo(a + skew, top);
        ctx.lineTo(b + skew, top);
        ctx.lineTo(b, top + barH);
        ctx.lineTo(a, top + barH);
        ctx.closePath();
        ctx.fill();
      };
      bar(0, 1, '#ffffff');
      bar(0, ghost, SIDES[i].ghost);
      bar(0, frac, SIDES[i].fill);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x0 + skew, top);
      ctx.lineTo(x0 + barW + skew, top);
      ctx.lineTo(x0 + barW, top + barH);
      ctx.lineTo(x0, top + barH);
      ctx.closePath();
      ctx.stroke();
      // Colour dot at the outer end.
      const dx = i === 0 ? x0 - (compact ? 13 : 22) : x0 + barW + (compact ? 13 : 22);
      ctx.fillStyle = SIDES[i].fill;
      ctx.beginPath();
      ctx.arc(dx, top + barH / 2, compact ? 9 : 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Name.
      ctx.fillStyle = INK;
      ctx.font = `700 ${compact ? 17 : 24}px ${FONT}`;
      ctx.textBaseline = 'top';
      ctx.textAlign = i === 0 ? 'left' : 'right';
      const nameX = i === 0 ? x0 : x0 + barW + skew;
      ctx.fillText(this.meta[i].label, nameX, top + barH + 2);
      // Meter.
      const mw = Math.min(110, barW * 0.4);
      const my = top + barH + (compact ? 22 : 30);
      const mx = i === 0 ? x0 : x0 + barW + skew - mw;
      ctx.fillStyle = 'rgba(27,46,64,0.1)';
      ctx.fillRect(mx, my, mw, 5);
      ctx.fillStyle = f.meter >= MAX_METER ? '#3C3CAF' : SIDES[i].deep;
      const mf = (f.meter / MAX_METER) * mw;
      ctx.fillRect(i === 0 ? mx : mx + mw - mf, my, mf, 5);
      // Passivity: a tag once it warns, red while it costs HP.
      if (s.rules?.passivity && f.passive >= PASSIVE_WARN_TICKS) {
        const bleeding = f.passive >= PASSIVE_BLEED_TICKS;
        const label = bleeding ? 'PASSIVE -1/s' : `PASSIVE ${Math.max(0, Math.ceil((PASSIVE_BLEED_TICKS - f.passive) / TICK_HZ))}`;
        ctx.font = `700 ${compact ? 10 : 11}px "Wix Madefor Text", sans-serif`;
        ctx.textAlign = 'left';
        const tw = ctx.measureText(label).width + 12;
        const tx = i === 0 ? mx : mx + mw - tw;
        const ty = my + 10;
        ctx.fillStyle = bleeding ? '#C2255C' : '#E5A00D';
        ctx.beginPath();
        ctx.roundRect(tx, ty, tw, 16, 8);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, tx + 6, ty + 8.5);
        ctx.textBaseline = 'top';
      }
      ctx.textAlign = 'left';
    }
    // Timer.
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, top + barH / 2, timerR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.font = `700 ${compact ? 22 : 30}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.ceil(s.round.timer / TICK_HZ)), cx, top + barH / 2 + 1);
    // Round wins as pips under the timer.
    for (const i of [0, 1] as const) {
      for (let k = 0; k < 2; k++) {
        const px = cx + (i === 0 ? -1 : 1) * (10 + k * 14);
        const py = top + barH / 2 + timerR + 10;
        ctx.beginPath();
        ctx.arc(px, py, 5, 0, Math.PI * 2);
        ctx.fillStyle = s.wins[i] > k ? SIDES[i].fill : '#ffffff';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  private drawBanners(): void {
    const ctx = this.ctx;
    this.banners = this.banners.filter((b) => this.time - b.t0 < b.dur);
    for (const b of this.banners) {
      const t = this.time - b.t0;
      const pop = t < 0.18 ? 0.6 + (t / 0.18) * 0.55 : t < 0.3 ? 1.15 - ((t - 0.18) / 0.12) * 0.15 : 1;
      const fade = Math.min(1, (b.dur - t) / 0.3);
      const size = Math.min(this.W / 9, 84) * pop;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(this.W / 2, this.H * 0.42);
      ctx.rotate(-0.04);
      ctx.font = `700 ${size * 1.25}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = INK;
      ctx.lineWidth = size * 0.14;
      ctx.strokeText(b.text, 0, 0);
      if (b.color === 'gradient') {
        const w = ctx.measureText(b.text).width;
        const g = ctx.createLinearGradient(-w / 2, -size / 2, w / 2, size / 2);
        g.addColorStop(0, CYAN);
        g.addColorStop(1, PEACH);
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = b.color === INK ? '#ffffff' : b.color;
      }
      ctx.fillText(b.text, 0, 0);
      ctx.restore();
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Lighten (+) or darken (-) a hex colour. */
export function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k));
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `rgb(${r},${g},${b})`;
}
