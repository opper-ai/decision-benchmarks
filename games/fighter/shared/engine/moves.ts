/** Distances are in milli-body-lengths: 1000 units = one body-length. */
export const U = 1000;

export const MOVE_IDS = [
  'jab',
  'straight',
  'low_kick',
  'high_kick',
  'uppercut',
  'sweep',
  'throw',
  'jump_kick',
  'special',
  'jab_straight',
  'low_kick_sweep',
  'block_high',
  'block_low',
  'walk_forward',
  'dash_forward',
  'walk_back',
  'backdash',
  'jump',
] as const;
export type MoveId = (typeof MOVE_IDS)[number];
export const isMoveId = (v: unknown): v is MoveId => typeof v === 'string' && (MOVE_IDS as readonly string[]).includes(v);

/** Which block stops an attack. `throw` is unblockable. */
export type Height = 'high' | 'low' | 'overhead' | 'throw';

export interface AttackDef {
  kind: 'attack';
  startup: number;
  active: number;
  recovery: number;
  dmg: number;
  /** Max center-to-center distance at which the hit connects. */
  range: number;
  height: Height;
  knockdown?: boolean;
  /** Frames (from move start, 1-based, inclusive) during which airborne attacks pass through. */
  antiAirInvuln?: [number, number];
  /** Absorbs one hit during startup and active. */
  armor?: boolean;
  meterCost?: number;
  /** An airborne attack: a jump arc over the whole move, moving forward by `dx`. */
  airborne?: { dx: number };
  /** If this attack hits, chain straight into this one instead of recovering. */
  chainTo?: MoveId;
  /** Forward distance covered during startup (a dash). */
  dash?: number;
}

export interface BlockDef {
  kind: 'block';
  guard: 'high' | 'low';
  /** Frames the stance is held before the fighter may act again. */
  min: number;
}

export interface MovementDef {
  kind: 'movement';
  frames: number;
  /** Total forward displacement (negative = backward). */
  dx: number;
  /** Frames (1-based, inclusive) during which the fighter cannot be hit. */
  invuln?: [number, number];
  jump?: boolean;
  /** Guards high while moving (walking back). */
  guards?: boolean;
}

export type MoveDef = AttackDef | BlockDef | MovementDef;

export const MOVES: Record<MoveId, MoveDef> = {
  jab: { kind: 'attack', startup: 4, active: 2, recovery: 11, dmg: 4, range: 1000, height: 'high' },
  straight: { kind: 'attack', startup: 7, active: 3, recovery: 14, dmg: 8, range: 1200, height: 'high' },
  low_kick: { kind: 'attack', startup: 6, active: 3, recovery: 12, dmg: 6, range: 1100, height: 'low' },
  high_kick: { kind: 'attack', startup: 10, active: 4, recovery: 20, dmg: 12, range: 1300, height: 'high' },
  uppercut: { kind: 'attack', startup: 6, active: 4, recovery: 24, dmg: 14, range: 950, height: 'high', antiAirInvuln: [1, 8], knockdown: true },
  sweep: { kind: 'attack', startup: 11, active: 4, recovery: 22, dmg: 9, range: 1300, height: 'low', knockdown: true },
  throw: { kind: 'attack', startup: 5, active: 2, recovery: 20, dmg: 12, range: 850, height: 'throw', knockdown: true },
  jump_kick: { kind: 'attack', startup: 13, active: 7, recovery: 14, dmg: 10, range: 1100, height: 'overhead', airborne: { dx: 1500 } },
  special: { kind: 'attack', startup: 9, active: 5, recovery: 26, dmg: 18, range: 1100, height: 'high', armor: true, meterCost: 100, dash: 1000 },
  jab_straight: { kind: 'attack', startup: 4, active: 2, recovery: 11, dmg: 4, range: 1000, height: 'high', chainTo: 'straight' },
  low_kick_sweep: { kind: 'attack', startup: 6, active: 3, recovery: 12, dmg: 6, range: 1100, height: 'low', chainTo: 'sweep' },
  block_high: { kind: 'block', guard: 'high', min: 18 },
  block_low: { kind: 'block', guard: 'low', min: 18 },
  walk_forward: { kind: 'movement', frames: 12, dx: 400 },
  dash_forward: { kind: 'movement', frames: 9, dx: 800 },
  /** Walking back guards high, like holding back. */
  walk_back: { kind: 'movement', frames: 12, dx: -400, guards: true },
  backdash: { kind: 'movement', frames: 18, dx: -1000, invuln: [1, 6] },
  jump: { kind: 'movement', frames: 34, dx: 0, jump: true },
};

export const attackDef = (id: MoveId): AttackDef | null => {
  const d = MOVES[id];
  return d.kind === 'attack' ? d : null;
};

export const totalFrames = (d: AttackDef): number => d.startup + d.active + d.recovery;

/** Human-readable names for the HUD and decision cards. */
export const MOVE_LABELS: Record<MoveId, string> = {
  jab: 'Jab',
  straight: 'Straight',
  low_kick: 'Low kick',
  high_kick: 'High kick',
  uppercut: 'Uppercut',
  sweep: 'Sweep',
  throw: 'Throw',
  jump_kick: 'Jump kick',
  special: 'Dash palm',
  jab_straight: 'Jab → straight',
  low_kick_sweep: 'Low kick → sweep',
  block_high: 'Block high',
  block_low: 'Block low',
  walk_forward: 'Step in',
  dash_forward: 'Dash in',
  walk_back: 'Step back',
  backdash: 'Backdash',
  jump: 'Jump',
};

export const JUMP_HEIGHT = 1100;
export const HITSTUN_BASE = 10;
export const BLOCKSTUN_BASE = 6;
export const KNOCKDOWN_FRAMES = 40;
export const GETUP_FRAMES = 20;
/** Frames after getup, hitstun or blockstun during which a fighter cannot be thrown. */
export const THROW_PROTECTION = 6;
/** Share of a blocked strike's damage that still gets through. */
export const CHIP_DIVISOR = 4;
