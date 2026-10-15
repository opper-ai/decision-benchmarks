// A TableDriver that runs the engine in the browser, with the phase-1 bots standing in for every AI seat: practice
// play (?practice in a dev build) and tests; the page plays the service's table (RemoteDriver) otherwise. Model seats get what a real model would send, made up:
// a short think, table talk and a mood (chat models), or probabilities for the tell meter (decision models), and a
// line of "reasoning" for the review. Bot seats are just bots.
import { botDecide, chenScore, isBotName, type BotName } from '../shared/bots.ts';
import { parseCard, rankOf, type Card } from '../shared/cards.ts';
import { observe, type Action, type Observation, type OptionKey } from '../shared/engine.ts';
import { evaluate } from '../shared/evaluator.ts';
import { CHAT_TIMEOUT_MS, DECISION_TIMEOUT_MS } from '../shared/models.ts';
import { cleanTalk } from '../shared/questions.ts';
import type { Mood, Player, RecordedAction, TalkLine } from '../shared/recording.ts';
import { deriveSeed, keyFromSeed, mulberry32 } from '../shared/rng.ts';
import { actSitAndGo, MAX_SEATS, MIN_SEATS, newSitAndGo, nextHand, type SitAndGo } from '../shared/sitngo.ts';
import { finishedHandOf, recordingOf, snapshotOf } from '../shared/table.ts';
import type { ActionMeta, Review, ReviewHand, SeatConfig, StepResult, TableConfig, TableDriver, TableSnapshot } from './driver.ts';
import { modelById } from './roster.ts';

/** The time banks the service gives: 20 s a decision for chat models, 2.5 s for decision models (shared/models.ts). */
export const CHAT_TIME_BANK_MS = CHAT_TIMEOUT_MS;
export const DECISION_TIME_BANK_MS = DECISION_TIMEOUT_MS;

