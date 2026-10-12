import { CHANNELS, type Pose } from './pose.ts';

/** Bone lengths in body-lengths. */
export const BONES = { torso: 0.5, neck: 0.08, headR: 0.15, upper: 0.3, fore: 0.29, thigh: 0.42, shin: 0.42, foot: 0.11 };

export interface Vec {
  x: number;
  y: number;
}

export interface Joints {
  hip: Vec;
  shoulder: Vec;
  head: Vec;
  elbowF: Vec;
  handF: Vec;
  elbowB: Vec;
  handB: Vec;
  kneeF: Vec;
  ankleF: Vec;
  toeF: Vec;
  kneeB: Vec;
  ankleB: Vec;
  toeB: Vec;
}

const rad = (d: number) => (d * Math.PI) / 180;
/** Direction for an angle measured from straight down, + forward. */
const dirv = (deg: number, dir: number, len: number): Vec => ({ x: dir * Math.sin(rad(deg)) * len, y: -Math.cos(rad(deg)) * len });
const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });

/** Forward kinematics. Feet are planted on the ground unless airborne (`air` > 0) or lying. */
export function solve(p: Pose, x: number, air: number, dir: 1 | -1): Joints {
  const thighF = dirv(p.hipF, dir, BONES.thigh);
  const shinF = dirv(p.hipF - p.knF, dir, BONES.shin);
  const thighB = dirv(p.hipB, dir, BONES.thigh);
  const shinB = dirv(p.hipB - p.knB, dir, BONES.shin);
  // Planted: the lower foot touches the ground.
  const planted = Math.max(-(thighF.y + shinF.y), -(thighB.y + shinB.y)) + 0.02;
  const standing = planted + Math.max(0, -p.drop);
  const hipH = standing * (1 - p.lie) + 0.12 * p.lie + air;
  const hip = { x: x + dir * p.dx, y: hipH };
  const up = { x: dir * Math.sin(rad(p.lean)) * BONES.torso, y: Math.cos(rad(p.lean)) * BONES.torso };
  const shoulder = add(hip, up);
  const ht = rad(p.lean + p.head);
  const head = add(shoulder, { x: dir * Math.sin(ht) * (BONES.neck + BONES.headR), y: Math.cos(ht) * (BONES.neck + BONES.headR) });
  const elbowF = add(shoulder, dirv(p.shF, dir, BONES.upper));
  const handF = add(elbowF, dirv(p.shF + p.elF, dir, BONES.fore));
  const elbowB = add(shoulder, dirv(p.shB, dir, BONES.upper));
  const handB = add(elbowB, dirv(p.shB + p.elB, dir, BONES.fore));
  const kneeF = add(hip, thighF);
  const ankleF = add(kneeF, shinF);
  const kneeB = add(hip, thighB);
  const ankleB = add(kneeB, shinB);
  const footAng = (hip: number, kn: number) => (p.lie > 0.5 ? hip - kn + 90 : 90 + (hip - kn) * 0.25);
  const toeF = add(ankleF, dirv(footAng(p.hipF, p.knF), dir, BONES.foot));
  const toeB = add(ankleB, dirv(footAng(p.hipB, p.knB), dir, BONES.foot));
  const j: Joints = { hip, shoulder, head, elbowF, handF, elbowB, handB, kneeF, ankleF, toeF, kneeB, ankleB, toeB };
  // Nothing goes through the floor.
  for (const v of Object.values(j)) v.y = Math.max(0.015, v.y);
  j.head.y = Math.max(BONES.headR * 0.8, j.head.y);
  return j;
}

/** A critically-ish damped spring per pose channel: smooth blends with a little overshoot. */
export class PoseSpring {
  private x: Pose | null = null;
  private v: Record<string, number> = {};

  constructor(
    private omega = 34,
    private zeta = 0.7,
  ) {}

  snap(p: Pose): void {
    this.x = { ...p };
    for (const c of CHANNELS) this.v[c] = 0;
  }

  update(target: Pose, dt: number, omega = this.omega): Pose {
    if (!this.x) this.snap(target);
    const x = this.x!;
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      for (const c of CHANNELS) {
        const a = omega * omega * (target[c] - x[c]) - 2 * this.zeta * omega * (this.v[c] ?? 0);
        this.v[c] = (this.v[c] ?? 0) + a * h;
        x[c] += this.v[c] * h;
      }
    }
    return { ...x };
  }
}

