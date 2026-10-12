import {
  BLOCKSTUN_BASE,
  CHIP_DIVISOR,
  THROW_PROTECTION,
  GETUP_FRAMES,
  HITSTUN_BASE,
  JUMP_HEIGHT,
  KNOCKDOWN_FRAMES,
  MOVE_IDS,
  MOVES,
  attackDef,
  type AttackDef,
  type MoveId,
} from './moves.ts';

/** Bump on any change to moves, rules or this file's behaviour: replays name the version they need. */
export const ENGINE_VERSION = '7';
/** Older engine versions whose replays this engine reproduces exactly (v5 only added rules, stored per replay). */
export const COMPATIBLE_VERSIONS = ['7'];
/** Rules new matches are played with. */
export const DEFAULT_RULES: Rules = { passivity: true };

export const TICK_HZ = 60;
export const STAGE_MIN = 500;
export const STAGE_MAX = 9500;
export const MIN_GAP = 700;
export const START_GAP_MIN = 2000;
export const START_GAP_MAX = 4000;
export const ROUND_TICKS = 60 * TICK_HZ;
export const INTRO_TICKS = 90;
export const KO_OUTRO_TICKS = 150;
export const TIME_OUTRO_TICKS = 90;
export const MAX_HP = 100;
export const MAX_METER = 100;
export const WINS_NEEDED = 2;
export const MAX_ROUNDS = 5;
const HISTORY_LEN = 8;

export type Phase = 'idle' | 'startup' | 'active' | 'recovery' | 'block' | 'move' | 'blockstun' | 'hitstun' | 'knockdown' | 'getup' | 'ko';
export type Side = 0 | 1;

export interface Fighter {
  x: number;
  y: number;
  hp: number;
  meter: number;
  phase: Phase;
  /** The move that was chosen (a combo keeps its id while its second hit runs). */
  move: MoveId | null;
  /** The single attack currently running: differs from `move` once a combo chains. */
  atk: MoveId | null;
  /** Frames spent in the current phase, from 1. */
  frame: number;
  /** Length of the current phase; 0 = open-ended. */
  len: number;
  /** Frames since the current move (or chained attack) started, from 1. */
  moveFrame: number;
  hasHit: boolean;
  landed: boolean;
  armorUsed: boolean;
  guard: 'high' | 'low';
  /** Remaining pushback, signed, applied over a few frames. */
  push: number;
  /** Tick at which the current move started (for animation). */
  moveTick: number;
  /** Tick at which the current phase started (for animation). */
  phaseTick: number;
  /** Cannot be thrown before this tick. */
  throwSafeUntil: number;
  /** Ticks of passive play (free, unpressured, not attacking or stepping in). Only with the passivity rule. */
  passive: number;
}

export interface RoundResult {
  n: number;
  winner: Side | null;
  reason: 'ko' | 'time';
  hp: [number, number];
  tick: number;
}

export interface Exchange {
  tick: number;
  /** The attacker. */
  f: Side;
  move: MoveId;
  result: 'hit' | 'blocked' | 'whiffed' | 'armored';
  dmg: number;
}

/** Optional rules, fixed for a match and stored in its replay. */
export interface Rules {
  /**
   * Passivity penalty: a fighter that spends PASSIVE_WARN_TICKS free and unpressured without attacking
   * or stepping in is warned; from PASSIVE_BLEED_TICKS it loses 1 HP per second (never the last one)
   * until it engages. Ends the "standoff" rule.
   */
  passivity?: boolean;
}

export const PASSIVE_WARN_TICKS = 6 * TICK_HZ;
export const PASSIVE_BLEED_TICKS = 8 * TICK_HZ;

export interface GameState {
  rules: Rules;
  version: string;
  seed: number;
  rng: number;
  tick: number;
  hitstop: number;
  fighters: [Fighter, Fighter];
  round: { n: number; phase: 'intro' | 'fight' | 'outro' | 'over'; left: number; timer: number };
  wins: [number, number];
  results: RoundResult[];
  winner: Side | null;
  history: Exchange[];
}