export interface LocalDriverOptions {
  /** Multiplies every think time: 1 is lifelike, 0 answers at once (tests), 0.25 is a fast watch. */
  thinkScale?: number;
  /** Waits `ms`; rejects when the signal aborts. Tests may pass one that returns at once. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

type Seat = SeatConfig & { standIn: BotName | null; style: 'decision' | 'chat' | null };

/** A random table key from the browser's cryptographic source (Node's too, in tests). */
const randomKey = (): string => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');

const abortError = () => new DOMException('The step was cancelled', 'AbortError');

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** What a stand-in says, by its style of play and what it just did. Short, as the plan caps table talk at 90. */
const LINES: Record<'rock' | 'station' | 'maniac' | 'random', Record<'fold' | 'check' | 'call' | 'raise' | 'allin', string[]>> = {
  rock: {
    fold: ['Not this one.', 'I can wait.', 'Patience is a strategy.', 'Too rich for me.'],
    check: ['Check.', 'Your move.', 'Let us see a card.'],
    call: ['I will see that.', 'Fine. Call.', 'You might be telling the truth.'],
    raise: ['I have a hand. Believe it.', 'Raise. I do not bluff.', 'This one I like.'],
    allin: ['Everything. I mean it.', 'All of it, and it is not a bluff.'],
  },
  station: {
    fold: ['Okay, okay, you win this one.', 'I will fold. This time.', 'Ugh. Fine.'],
    check: ['Check, check.', 'Sure, free card.', 'Nothing from me.'],
    call: ['I am curious. Call.', 'Can not fold that.', 'Let us keep it friendly. Call.', 'I will just see it.'],
    raise: ['Oh, I like this one.', 'A little raise, why not.'],
    allin: ['Well, I am in. All of it.', 'Let us gamble!'],
  },
  maniac: {
    fold: ['Lucky you.', 'Enjoy it while it lasts.', 'Next hand is mine.'],
    check: ['I will let you hang yourself.', 'Check. For now.', 'Go on then.'],
    call: ['Is that all?', 'Call. I am just warming up.', 'Cute bet.'],
    raise: ['More. Always more.', 'Pot. Try me.', 'Raise. Do you feel brave?', 'You are going to fold.'],
    allin: ['All in. Your move, hero.', 'Shove! Find out.', 'Every chip. Call if you dare.'],
  },
  random: {
    fold: ['Fold.'],
    check: ['Check.'],
    call: ['Call.'],
    raise: ['Raise.'],
    allin: ['All in.'],
  },
};

type Verb = keyof (typeof LINES)['rock'];

const verbOf = (key: OptionKey): Verb => (key === 'fold' ? 'fold' : key === 'check' ? 'check' : key === 'call' ? 'call' : key === 'allin' ? 'allin' : 'raise');

/** Roughly how strong a seat's hand is, 0 to 1: the Chen score before the flop, the made hand after it. */
function strengthOf(o: Observation): number {
  const hole = o.holeCards.map(parseCard);
  if (hole.length < 2) return 0.5;
  if (!o.board.length) return Math.max(0, Math.min(1, chenScore(hole[0]!, hole[1]!) / 16));
  const cards: Card[] = [...hole, ...o.board.map(parseCard)];
  const category = evaluate(cards) >> 20;
  const kicker = Math.max(...hole.map(rankOf)) / 12;
  return Math.min(1, [0.12, 0.42, 0.62, 0.74, 0.82, 0.86, 0.92, 0.97, 1][category]! + 0.06 * kicker);
}

const HAND_WORDS = (o: Observation): string => {
  const s = strengthOf(o);
  if (!o.board.length) return s > 0.7 ? 'a premium starting hand' : s > 0.45 ? 'a playable hand' : 'not much';
  return s > 0.85 ? 'a monster' : s > 0.6 ? 'two pair or better' : s > 0.4 ? 'a pair' : 'air, really';
};

/** A face for an action: what the model chooses to project, so a weak raise may look confident. */
function moodFor(verb: Verb, strength: number, r: number): Mood {
  if (verb === 'fold') return r < 0.7 ? 'annoyed' : 'nervous';
  if (verb === 'check') return strength > 0.75 && r < 0.5 ? 'smug' : 'relaxed';
  if (verb === 'call') return strength > 0.6 ? 'relaxed' : r < 0.6 ? 'nervous' : 'relaxed';
  if (strength > 0.7) return r < 0.5 ? 'smug' : 'confident';
  return r < 0.65 ? 'confident' : 'nervous';
}

/** What a practice stand-in says back to your talk. */
const RETORTS: readonly string[] = ['Big words. Show me the cards.', 'Talk is cheap. Chips are not.', 'Noted. Still calling.', 'You sound nervous.', 'Bold. Let us see.', 'I have heard that before.'];

export class LocalDriver implements TableDriver {
  thinkScale: number;
  private sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private seats: Seat[] = [];
  private human: number | null = null;
  /** Watch mode: no human seat, so reasoning may come with each step. */
  private get watching(): boolean {
    return this.human === null;
  }
  /** Play mode, the human out of the game: they watch the rest as a spectator, reasoning and all (the snapshot says spectating). */
  private get humanOut(): boolean {
    return this.human !== null && this.game().places[this.human] !== null;
  }
  private g: SitAndGo | null = null;
  /** The stand-ins' coins (think time, talk, tells): from the config's seed, else at random. Not the deal. */
  private seed = 0;
  /** Actions per hand, in order. */
  private hands: RecordedAction[][] = [];
  private finished: ReviewHand[] = [];
  /** The player's latest table talk, waiting for a chat model to answer it (say()). */
  private heard: string | null = null;
  /** When the human's current turn began (for latencyMs). */
  private turnStart = 0;

  constructor(o: LocalDriverOptions = {}) {
    this.thinkScale = o.thinkScale ?? 1;
    this.sleep = o.sleep ?? defaultSleep;
  }

