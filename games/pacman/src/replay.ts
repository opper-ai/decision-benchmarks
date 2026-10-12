import type { SchedulerEvent } from './scheduler';
import { createGame, step, type Controls, type GameState, type PacmanControl } from './sim';
import type { Dir } from './types';

type CallEvent = Extract<SchedulerEvent, { type: 'call' }>;
/** A scheduler event as stored in a recording: call events drop traceId, which points at the recorder's own Opper traces. */
export type RecordedEvent = Exclude<SchedulerEvent, CallEvent> | Omit<CallEvent, 'traceId'>;

export interface Recording {
  version: 1;
  recordedAt: string;
  model: string;
  /** Each frame's simulation step in seconds, rounded with roundDt. */
  frames: number[];
  /**
   * Every non-null direction Controls.decide returned: [frame, decision key, direction], and in a player's game
   * where it came from: "<model>~<server signature>" for a model's answer, "f" for the backup rule.
   */
  decisions: [number, string, Dir, string?][];
  /** Scheduler events for the panel: [frame, event]. */
  events: [number, RecordedEvent][];
  final: { score: number; lives: number; level: number; frames: number };
  /** A player's game: who steers Pac-Man and whether models play the ghosts. Absent: an AI playing Pac-Man against the classic ghosts. */
  setup?: { pacmanControl: PacmanControl; ghostsByAI: boolean; lineup?: Record<string, string> };
  /** A player's game steps at a fixed rate: then `frames` is empty and the game is `steps` steps of `fixedStep`. */
  fixedStep?: number;
  steps?: number;
  /** The player's steering whenever it changed: [frame, direction or null], set before that frame's step. */
  keys?: [number, Dir | null][];
}

/** Steps are stored to 0.1 ms; recording and replay both step with the rounded value. */
export const roundDt = (dt: number): number => Math.round(dt * 10_000) / 10_000;

export class Recorder {
  readonly frames: number[] = [];
  readonly decisions: [number, string, Dir, string?][] = [];
  readonly events: [number, RecordedEvent][] = [];
  readonly keys: [number, Dir | null][] = [];
  private lastKey: Dir | null = null;

  /** Before a frame's step: notes the player's steering if it changed since the end of the last step. */
  key(frame: number, dir: Dir | null): void {
    if (dir !== this.lastKey) this.keys.push([frame, dir]);
    this.lastKey = dir;
  }

  /** After a frame's step: the game may have cleared the steering itself (a lost life does). */
  settle(dir: Dir | null): void {
    this.lastKey = dir;
  }

  /** Keeps a scheduler event for the panel, without its trace id. */
  record(frame: number, e: SchedulerEvent): void {
    if (e.type === 'call') {
      const { traceId: _omit, ...rest } = e;
      this.events.push([frame, rest]);
    } else this.events.push([frame, e]);
  }

  wrap(ctl: Controls, frame: () => number): Controls {
    return {
      decide: (point, state) => {
        const choice = ctl.decide(point, state);
        if (choice !== null) this.decisions.push([frame(), point.key, choice]);
        return choice;
      },
    };
  }

  finish(state: GameState, model: string, setup?: Recording['setup']): Recording {
    return {
      ...(setup ? { setup, keys: this.keys } : {}),
      version: 1,
      recordedAt: new Date().toISOString(),
      model,
      frames: this.frames,
      decisions: this.decisions,
      events: this.events,
      final: { score: state.score, lives: state.lives, level: state.level, frames: this.frames.length },
    };
  }
}

/** Re-runs a recorded game: same steps, same answers, so the same game. */
export class Replay {
  readonly state: GameState;
  frame = 0;
  private readonly rec: Recording;
  private readonly keys = new Map<number, Dir | null>();
  /** Per frame+key, the answers decide() returned, in call order (a key can be asked several times per frame). */
  private readonly choices = new Map<string, Dir[]>();
  private readonly eventsByFrame = new Map<number, SchedulerEvent[]>();

  constructor(rec: Recording) {
    this.rec = rec;
    this.state = createGame(rec.setup ?? {});
    for (const [f, dir] of rec.keys ?? []) this.keys.set(f, dir);
    for (const [f, key, dir] of rec.decisions) {
      const k = `${f}|${key}`;
      const list = this.choices.get(k);
      if (list) list.push(dir);
      else this.choices.set(k, [dir]);
    }
    for (const [f, e] of rec.events) {
      const event: SchedulerEvent = e.type === 'call' ? { ...e, traceId: null } : e;
      this.eventsByFrame.set(f, [...(this.eventsByFrame.get(f) ?? []), event]);
    }
  }

  get done(): boolean {
    return this.frame >= this.length;
  }

  private get length(): number {
    return this.rec.frames.length || (this.rec.steps ?? 0);
  }

  /** Advances one recorded frame and returns the panel events recorded for it; once done, does nothing. */
  stepFrame(): SchedulerEvent[] {
    if (this.done) return [];
    const f = this.frame;
    if (this.keys.has(f)) this.state.keyDir = this.keys.get(f)!;
    step(this.state, this.rec.frames[f] ?? this.rec.fixedStep ?? 0, { decide: (p) => this.choices.get(`${f}|${p.key}`)?.shift() ?? null });
    this.frame += 1;
    return this.eventsByFrame.get(f) ?? [];
  }
}