export type GameEvent =
  | { kind: 'start'; tick: number; f: Side; move: MoveId }
  | { kind: 'hit'; tick: number; f: Side; move: MoveId; dmg: number; knockdown: boolean; x: number; y: number }
  | { kind: 'block'; tick: number; f: Side; move: MoveId; dmg: number; chip: number; x: number; y: number }
  | { kind: 'armor'; tick: number; f: Side; move: MoveId; dmg: number; x: number; y: number }
  | { kind: 'whiff'; tick: number; f: Side; move: MoveId }
  | { kind: 'ko'; tick: number; f: Side }
  | { kind: 'round_start'; tick: number; n: number }
  | { kind: 'round_end'; tick: number; result: RoundResult }
  | { kind: 'match_end'; tick: number; winner: Side | null }
  | { kind: 'penalty'; tick: number; f: Side; dmg: number };

export type Inputs = [MoveId | null, MoveId | null];

/** mulberry32: small, fast, deterministic. Returns [value in [0,1), next state]. */
export function rand(state: number): [number, number] {
  let t = (state + 0x6d2b79f5) | 0;
  const next = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

function newFighter(x: number, meter = 0): Fighter {
  return {
    x,
    y: 0,
    hp: MAX_HP,
    meter,
    phase: 'idle',
    move: null,
    atk: null,
    frame: 0,
    len: 0,
    moveFrame: 0,
    hasHit: false,
    landed: false,
    armorUsed: false,
    guard: 'high',
    push: 0,
    moveTick: 0,
    phaseTick: 0,
    throwSafeUntil: 0,
    passive: 0,
  };
}

function placeFighters(s: GameState, meters: [number, number]): void {
  // The seed sets the starting distance (2.0 to 4.0) and where on the stage the fight starts.
  const [r1, n1] = rand(s.rng);
  const [r2, n2] = rand(n1);
  s.rng = n2;
  const startGap = START_GAP_MIN + Math.floor(r1 * ((START_GAP_MAX - START_GAP_MIN) / 10 + 1)) * 10;
  const lo = STAGE_MIN + 300 + startGap / 2;
  const hi = STAGE_MAX - 300 - startGap / 2;
  const mid = lo + Math.floor(r2 * ((hi - lo) / 10 + 1)) * 10;
  s.fighters = [newFighter(mid - startGap / 2, meters[0]), newFighter(mid + startGap / 2, meters[1])];
}

export function newGame(seed: number, rules: Rules = {}): GameState {
  const s: GameState = {
    rules: { ...rules },
    version: ENGINE_VERSION,
    seed: seed >>> 0,
    rng: seed >>> 0,
    tick: 0,
    hitstop: 0,
    fighters: [newFighter(0), newFighter(0)],
    round: { n: 1, phase: 'intro', left: INTRO_TICKS, timer: ROUND_TICKS },
    wins: [0, 0],
    results: [],
    winner: null,
    history: [],
  };
  placeFighters(s, [0, 0]);
  return s;
}

export const clone = (s: GameState): GameState => structuredClone(s);

/** Fighter 0 always faces right (+1), fighter 1 left (-1). They never cross. */
export const facing = (i: Side): 1 | -1 => (i === 0 ? 1 : -1);
export const gap = (s: GameState): number => s.fighters[1].x - s.fighters[0].x;

export function isActionable(s: GameState, i: Side): boolean {
  if (s.round.phase !== 'fight' || s.hitstop > 0) return false;
  const f = s.fighters[i];
  if (f.phase === 'idle') return true;
  // On the last frame of getting up (still invulnerable) the fighter may already act, so a timed
  // attack on wake-up can be answered.
  if (f.phase === 'getup') return f.frame >= f.len;
  if (f.phase === 'block' && f.move) {
    const d = MOVES[f.move];
    return d.kind === 'block' && f.frame >= d.min;
  }
  return false;
}

/** Ticks until the fighter could act again if nothing hits it. Infinity when knocked out. */
export function committedFrames(f: Fighter): number {
  const left = Math.max(0, f.len - f.frame);
  const atk = f.atk ? attackDef(f.atk) : null;
  switch (f.phase) {
    case 'idle':
      return 0;
    case 'block': {
      const d = f.move ? MOVES[f.move] : null;
      return d && d.kind === 'block' ? Math.max(0, d.min - f.frame) : 0;
    }
    case 'startup':
      return left + (atk ? atk.active + atk.recovery : 0) + 1;
    case 'active':
      return left + (atk ? atk.recovery : 0) + 1;
    case 'knockdown':
      return left + GETUP_FRAMES + 1;
    case 'ko':
      return Infinity;
    default:
      return left + 1;
  }
}

export function isAirborne(f: Fighter): boolean {
  return f.y > 0;
}

/** Moves the fighter may start right now. Empty when not actionable. */
export function legalMoves(s: GameState, i: Side): MoveId[] {
  if (!isActionable(s, i)) return [];
  const f = s.fighters[i];
  const wallDist = i === 0 ? f.x - STAGE_MIN : STAGE_MAX - f.x;
  return MOVE_IDS.filter((m) => {
    const d = MOVES[m];
    if (d.kind === 'attack' && d.meterCost && f.meter < d.meterCost) return false;
    if ((m === 'walk_forward' || m === 'dash_forward') && gap(s) <= MIN_GAP + 20) return false;
    if ((m === 'walk_back' || m === 'backdash') && wallDist < 50) return false;
    return true;
  });
}

function enter(f: Fighter, phase: Phase, len: number, tick: number): void {
  f.phase = phase;
  f.len = len;
  f.frame = 0;
  f.phaseTick = tick;
}

function startMove(s: GameState, i: Side, m: MoveId, events: GameEvent[]): void {
  const f = s.fighters[i];
  const d = MOVES[m];
  if (f.phase === 'getup') f.throwSafeUntil = s.tick + THROW_PROTECTION;
  f.move = m;
  f.atk = d.kind === 'attack' ? m : null;
  f.moveFrame = 0;
  f.moveTick = s.tick;
  f.hasHit = false;
  f.landed = false;
  f.armorUsed = false;
  if (d.kind === 'attack') {
    if (d.meterCost) f.meter -= d.meterCost;
    enter(f, 'startup', d.startup, s.tick);
  } else if (d.kind === 'block') {
    f.guard = d.guard;
    enter(f, 'block', 0, s.tick);
  } else {
    enter(f, 'move', d.frames, s.tick);
  }
  events.push({ kind: 'start', tick: s.tick, f: i, move: m });
}

function step1(total: number, n: number, of: number): number {
  return Math.trunc((total * n) / of) - Math.trunc((total * (n - 1)) / of);
}

function arcY(n: number, of: number): number {
  if (n <= 0 || n >= of) return 0;
  return Math.trunc((4 * JUMP_HEIGHT * n * (of - n)) / (of * of));
}

function pushHistory(s: GameState, e: Exchange): void {
  s.history.push(e);
  if (s.history.length > HISTORY_LEN) s.history.shift();
}

/** Advance one fighter's own timeline by one frame. */
function advance(s: GameState, i: Side, events: GameEvent[]): void {
  const f = s.fighters[i];
  const dir = facing(i);
  f.frame++;
  if (f.move) f.moveFrame++;

  // Pushback slides over a few frames.
  if (f.push !== 0) {
    const d = Math.sign(f.push) * Math.min(Math.abs(f.push), 70);
    f.x += d;
    f.push -= d;
  }

  const atk = f.atk ? attackDef(f.atk) : null;
  if (atk?.airborne && (f.phase === 'startup' || f.phase === 'active' || f.phase === 'recovery')) {
    const total = atk.startup + atk.active + atk.recovery;
    if (f.moveFrame <= total) {
      f.x += dir * step1(atk.airborne.dx, f.moveFrame, total);
      f.y = arcY(f.moveFrame, total);
    }
  }

  if (atk?.dash && f.phase === 'startup' && f.moveFrame <= atk.startup) f.x += dir * step1(atk.dash, f.moveFrame, atk.startup);

  switch (f.phase) {
    case 'startup':
      if (atk && f.frame > f.len) {
        enter(f, 'active', atk.active, s.tick);
        f.frame = 1;
      }
      break;
    case 'active':
      if (atk && f.frame > f.len) {
        if (f.landed && atk.chainTo) {
          const next = attackDef(atk.chainTo)!;
          f.atk = atk.chainTo;
          f.moveFrame = 1;
          f.hasHit = false;
          f.landed = false;
          enter(f, 'startup', next.startup, s.tick);
          f.frame = 1;
        } else {
          if (!f.hasHit) {
            events.push({ kind: 'whiff', tick: s.tick, f: i, move: f.atk! });
            pushHistory(s, { tick: s.tick, f: i, move: f.atk!, result: 'whiffed', dmg: 0 });
          }
          enter(f, 'recovery', atk.recovery, s.tick);
          f.frame = 1;
        }
      }
      break;
    case 'recovery':
      if (f.frame > f.len) {
        f.y = 0;
        toIdle(f, s.tick);
      }
      break;
    case 'move': {
      const d = f.move ? MOVES[f.move] : null;
      if (d && d.kind === 'movement') {
        if (d.dx && f.moveFrame <= d.frames) f.x += dir * step1(d.dx, f.moveFrame, d.frames);
        if (d.jump) f.y = arcY(f.moveFrame, d.frames);
      }
      if (f.frame > f.len) {
        f.y = 0;
        toIdle(f, s.tick);
      }
      break;
    }
    case 'blockstun':
      if (f.frame > f.len) {
        f.throwSafeUntil = s.tick + THROW_PROTECTION;
        const d = f.guard === 'low' ? MOVES.block_low : MOVES.block_high;
        f.move = f.guard === 'low' ? 'block_low' : 'block_high';
        enter(f, 'block', 0, s.tick);
        f.frame = d.kind === 'block' ? d.min : 0;
      }
      break;
    case 'hitstun':
      if (f.frame > f.len) {
        f.throwSafeUntil = s.tick + THROW_PROTECTION;
        toIdle(f, s.tick);
      }
      break;
    case 'knockdown':
      if (f.y > 0) f.y = Math.max(0, f.y - 110);
      if (f.frame > f.len) {
        enter(f, 'getup', GETUP_FRAMES, s.tick);
        f.frame = 1;
      }
      break;
    case 'getup':
      if (f.frame > f.len) {
        f.throwSafeUntil = s.tick + THROW_PROTECTION;
        toIdle(f, s.tick);
      }
      break;
    case 'ko':
      if (f.y > 0) f.y = Math.max(0, f.y - 110);
      break;
    default:
      break;
  }
}

function toIdle(f: Fighter, tick: number): void {
  f.move = null;
  f.atk = null;
  f.moveFrame = 0;
  f.guard = 'high';
  enter(f, 'idle', 0, tick);
}

function clampPositions(s: GameState): void {
  const [a, b] = s.fighters;
  a.x = Math.max(STAGE_MIN, Math.min(STAGE_MAX, a.x));
  b.x = Math.max(STAGE_MIN, Math.min(STAGE_MAX, b.x));
  if (b.x - a.x < MIN_GAP) {
    const over = MIN_GAP - (b.x - a.x);
    // Whoever is not against a wall gives way; split otherwise.
    let da = Math.ceil(over / 2);
    let db = over - da;
    if (a.x - da < STAGE_MIN) {
      db += da - (a.x - STAGE_MIN);
      da = a.x - STAGE_MIN;
    }
    if (b.x + db > STAGE_MAX) {
      da += db - (STAGE_MAX - b.x);
      db = STAGE_MAX - b.x;
    }
    a.x -= da;
    b.x += db;
  }
}

function invulnerable(def: Fighter, attacker: Fighter): boolean {
  if (def.phase === 'knockdown' || def.phase === 'getup' || def.phase === 'ko') return true;
  if (def.phase === 'move' && def.move) {
    const d = MOVES[def.move];
    if (d.kind === 'movement' && d.invuln && def.moveFrame >= d.invuln[0] && def.moveFrame <= d.invuln[1]) return true;
  }
  if (isAirborne(attacker) && def.atk && (def.phase === 'startup' || def.phase === 'active')) {
    const a = attackDef(def.atk);
    if (a?.antiAirInvuln && def.moveFrame >= a.antiAirInvuln[0] && def.moveFrame <= a.antiAirInvuln[1]) return true;
  }
  return false;
}

function blocks(def: Fighter, height: AttackDef['height']): boolean {
  if (height === 'throw') return false;
  const walkingBack = def.phase === 'move' && def.move !== null && MOVES[def.move].kind === 'movement' && Boolean((MOVES[def.move] as { guards?: boolean }).guards);
  const guarding = def.phase === 'idle' || def.phase === 'block' || def.phase === 'blockstun' || walkingBack;
  if (!guarding || isAirborne(def)) return false;
  return def.guard === 'low' ? height === 'low' : height === 'high' || height === 'overhead';
}

function throwable(def: Fighter, tick: number): boolean {
  if (isAirborne(def) || tick < def.throwSafeUntil) return false;
  return def.phase === 'idle' || def.phase === 'block' || def.phase === 'move' || def.phase === 'recovery';
}

type Contact = { i: Side; atk: MoveId; d: AttackDef; result: 'hit' | 'block' | 'armor' };

function checkContact(s: GameState, i: Side): Contact | null {
  const att = s.fighters[i];
  const def = s.fighters[(1 - i) as Side];
  if (att.phase !== 'active' || att.hasHit || !att.atk) return null;
  const d = attackDef(att.atk)!;
  if (gap(s) > d.range) return null;
  if (invulnerable(def, att)) return null;
  if (isAirborne(def) && (d.height === 'low' || d.height === 'throw')) return null;
  if (d.height === 'throw' && !throwable(def, s.tick)) return null;
  if (blocks(def, d.height)) return { i, atk: att.atk, d, result: 'block' };
  const defAtk = def.atk ? attackDef(def.atk) : null;
  if (defAtk?.armor && !def.armorUsed && def.phase === 'startup') return { i, atk: att.atk, d, result: 'armor' };
  return { i, atk: att.atk, d, result: 'hit' };
}

function applyContact(s: GameState, c: Contact, events: GameEvent[]): void {
  const att = s.fighters[c.i];
  const j = (1 - c.i) as Side;
  const def = s.fighters[j];
  const away = facing(c.i);
  const cx = Math.round((att.x + def.x) / 2);
  const cy = Math.max(att.y, def.y) + (c.d.height === 'low' ? 250 : 1300);
  att.hasHit = true;
  if (c.result === 'block') {
    // Chip: a quarter of a blocked strike still gets through.
    const chip = Math.floor(c.d.dmg / CHIP_DIVISOR);
    def.hp = Math.max(0, def.hp - chip);
    enter(def, 'blockstun', BLOCKSTUN_BASE + Math.floor(c.d.dmg / 2), s.tick);
    def.push = away * 250;
    att.meter = Math.min(MAX_METER, att.meter + Math.floor(c.d.dmg / 2));
    s.hitstop = Math.max(s.hitstop, 3);
    events.push({ kind: 'block', tick: s.tick, f: c.i, move: c.atk, dmg: c.d.dmg, chip, x: cx, y: cy });
    pushHistory(s, { tick: s.tick, f: c.i, move: c.atk, result: 'blocked', dmg: chip });
    if (def.hp === 0) {
      def.atk = null;
      def.move = null;
      enter(def, 'knockdown', KNOCKDOWN_FRAMES, s.tick);
    }
    return;
  }
  def.hp = Math.max(0, def.hp - c.d.dmg);
  att.meter = Math.min(MAX_METER, att.meter + c.d.dmg);
  def.meter = Math.min(MAX_METER, def.meter + Math.floor(c.d.dmg / 2));
  if (c.result === 'armor') {
    def.armorUsed = true;
    s.hitstop = Math.max(s.hitstop, 4);
    events.push({ kind: 'armor', tick: s.tick, f: c.i, move: c.atk, dmg: c.d.dmg, x: cx, y: cy });
    pushHistory(s, { tick: s.tick, f: c.i, move: c.atk, result: 'armored', dmg: c.d.dmg });
    return;
  }
  att.landed = true;
  const knockdown = Boolean(c.d.knockdown) || isAirborne(def) || def.hp === 0;
  // A hit interrupts whatever the defender was doing.
  def.atk = null;
  def.move = null;
  def.moveFrame = 0;
  if (knockdown) {
    enter(def, 'knockdown', KNOCKDOWN_FRAMES, s.tick);
    def.push = away * (c.d.height === 'throw' ? 900 : 500);
  } else {
    enter(def, 'hitstun', HITSTUN_BASE + c.d.dmg, s.tick);
    // A chain starter pushes only a little, so the follow-up is guaranteed to reach.
    def.push = away * (c.d.chainTo ? 80 : 350);
  }
  s.hitstop = Math.max(s.hitstop, Math.min(8, 3 + Math.floor(c.d.dmg / 4)));
  events.push({ kind: 'hit', tick: s.tick, f: c.i, move: c.atk, dmg: c.d.dmg, knockdown, x: cx, y: cy });
  pushHistory(s, { tick: s.tick, f: c.i, move: c.atk, result: 'hit', dmg: c.d.dmg });
}

function endRound(s: GameState, winner: Side | null, reason: 'ko' | 'time', events: GameEvent[]): void {
  const result: RoundResult = { n: s.round.n, winner, reason, hp: [s.fighters[0].hp, s.fighters[1].hp], tick: s.tick };
  s.results.push(result);
  if (winner !== null) s.wins[winner]++;
  s.round.phase = 'outro';
  s.round.left = reason === 'ko' ? KO_OUTRO_TICKS : TIME_OUTRO_TICKS;
  events.push({ kind: 'round_end', tick: s.tick, result });
}

/**
 * Advance the game by one tick, applying `inputs` for fighters that are actionable. Mutates `s`.
 * Inputs for fighters that cannot act, or moves that are not legal, are ignored.
 */
export function step(s: GameState, inputs: Inputs = [null, null]): GameEvent[] {
  const events: GameEvent[] = [];
  if (s.round.phase === 'over') return events;

  if (s.round.phase === 'intro') {
    s.round.left--;
    if (s.round.left <= 0) {
      s.round.phase = 'fight';
      events.push({ kind: 'round_start', tick: s.tick, n: s.round.n });
    }
    s.tick++;
    return events;
  }

  if (s.hitstop > 0) {
    s.hitstop--;
    s.tick++;
    return events;
  }

  if (s.round.phase === 'fight') {
    for (const i of [0, 1] as const) {
      const m = inputs[i];
      if (m && legalMoves(s, i).includes(m)) startMove(s, i, m, events);
    }
  }

  advance(s, 0, events);
  advance(s, 1, events);
  clampPositions(s);

  if (s.round.phase === 'fight') {
    const c0 = checkContact(s, 0);
    const c1 = checkContact(s, 1);
    if (c0) applyContact(s, c0, events);
    if (c1) applyContact(s, c1, events);
    if (s.rules.passivity) passivity(s, events);

    const [a, b] = s.fighters;
    if (a.hp === 0 || b.hp === 0) {
      for (const i of [0, 1] as const) {
        const f = s.fighters[i];
        if (f.hp === 0) {
          f.atk = null;
          f.move = null;
          enter(f, 'ko', 0, s.tick);
          events.push({ kind: 'ko', tick: s.tick, f: i });
        }
      }
      endRound(s, a.hp === 0 && b.hp === 0 ? null : a.hp === 0 ? 1 : 0, 'ko', events);
    } else {
      s.round.timer--;
      if (s.round.timer <= 0) endRound(s, a.hp === b.hp ? null : a.hp > b.hp ? 0 : 1, 'time', events);
    }
  } else if (s.round.phase === 'outro') {
    s.round.left--;
    if (s.round.left <= 0) {
      const played = s.results.length;
      const last = s.results[played - 1];
      // A round that times out with no damage at all is a standoff: nobody will engage, so the match ends.
      const standoff = !s.rules.passivity && last?.reason === 'time' && last.hp[0] === MAX_HP && last.hp[1] === MAX_HP;
      if (s.wins[0] >= WINS_NEEDED || s.wins[1] >= WINS_NEEDED || played >= MAX_ROUNDS || standoff) {
        s.round.phase = 'over';
        s.winner = s.wins[0] === s.wins[1] ? null : s.wins[0] > s.wins[1] ? 0 : 1;
        events.push({ kind: 'match_end', tick: s.tick, winner: s.winner });
      } else {
        s.round = { n: s.round.n + 1, phase: 'intro', left: INTRO_TICKS, timer: ROUND_TICKS };
        s.hitstop = 0;
        s.history = [];
        placeFighters(s, [s.fighters[0].meter, s.fighters[1].meter]);
      }
    }
  }

  s.tick++;
  return events;
}

/** How far an attack can connect from, including travel (jump kick arc, special dash). */
export function attackReach(m: MoveId): number {
  const d = attackDef(m);
  if (!d) return 0;
  return d.range + (d.dash ?? 0) + (d.airborne ? Math.round(d.airborne.dx * 0.6) : 0);
}

const ENGAGING = new Set<MoveId>(['walk_forward', 'dash_forward']);

/** Passivity: count free, unpressured, non-engaging time; warn, then bleed. */
function passivity(s: GameState, events: GameEvent[]): void {
  for (const i of [0, 1] as const) {
    const f = s.fighters[i];
    const opp = s.fighters[(1 - i) as Side];
    const started = events.some((e) => e.kind === 'start' && e.f === i && (attackDef(e.move) !== null || ENGAGING.has(e.move)));
    // Any contact, either way, counts as engagement for both fighters.
    const touched = events.some((e) => e.kind === 'hit' || e.kind === 'block' || e.kind === 'armor');
    const underFire = opp.atk !== null && (opp.phase === 'startup' || opp.phase === 'active') && gap(s) <= attackReach(opp.atk);
    const busy = f.phase === 'blockstun' || f.phase === 'hitstun' || f.phase === 'knockdown' || f.phase === 'getup' || f.phase === 'ko';
    const attacking = f.atk !== null || (f.phase === 'move' && f.move !== null && ENGAGING.has(f.move));
    if (started || touched || attacking) {
      f.passive = 0;
      continue;
    }
    if (busy || underFire) continue;
    f.passive++;
    if (f.passive >= PASSIVE_BLEED_TICKS && (f.passive - PASSIVE_BLEED_TICKS) % TICK_HZ === 0 && f.hp > 1) {
      f.hp -= 1;
      opp.meter = Math.min(MAX_METER, opp.meter + 2);
      events.push({ kind: 'penalty', tick: s.tick, f: i, dmg: 1 });
    }
  }
}

/** FNV-1a over the canonical JSON of the state. Used for replay checkpoints. */
export function hashState(s: GameState): number {
  // Without the optional rules the hash ignores their fields, so replays from before they existed match.
  const plain = !s.rules.passivity;
  const text = JSON.stringify(s, (k, v) => (plain && (k === 'rules' || k === 'passive') ? undefined : v));
  let h = 0x811c9dc5;
  for (let k = 0; k < text.length; k++) {
    h ^= text.charCodeAt(k);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Run a copy of the state forward with no new inputs until fighter `i` can act (or `maxTicks` pass).
 * The opponent, if it becomes actionable meanwhile, just keeps its guard. Used to ask questions early.
 */
export function predictActionable(s: GameState, i: Side, maxTicks = 120): { state: GameState; ticks: number } | null {
  const c = clone(s);
  for (let t = 0; t <= maxTicks; t++) {
    if (isActionable(c, i)) return { state: c, ticks: t };
    if (c.round.phase !== 'fight' && c.round.phase !== 'intro') return null;
    step(c);
  }
  return null;
}
