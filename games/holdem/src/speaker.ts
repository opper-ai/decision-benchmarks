// The table's speaker: the models' lines of talk, spoken one at a time in the order they were said (voice.ts wires it to
// the page: the speak route or a replay's pre-rendered files, played by an audio element). No DOM here, so the tests
// run it in node.
//
// - A line starts loading as soon as it is said, so the next one is ready when the one before it ends.
// - A line not started within MAX_LAG_MS of being said is dropped, loaded or not: speech never trails far behind the
//   table, and a slow or hung load holds up nothing.
// - Nothing is loaded or played while `enabled()` is false (the Voice switch off, or a resumed table catching up on its
//   hand): a line said then is never spoken, and no speak call is made for it.
// - clear() stops the line playing and forgets the rest (leaving, a new table, the page hidden, Voice switched off).
// - The table waits for the speaker (settled): before the next model's move is shown, the lines said so far finish,
//   for at most a cap, so a line is heard with the move it came with and a long one never stalls the table.
// - Rates (voiceRate, the pitch kept): 1.2× at 1× and 2× (Grok's delivery is unhurried, and the table waits for it);
//   1.3× and 1.4× at 4× and 8×. A chat table's talk comes at the models' own pace (seconds a decision) whatever the
//   speed, and 4× is where a player who went out watches the rest, so skipping talk there would silence the table just
//   when there is time to listen; a faster delivery, with the stale drop, keeps the voices in step instead.

/** How long a line may wait to start before it is dropped. */
export const MAX_LAG_MS = 4000;

/** How long the table waits at most for the lines said so far to finish before it shows the next move. */
export const SETTLE_CAP_MS = 3500;

/** The playback rate at a watch speed (the player keeps the pitch). */
export function voiceRate(speed: number): number {
  return speed >= 8 ? 1.4 : speed >= 4 ? 1.3 : 1.2;
}

/** A line playing: done when it ends (or is stopped). */
export interface Playing {
  done: Promise<void>;
  stop(): void;
}

export interface SpeakerDeps<L, A> {
  now(): number;
  /** The line's audio, or null when it can't be had; `signal` aborts when the line is dropped. */
  load(line: L, signal: AbortSignal): Promise<A | null>;
  /** Plays loaded audio at a rate; null when it can't play. A line the browser refuses to play ends at once (done). */
  play(audio: A, rate: number): Playing | null;
  /** Voice on and not hushed: read when a line is said and again when it would start. */
  enabled(): boolean;
  /** The watch speed now (1 when playing). */
  speed?(): number;
  maxLagMs?: number;
}

interface Queued<A> {
  said: number;
  audio: Promise<A | null>;
  ac: AbortController;
}

export class Speaker<L, A> {
  private queue: Queued<A>[] = [];
  private playing: Playing | null = null;
  private running = false;
  /** Bumped by clear(): a loop from before it stops. */
  private generation = 0;
  private readonly d: SpeakerDeps<L, A>;
  /** Told when the speaker has nothing left to say (settled). */
  private idlers: (() => void)[] = [];

  constructor(deps: SpeakerDeps<L, A>) {
    this.d = deps;
  }

  /** Lines waiting (not yet playing). */
  get waiting(): number {
    return this.queue.length;
  }

  get speaking(): boolean {
    return this.playing !== null;
  }

  /** A line was said at the table: speak it after the ones before it, if voice is on. */
  say(line: L): void {
    if (!this.d.enabled()) return;
    const ac = new AbortController();
    const audio = this.d.load(line, ac.signal).catch(() => null);
    this.queue.push({ said: this.d.now(), audio, ac });
    if (!this.running) void this.run();
  }

  /** Nothing playing, loading or waiting. */
  get idle(): boolean {
    return !this.running && !this.playing && !this.queue.length;
  }

  /**
   * Resolves once every line said so far has been spoken (or dropped, or failed), or after `capMs`, whichever is first;
   * at once when there is nothing to say (Voice off). The table awaits it before showing the next model's move.
   */
  settled(capMs = SETTLE_CAP_MS): Promise<void> {
    if (this.idle) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.idlers = this.idlers.filter((f) => f !== done);
        resolve();
      };
      const timer = setTimeout(done, capMs);
      this.idlers.push(done);
    });
  }

  private wake(): void {
    if (this.idle) for (const f of [...this.idlers]) f();
  }

  /** Stops the line playing and drops every line waiting. */
  clear(): void {
    this.generation++;
    // The loop from before stops at its next step; a line said from now on starts a new one.
    this.running = false;
    for (const q of this.queue.splice(0)) q.ac.abort();
    this.playing?.stop();
    this.playing = null;
    this.wake();
  }

  private async run(): Promise<void> {
    this.running = true;
    const gen = this.generation;
    const maxLag = this.d.maxLagMs ?? MAX_LAG_MS;
    try {
      while (gen === this.generation && this.queue.length) {
        const q = this.queue[0]!;
        const left = q.said + maxLag - this.d.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<'late'>((resolve) => (timer = setTimeout(() => resolve('late'), Math.max(0, left))));
        const audio = left > 0 ? await Promise.race([q.audio, late]) : 'late';
        clearTimeout(timer);
        if (gen !== this.generation) return;
        this.queue.shift();
        if (audio === 'late' || audio === null || this.d.now() - q.said > maxLag || !this.d.enabled()) {
          q.ac.abort();
          continue;
        }
        const p = this.d.play(audio, voiceRate(this.d.speed?.() ?? 1));
        if (!p) continue;
        this.playing = p;
        await p.done;
        if (this.playing === p) this.playing = null;
      }
    } finally {
      // After a clear() the flag is a newer loop's.
      if (gen === this.generation) {
        this.running = false;
        this.wake();
      }
    }
  }
}
