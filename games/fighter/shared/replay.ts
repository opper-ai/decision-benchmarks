import type { Answer } from './adapter.ts';
import { COMPATIBLE_VERSIONS, ENGINE_VERSION, clone, hashState, newGame, step, type GameEvent, type GameState, type Inputs, type RoundResult, type Rules, type Side } from './engine/engine.ts';
import type { MoveId } from './engine/moves.ts';
import type { Question, Track } from './question.ts';

export type FallbackReason = 'timeout' | 'error' | 'invalid' | 'illegal';
export type Outcome = 'hit' | 'traded' | 'blocked' | 'whiffed' | 'punished' | 'defended' | 'neutral';

export interface FighterMeta {
  model: string;
  label: string;
  kind: string;
  color: string;
  /** How it played: through this site's server, with a key pasted in the browser, a custom endpoint, or a person at the keyboard. */
  via?: 'server' | 'key' | 'custom' | 'human';
  /** A custom endpoint's host. */
  host?: string;
}

export interface Decision {
  fighter: Side;
  askedTick: number;
  /** Tick of the state the question described (later than askedTick when asked early). */
  questionTick: number;
  /** The only thing wall-clock timing affects. */
  appliedTick: number;
  move: MoveId;
  question: Question;
  answer: Answer | null;
  fallback: FallbackReason | null;
  latencyMs: number;
  /** Tick at which the answer (or its failure) arrived. */
  arrivedTick?: number;
  /** First tick the fighter was free again after this move (closes the outcome window). */
  doneTick?: number;
  error?: string;
  outcome?: Outcome;
  dealt?: number;
  taken?: number;
}

export interface Replay {
  format: 1;
  engineVersion: string;
  seed: number;
  mode: 'realtime' | 'paused';
  /** Absent in replays from before tracks existed (they were assisted-like). */
  track?: Track;
  /** Optional rules the match was played with. */
  rules?: Rules;
  deadlineMs: number;
  fighters: [FighterMeta, FighterMeta];
  createdAt: string;
  ticks: number;
  costUsd: number;
  decisions: Decision[];
  cancellations: { fighter: Side; askedTick: number; cancelledTick: number }[];
  checkpoints: { tick: number; hash: number }[];
  result: { winner: Side | null; rounds: RoundResult[] };
}

/** What each decision led to, from the events between it and the same fighter's next decision. */
export function annotateOutcomes(decisions: Decision[], events: GameEvent[], endTick: number): Decision[] {
  const out = decisions.map((d) => ({ ...d }));
  for (const side of [0, 1] as const) {
    const mine = out.filter((d) => d.fighter === side);
    mine.forEach((d, k) => {
      // The window ends when the fighter is free again, so time spent waiting for the next answer
      // is not credited to this decision.
      const next = k + 1 < mine.length ? mine[k + 1].appliedTick : endTick + 1;
      const until = d.doneTick !== undefined ? Math.min(d.doneTick, next) : next;
      const window = events.filter((e) => e.tick >= d.appliedTick && e.tick < until);
      let dealt = 0;
      let taken = 0;
      let blockedMine = false;
      let defended = false;
      let whiffed = false;
      let chipDealt = 0;
      let chipTaken = 0;
      for (const e of window) {
        if (e.kind === 'hit' || e.kind === 'armor') {
          if (e.f === side) dealt += e.dmg;
          else taken += e.dmg;
        } else if (e.kind === 'block') {
          if (e.f === side) {
            blockedMine = true;
            chipDealt += e.chip;
          } else {
            defended = true;
            chipTaken += e.chip;
          }
        } else if (e.kind === 'whiff' && e.f === side) {
          whiffed = true;
        }
      }
      d.dealt = dealt + chipDealt;
      d.taken = taken + chipTaken;
      // Classified by clean hits; chip only changes the HP totals.
      d.outcome =
        dealt > 0 && taken > 0 ? 'traded' : dealt > 0 ? 'hit' : taken > 0 ? 'punished' : blockedMine ? 'blocked' : whiffed ? 'whiffed' : defended ? 'defended' : 'neutral';
    });
  }
  return out;
}

/** Did the decision win its exchange? Null when nothing happened (excluded from calibration). */
export function won(d: Decision): boolean | null {
  switch (d.outcome) {
    case 'hit':
    case 'defended':
      return true;
    case 'traded':
      return (d.dealt ?? 0) > (d.taken ?? 0);
    case 'blocked':
    case 'whiffed':
    case 'punished':
      return false;
    default:
      return null;
  }
}

export function inputsByTick(r: Replay): Map<number, Inputs> {
  const m = new Map<number, Inputs>();
  for (const d of r.decisions) {
    const cur = m.get(d.appliedTick) ?? [null, null];
    cur[d.fighter] = d.move;
    m.set(d.appliedTick, cur);
  }
  return m;
}

const SNAPSHOT_EVERY = 60;

/**
 * Random access over a replay: re-simulates once, keeps a snapshot every second, and steps forward
 * from the nearest one on seek. Checks every checkpoint hash on the way.
 */
export class ReplayPlayer {
  readonly snapshots: GameState[] = [];
  readonly events: GameEvent[] = [];
  readonly diverged: number | null;
  readonly endTick: number;
  private readonly inputs: Map<number, Inputs>;

  constructor(readonly replay: Replay) {
    if (!COMPATIBLE_VERSIONS.includes(replay.engineVersion)) throw new Error(`replay needs engine v${replay.engineVersion}, this is v${ENGINE_VERSION}`);
    this.inputs = inputsByTick(replay);
    const checks = new Map(replay.checkpoints.map((c) => [c.tick, c.hash]));
    const s = newGame(replay.seed, replay.rules);
    let diverged: number | null = null;
    while (s.round.phase !== 'over' && s.tick < replay.ticks + 1) {
      if (s.tick % SNAPSHOT_EVERY === 0) this.snapshots.push(clone(s));
      for (const e of step(s, this.inputs.get(s.tick))) this.events.push(e);
      const want = checks.get(s.tick);
      if (want !== undefined && diverged === null && hashState(s) !== want) diverged = s.tick;
    }
    // A replay that ends early or late has diverged too.
    if (diverged === null && (s.tick !== replay.ticks || replay.checkpoints.some((c) => c.tick > s.tick))) diverged = s.tick;
    this.endTick = s.tick;
    this.diverged = diverged;
  }

  /** The state at the start of tick `t` (before that tick's inputs). */
  stateAt(t: number): GameState {
    const k = Math.max(0, Math.min(this.snapshots.length - 1, Math.floor(t / SNAPSHOT_EVERY)));
    const s = clone(this.snapshots[k]);
    while (s.tick < t && s.round.phase !== 'over') step(s, this.inputs.get(s.tick));
    return s;
  }

  /** Step a state forward one tick using the replay's inputs. Mutates. */
  advance(s: GameState): GameEvent[] {
    return step(s, this.inputs.get(s.tick));
  }
}

export async function encodeReplay(r: Replay): Promise<Uint8Array> {
  const stream = new Blob([JSON.stringify(r)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodeReplay(bytes: Uint8Array | ArrayBuffer): Promise<Replay> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text()) as Replay;
}
