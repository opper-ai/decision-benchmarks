import type { Fighter } from '../../shared/engine/engine.ts';
import { MOVES, attackDef, type MoveId } from '../../shared/engine/moves.ts';

/**
 * A pose for a fighter facing right. Angles in degrees.
 * - lean: torso tilt from vertical, + forward.
 * - arms (sh*, el*): shoulder angle relative to the torso's "down", + forward; elbow bend, + folds forward/up.
 * - legs (hip*, kn*): thigh angle from straight down, + forward; knee bend, + folds the shin backward.
 * - drop: how far the hips sit below standing height (body-lengths); lie: 0..1 blends to lying flat.
 * - dx: forward shift of the whole body (lunges), body-lengths.
 */
export interface Pose {
  lean: number;
  head: number;
  shF: number;
  elF: number;
  shB: number;
  elB: number;
  hipF: number;
  knF: number;
  hipB: number;
  knB: number;
  drop: number;
  dx: number;
  lie: number;
}

export const CHANNELS = ['lean', 'head', 'shF', 'elF', 'shB', 'elB', 'hipF', 'knF', 'hipB', 'knB', 'drop', 'dx', 'lie'] as const;
export type Channel = (typeof CHANNELS)[number];

const P = (p: Partial<Pose>): Pose => ({ ...GUARD, ...p });

export const GUARD: Pose = { lean: 8, head: -4, shF: 35, elF: 115, shB: 15, elB: 125, hipF: 20, knF: 24, hipB: -16, knB: 20, drop: 0.04, dx: 0, lie: 0 };

export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  const out = { ...a };
  for (const c of CHANNELS) out[c] = a[c] + (b[c] - a[c]) * t;
  return out;
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

interface AttackPoses {
  windup: Pose;
  strike: Pose;
  /** Fraction of recovery that holds the strike pose (follow-through). */
  hold?: number;
}

export const ATTACK_POSES: Partial<Record<MoveId, AttackPoses>> = {
  jab: {
    windup: P({ shF: 25, elF: 135, lean: 6 }),
    strike: P({ shF: 92, elF: 2, lean: 16, head: 2, dx: 0.06 }),
    hold: 0.4,
  },
  straight: {
    windup: P({ shB: 0, elB: 140, lean: 0, hipB: -24 }),
    strike: P({ shB: 96, elB: 0, lean: 26, shF: 10, elF: 120, hipF: 30, knF: 30, hipB: -30, knB: 6, dx: 0.16 }),
    hold: 0.35,
  },
  low_kick: {
    windup: P({ hipF: 40, knF: 80, lean: 0 }),
    strike: P({ hipF: 64, knF: 2, lean: -12, shF: 20, elF: 100, shB: -25, elB: 60, drop: 0.08 }),
    hold: 0.35,
  },
  high_kick: {
    windup: P({ hipB: 30, knB: 100, lean: -6, shB: -30, elB: 50 }),
    strike: P({ hipB: 128, knB: 0, hipF: -6, knF: 10, lean: -34, head: 10, shF: -10, elF: 70, shB: -60, elB: 30, dx: 0.04 }),
    hold: 0.3,
  },
  uppercut: {
    windup: P({ drop: 0.2, lean: 18, shB: -20, elB: 40, hipF: 40, knF: 70, hipB: -20, knB: 60 }),
    strike: P({ drop: -0.08, lean: -6, head: -14, shB: 168, elB: 14, shF: 20, elF: 110, hipF: 10, knF: 10, hipB: -14, knB: 30, dx: 0.06 }),
    hold: 0.45,
  },
  sweep: {
    windup: P({ lean: 30, hipF: 45, knF: 95, hipB: 30, knB: 105, shF: 55, elF: 30, shB: 35, elB: 40 }),
    strike: P({ lean: 36, head: 8, hipF: 72, knF: 0, hipB: 60, knB: 142, shF: 28, elF: 6, shB: 14, elB: 10 }),
    hold: 0.35,
  },
  throw: {
    windup: P({ shF: 70, elF: 40, shB: 65, elB: 50, lean: 14, dx: 0.04 }),
    strike: P({ shF: 85, elF: 15, shB: 82, elB: 22, lean: 24, dx: 0.14, hipF: 30, knF: 34 }),
    hold: 0.15,
  },
  jump_kick: {
    windup: P({ hipF: 60, knF: 110, hipB: 30, knB: 120, lean: 10, shF: 60, elF: 80, shB: -30, elB: 40 }),
    strike: P({ hipF: 58, knF: 0, hipB: 25, knB: 125, lean: -18, shF: -10, elF: 60, shB: -50, elB: 30 }),
    hold: 0.2,
  },
  special: {
    windup: P({ lean: -16, shF: -40, elF: 30, shB: -55, elB: 30, hipF: 30, knF: 40, drop: 0.1 }),
    strike: P({ lean: 34, shF: 95, elF: 0, shB: 88, elB: 6, hipF: 46, knF: 30, hipB: -44, knB: 4, drop: 0.12, dx: 0.42, head: 6 }),
    hold: 0.3,
  },
};