  async start(config: TableConfig): Promise<TableSnapshot> {
    const n = config.seats.length;
    if (n < MIN_SEATS || n > MAX_SEATS) throw new Error(`a table seats ${MIN_SEATS} to ${MAX_SEATS} players`);
    const humans = config.seats.flatMap((s, i) => (s.kind === 'human' ? [i] : []));
    if (humans.length > 1) throw new Error('one human at most');
    this.seats = config.seats.map((s) => {
      if (s.kind === 'bot') {
        if (!isBotName(s.id)) throw new Error(`${s.id} is not a bot`);
        return { ...s, standIn: s.id, style: null };
      }
      if (s.kind === 'model') {
        const m = modelById(s.id);
        return { ...s, standIn: m?.standIn ?? 'station', style: m?.style ?? 'chat' };
      }
      return { ...s, standIn: null, style: null };
    });
    this.human = humans[0] ?? null;
    this.seed = config.seed ?? Math.floor(Math.random() * 2 ** 31);
    // The deal: the config's key, else one made from its seed (tests), else a random one.
    const key = config.key ?? (config.seed !== undefined ? keyFromSeed(config.seed) : randomKey());
    this.g = newSitAndGo({ seats: n, key });
    this.hands = [[]];
    this.talk = [[]];
    this.finished = [];
    this.archive();
    this.turnStart = Date.now();
    return this.snapshot();
  }

  private game(): SitAndGo {
    if (!this.g) throw new Error('the table has not started');
    return this.g;
  }

  async act(action: Action): Promise<StepResult> {
    const g = this.game();
    const seat = g.hand.toAct;
    if (this.human === null || seat !== this.human) throw new Error('it is not your turn');
    this.deliver();
    const latencyMs = Math.max(0, Date.now() - this.turnStart);
    const next = actSitAndGo(g, action); // throws on an illegal action, leaving the table as it was
    const record: RecordedAction = 'key' in action ? { seat, key: action.key, by: 'human', latencyMs } : { seat, to: action.to, by: 'human', latencyMs };
    return this.played(next, record, { by: 'human', latencyMs });
  }

  async step(signal?: AbortSignal): Promise<StepResult> {
    const g = this.game();
    const seat = g.hand.toAct;
    if (seat === null) throw new Error('the hand is over');
    if (seat === this.human) throw new Error('it is the human’s turn');
    this.deliver();
    const who = this.seats[seat]!;
    const o = observe(g.hand, seat);
    const key = botDecide(who.standIn!, o);
    const actionIndex = this.hands.at(-1)!.length;
    let rng = deriveSeed(this.seed, g.handIndex, actionIndex, seat);
    const coin = () => {
      let r: number;
      [r, rng] = mulberry32(rng);
      return r;
    };
    const think = who.style === 'chat' ? 900 + coin() * 1700 : who.style === 'decision' ? 350 + coin() * 650 : 250 + coin() * 350;
    const started = Date.now();
    await this.sleep(Math.round(think * this.thinkScale), signal);
    if (this.g !== g) throw new Error('the table changed while the AI was thinking');
    const latencyMs = Math.max(0, Date.now() - started);
    const record: RecordedAction = { seat, key, by: who.kind === 'bot' ? 'bot' : 'answer' };
    const meta: ActionMeta = { by: record.by, latencyMs };
    if (who.kind === 'model') {
      record.latencyMs = latencyMs;
      const verb = verbOf(key);
      const strength = strengthOf(o);
      if (who.style === 'chat') {
        const lines = LINES[who.standIn!][verb];
        meta.mood = record.mood = moodFor(verb, strength, coin());
        // Your talk (say()): the next chat model to act may answer it, with a line of its own.
        const heard = this.heard;
        this.heard = null;
        if (heard && coin() < 0.6) meta.say = record.say = RETORTS[Math.floor(coin() * RETORTS.length)]!;
        else if (coin() < 0.7) meta.say = record.say = lines[Math.floor(coin() * lines.length)]!;
        record.reasoning = `Practice stand-in (${who.standIn} bot). I hold ${o.holeCards.join(' ')}${o.board.length ? ` on ${o.board.join(' ')}` : ''}: ${HAND_WORDS(o)}. ${o.pot} in the pot, ${o.toCall ? `${o.toCall} to call` : 'nothing to call'}. ${verb === 'fold' ? 'Not worth it.' : verb === 'check' ? 'No need to build the pot.' : verb === 'call' ? 'The price is right.' : strength > 0.6 ? 'Value: make them pay.' : 'Pressure: they may fold.'}`;
        if (this.watching || this.humanOut) meta.reasoning = record.reasoning;
      } else {
        const others = o.options.filter((x) => x.key !== key);
        const top = 0.45 + coin() * 0.45;
        const weights = others.map(() => coin() + 0.05);
        const sum = weights.reduce((a, b) => a + b, 0) || 1;
        const probabilities: Partial<Record<OptionKey, number>> = { [key]: Math.round(top * 1000) / 1000 };
        others.forEach((x, i) => (probabilities[x.key] = Math.round(((1 - top) * weights[i]!) / sum * 1000) / 1000));
        meta.probabilities = record.probabilities = probabilities;
      }
    }
    return this.played(actSitAndGo(g, { key }), record, meta);
  }

