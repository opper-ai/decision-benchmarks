// A read-only TableDriver over a recorded Sit & Go: share links and the curated replays play through it. Every card is
// face up (a spectator's view of a finished game), step() plays the next recorded move with its metadata (table talk,
// mood, probabilities, reasoning), and act() is refused. Beyond the interface it can jump to any hand and says where
// it is, for the replay's controls.
import type { Action } from '../shared/engine.ts';
import { verifyRecording, type RecordedAction, type Recording } from '../shared/recording.ts';
import { actSitAndGo, newSitAndGo, nextHand, stacksOf, type SitAndGo } from '../shared/sitngo.ts';
import { finishedHandOf, snapshotOf } from '../shared/table.ts';
import type { ActionMeta, Review, ReviewHand, StepResult, TableDriver, TableSnapshot } from './driver.ts';

export class ReplayDriver implements TableDriver {
  readonly recording: Recording;
  private g: SitAndGo;
  /** The hand in play (from 0) and the next move in it. */
  private hand = 0;
  private move = 0;
  private finished: ReviewHand[] = [];

  /** Checks the recording (verifyRecording) and throws if it does not replay. */
  constructor(recording: Recording) {
    if (recording.mode !== 'sitngo' || !recording.sitngo) throw new Error('only a Sit & Go replays here');
    const verdict = verifyRecording(recording);
    if (!verdict.ok) throw new Error(verdict.error);
    this.recording = recording;
    this.g = this.fresh();
  }

  private fresh(): SitAndGo {
    const c = this.recording.sitngo!;
    return newSitAndGo({ seats: this.recording.players.length, key: c.key, startingStack: c.startingStack });
  }

  /** How many hands the game has. */
  get hands(): number {
    return this.recording.hands.length;
  }

  /** Where the replay is: the hand (from 1) and the move in it (from 0). */
  position(): { hand: number; move: number; moves: number } {
    return { hand: this.hand + 1, move: this.move, moves: this.recording.hands[this.hand]!.actions.length };
  }

  async start(): Promise<TableSnapshot> {
    this.g = this.fresh();
    this.hand = 0;
    this.move = 0;
    this.finished = [];
    this.archive();
    return this.snapshot();
  }

  async act(_action: Action): Promise<StepResult> {
    throw new Error('a replay plays itself');
  }

  async step(): Promise<StepResult> {
    const actions = this.recording.hands[this.hand]!.actions;
    const x = actions[this.move];
    if (!x || this.g.hand.toAct === null) throw new Error('the hand is over');
    this.g = actSitAndGo(this.g, x.key !== undefined ? { key: x.key } : { kind: 'raise', to: x.to! });
    this.move++;
    this.archive();
    return { seat: x.seat, key: x.key ?? null, meta: metaOf(x), snapshot: this.snapshot() };
  }

  async nextHand(): Promise<TableSnapshot> {
    if (this.hand + 1 >= this.recording.hands.length) throw new Error('the game is over');
    this.g = nextHand(this.g);
    this.hand++;
    this.move = 0;
    this.archive();
    return this.snapshot();
  }

  /** Jumps to the start of hand `n` (from 1), the hands before it played out at once. */
  async jumpTo(n: number): Promise<TableSnapshot> {
    const target = Math.max(1, Math.min(this.hands, Math.floor(n))) - 1;
    if (target < this.hand || (target === this.hand && this.move > 0)) await this.start();
    while (this.hand < target) {
      while (this.g.hand.toAct !== null) await this.step();
      await this.nextHand();
    }
    return this.snapshot();
  }

  async review(): Promise<Review> {
    return { players: structuredClone(this.recording.players), hands: structuredClone(this.finished), recording: this.g.over ? structuredClone(this.recording) : null };
  }

  private archive(): void {
    if (this.g.hand.street !== 'done' || this.finished.some((h) => h.hand === this.hand + 1)) return;
    // The hand's table talk too (the player's lines in a recording), so the review shows it where it was said.
    const recorded = this.recording.hands[this.hand]!;
    this.finished.push(finishedHandOf(this.g, recorded.actions, recorded.talk ?? []));
  }

  /** Every card face up, as a spectator sees a finished game; no time banks (the moves are already made). */
  snapshot(): TableSnapshot {
    return snapshotOf(this.g, null, () => null);
  }

  /** Chips per seat now. */
  stacks(): number[] {
    return stacksOf(this.g);
  }
}

/** What a recorded move brings to the table: its talk, face, tell and reasoning (a replay shows everything). */
function metaOf(x: RecordedAction): ActionMeta {
  return {
    by: x.by,
    latencyMs: x.latencyMs ?? 0,
    ...(x.say !== undefined ? { say: x.say } : {}),
    ...(x.mood !== undefined ? { mood: x.mood } : {}),
    ...(x.probabilities !== undefined ? { probabilities: x.probabilities } : {}),
    ...(x.reasoning !== undefined ? { reasoning: x.reasoning } : {}),
  };
}