const BLOCK_HIGH = P({ shF: 75, elF: 128, shB: 62, elB: 138, lean: -4, head: 6, drop: 0.06 });
const BLOCK_LOW = P({ shF: 28, elF: 35, shB: 18, elB: 45, lean: 18, drop: 0.2, hipF: 38, knF: 70, hipB: -24, knB: 60 });
const HITSTUN = P({ lean: -30, head: -18, shF: -30, elF: 40, shB: -50, elB: 30, hipF: 10, knF: 30, hipB: -30, knB: 20, dx: -0.05 });
const LYING = P({ lie: 1, lean: -90, head: -10, shF: -105, elF: 25, shB: -85, elB: 15, hipF: 90, knF: 20, hipB: 80, knB: 40, drop: 0 });
const CROUCH = P({ drop: 0.38, lean: 34, shF: 60, elF: 60, shB: 40, elB: 70, hipF: 55, knF: 120, hipB: -20, knB: 110 });
const JUMP_TUCK = P({ hipF: 70, knF: 120, hipB: 40, knB: 125, shF: 70, elF: 90, shB: 30, elB: 100, lean: 10 });
const BACKDASH = P({ lean: -16, hipF: 40, knF: 20, hipB: -30, knB: 30, shF: 10, elF: 110, shB: -10, elB: 110 });
const VICTORY = P({ shF: 170, elF: 20, shB: 160, elB: 30, lean: -6, head: -10, hipF: 10, knF: 4, hipB: -10, knB: 4, drop: 0 });

function attackPose(atk: MoveId, f: Fighter): Pose {
  const key: MoveId = atk === 'jab_straight' ? 'jab' : atk === 'low_kick_sweep' ? 'low_kick' : atk;
  const set = ATTACK_POSES[key];
  const d = attackDef(atk);
  if (!set || !d) return GUARD;
  const p = f.len ? clamp01(f.frame / f.len) : 1;
  if (f.phase === 'startup') return lerpPose(GUARD, set.windup, easeInOut(p));
  if (f.phase === 'active') return lerpPose(set.windup, set.strike, easeOut(clamp01(f.frame / Math.max(1, Math.min(2, f.len)))));
  const hold = set.hold ?? 0.3;
  if (p < hold) return set.strike;
  const base = d.airborne ? JUMP_TUCK : GUARD;
  return lerpPose(set.strike, base, easeInOut((p - hold) / (1 - hold)));
}

/** The pose the fighter's sim state asks for. `t` (seconds) drives idle breathing. */
export function poseFor(f: Fighter, t: number, won: boolean): Pose {
  const breathe = Math.sin(t * 3.1);
  switch (f.phase) {
    case 'idle':
      if (won) return VICTORY;
      return P({ drop: 0.04 + 0.012 * breathe, shF: 35 + 3 * breathe, shB: 15 - 2 * breathe, lean: 8 + 1.5 * breathe });
    case 'block':
      return f.guard === 'low' ? BLOCK_LOW : BLOCK_HIGH;
    case 'blockstun':
      return lerpPose(f.guard === 'low' ? BLOCK_LOW : BLOCK_HIGH, P({ lean: -14, dx: -0.04 }), 0.4);
    case 'startup':
    case 'active':
    case 'recovery':
      return f.atk ? attackPose(f.atk, f) : GUARD;
    case 'move': {
      const d = f.move ? MOVES[f.move] : null;
      const p = d && d.kind === 'movement' ? clamp01(f.moveFrame / d.frames) : 0;
      if (f.move === 'jump') {
        const k = Math.sin(p * Math.PI);
        return lerpPose(P({ drop: 0.16, lean: 14, hipF: 40, knF: 70, hipB: -10, knB: 60 }), JUMP_TUCK, Math.min(1, k * 1.6));
      }
      if (f.move === 'backdash') return lerpPose(BACKDASH, GUARD, p > 0.7 ? (p - 0.7) / 0.3 : 0);
      if (f.move === 'dash_forward') {
        const k = Math.sin(p * Math.PI);
        return lerpPose(GUARD, P({ lean: 30, head: 6, hipF: 50, knF: 40, hipB: -40, knB: 30, shF: 50, elF: 100, shB: -20, elB: 90, drop: 0.12 }), k);
      }
      // Walking: one step per move, legs scissor through it.
      const dir = f.move === 'walk_back' ? -1 : 1;
      const s = Math.sin(p * Math.PI);
      const swing = Math.cos(p * Math.PI);
      // Walking back keeps the guard up.
      const arms = dir < 0 ? { shF: 75, elF: 128, shB: 62, elB: 138 } : {};
      return P({
        ...arms,
        hipF: 20 + dir * 22 * swing,
        knF: 24 + 34 * s,
        hipB: -16 - dir * 22 * swing,
        knB: 20 + 10 * (1 - s),
        drop: 0.04 + 0.03 * s,
        lean: 10 + dir * 3,
      });
    }
    case 'hitstun': {
      const p = f.len ? clamp01(f.frame / f.len) : 1;
      return lerpPose(HITSTUN, GUARD, p > 0.6 ? (p - 0.6) / 0.4 : 0);
    }
    case 'knockdown':
      return LYING;
    case 'getup': {
      const p = f.len ? clamp01(f.frame / f.len) : 1;
      return p < 0.5 ? lerpPose(LYING, CROUCH, easeInOut(p / 0.5)) : lerpPose(CROUCH, GUARD, easeInOut((p - 0.5) / 0.5));
    }
    case 'ko':
      return LYING;
  }
}