  private played(next: SitAndGo, record: RecordedAction, meta: ActionMeta): StepResult {
    this.g = next;
    this.hands.at(-1)!.push(record);
    this.archive();
    this.turnStart = Date.now();
    if (next.over && this.talkQueue.length) {
      // Typed while the last move was being played: the game is over, so it is never said (as RemoteDriver's end()).
      const left = this.talkQueue.splice(0);
      try {
        this.onTalkRefused?.(left, 'over');
      } catch {
        // the page's listener must not break the table
      }
    }
    return { seat: record.seat, key: record.key ?? null, meta, snapshot: this.snapshot() };
  }

  async nextHand(): Promise<TableSnapshot> {
    this.g = nextHand(this.game());
    this.hands.push([]);
    this.talk.push([]);
    // Talk typed between hands is said as the new one starts (as RemoteDriver sends it with next).
    this.heard = null;
    this.deliver();
    this.archive();
    this.turnStart = Date.now();
    return this.snapshot();
  }

  /** Keeps a finished hand for the review (once). A hand can finish as it is dealt, when blinds put everyone all-in. */
  private archive(): void {
    const g = this.game();
    if (g.hand.street !== 'done' || this.finished.length > g.handIndex) return;
    this.finished.push(finishedHandOf(g, this.hands[g.handIndex] ?? [], this.talk[g.handIndex] ?? []));
  }

  private players(): Player[] {
    return this.seats.map((s) => ({ kind: s.kind, id: s.id }));
  }

  async review(): Promise<Review> {
    const g = this.game();
    return { players: this.players(), hands: structuredClone(this.finished), recording: g.over ? recordingOf(g, this.players(), this.hands, this.talk) : null };
  }

  /** Who stands in for each seat (null for the human): for the page's practice notice and tests. */
  standIns(): (BotName | null)[] {
    return this.seats.map((s) => s.standIn);
  }

  /** Told when your lines reached the table (with the next move), as RemoteDriver's are. */
  onSaid: ((lines: TalkLine[]) => void) | null = null;
  /** Told when lines will never be said: typed while the move that ends the game was being played ('over'). */
  onTalkRefused: ((lines: string[], why: 'busy' | 'full' | 'refused' | 'over') => void) | null = null;
  private talkQueue: string[] = [];
  /** Your lines per hand, where they were said (for the review and the recording). */
  private talk: TalkLine[][] = [];

  /**
   * Your table talk, as the real table takes it (cleaned, at most 6 waiting): it goes with the next move, and the next
   * chat stand-in to act may answer it. Null in watch mode, once the game is over, or with nothing left after cleaning.
   */
  say(text: string): string | null {
    const line = cleanTalk(text);
    if (this.human === null || !line || this.g?.over || this.talkQueue.length >= 6) return null;
    this.talkQueue.push(line);
    return line;
  }

  /** The lines waiting go with this move: the stand-ins hear the last of them, and onSaid is told. */
  private deliver(): void {
    if (!this.talkQueue.length || this.human === null) return;
    const after = this.hands.at(-1)?.length ?? 0;
    const lines = this.talkQueue.splice(0).map((say) => ({ seat: this.human!, after, say }));
    this.talk.at(-1)?.push(...lines);
    this.heard = lines.at(-1)!.say;
    try {
      this.onSaid?.(lines);
    } catch {
      // the page's listener must not break the table
    }
  }

  snapshot(): TableSnapshot {
    return snapshotOf(this.game(), this.human, (seat) => {
      const who = this.seats[seat]!;
      return who.kind === 'model' ? (who.style === 'decision' ? DECISION_TIME_BANK_MS : CHAT_TIME_BANK_MS) : null;
    });
  }
}