const RAG_POINTS = ['head', 'shoulder', 'hip', 'elbowF', 'handF', 'elbowB', 'handB', 'kneeF', 'ankleF', 'kneeB', 'ankleB'] as const;
type RagPoint = (typeof RAG_POINTS)[number];
const STICKS: [RagPoint, RagPoint][] = [
  ['head', 'shoulder'],
  ['shoulder', 'hip'],
  ['shoulder', 'elbowF'],
  ['elbowF', 'handF'],
  ['shoulder', 'elbowB'],
  ['elbowB', 'handB'],
  ['hip', 'kneeF'],
  ['kneeF', 'ankleF'],
  ['hip', 'kneeB'],
  ['kneeB', 'ankleB'],
  // Keep the body from folding flat on itself.
  ['head', 'hip'],
  ['kneeF', 'kneeB'],
];

/** A Verlet ragdoll for knockouts. Render-only. */
export class Ragdoll {
  private p: Record<RagPoint, Vec>;
  private prev: Record<RagPoint, Vec>;
  private len: number[];
  private dir: 1 | -1;
  settled = 0;

  constructor(j: Joints, away: number, power: number, dir: 1 | -1) {
    this.dir = dir;
    this.p = {} as Record<RagPoint, Vec>;
    this.prev = {} as Record<RagPoint, Vec>;
    const dt = 1 / 120;
    RAG_POINTS.forEach((k, idx) => {
      const v = j[k];
      this.p[k] = { ...v };
      // Upper body flies harder than feet: the hit spins the body.
      const lift = Math.max(0, v.y - 0.3);
      const vx = away * power * (0.6 + lift * 0.9) + Math.sin(idx * 1.7) * 0.15;
      const vy = power * (0.9 + lift * 0.5);
      this.prev[k] = { x: v.x - vx * dt, y: v.y - vy * dt };
    });
    this.len = STICKS.map(([a, b]) => Math.hypot(this.p[a].x - this.p[b].x, this.p[a].y - this.p[b].y));
  }

  step(dt: number): void {
    const h = 1 / 120;
    const n = Math.min(8, Math.max(1, Math.round(dt / h)));
    for (let s = 0; s < n; s++) {
      for (const k of RAG_POINTS) {
        const c = this.p[k];
        const pv = this.prev[k];
        const vx = (c.x - pv.x) * 0.995;
        const vy = (c.y - pv.y) * 0.995;
        pv.x = c.x;
        pv.y = c.y;
        c.x += vx;
        c.y += vy - 16 * h * h;
      }
      for (let it = 0; it < 6; it++) {
        STICKS.forEach(([a, b], idx) => {
          const pa = this.p[a];
          const pb = this.p[b];
          const dx = pb.x - pa.x;
          const dy = pb.y - pa.y;
          const d = Math.hypot(dx, dy) || 1e-6;
          const diff = (d - this.len[idx]) / d / 2;
          pa.x += dx * diff;
          pa.y += dy * diff;
          pb.x -= dx * diff;
          pb.y -= dy * diff;
        });
        for (const k of RAG_POINTS) {
          const r = k === 'head' ? BONES.headR * 0.85 : 0.03;
          const c = this.p[k];
          if (c.y < r) {
            c.y = r;
            // Ground friction.
            const pv = this.prev[k];
            pv.x = c.x - (c.x - pv.x) * 0.6;
            if (pv.y < c.y) pv.y = c.y + (c.y - pv.y) * 0.25;
          }
        }
      }
    }
    const speed = RAG_POINTS.reduce((m, k) => Math.max(m, Math.hypot(this.p[k].x - this.prev[k].x, this.p[k].y - this.prev[k].y)), 0);
    if (speed < 0.002) this.settled += dt;
  }

  joints(): Joints {
    const p = this.p;
    const foot = (a: Vec, k: Vec): Vec => {
      const dx = a.x - k.x;
      const dy = a.y - k.y;
      const d = Math.hypot(dx, dy) || 1;
      return { x: a.x + (-dy / d) * BONES.foot * this.dir, y: Math.max(0.015, a.y + (dx / d) * BONES.foot * this.dir) };
    };
    return {
      head: p.head,
      shoulder: p.shoulder,
      hip: p.hip,
      elbowF: p.elbowF,
      handF: p.handF,
      elbowB: p.elbowB,
      handB: p.handB,
      kneeF: p.kneeF,
      ankleF: p.ankleF,
      toeF: foot(p.ankleF, p.kneeF),
      kneeB: p.kneeB,
      ankleB: p.ankleB,
      toeB: foot(p.ankleB, p.kneeB),
    };
  }
}
