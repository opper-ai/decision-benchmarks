import {
  PASSIVE_BLEED_TICKS,
  PASSIVE_WARN_TICKS,
  STAGE_MAX,
  STAGE_MIN,
  TICK_HZ,
  clone,
  committedFrames,
  gap,
  isActionable,
  legalMoves,
  rand,
  step,
  type Fighter,
  type GameEvent,
  type GameState,
  type Side,
} from './engine/engine.ts';
import { MOVE_IDS, MOVES, U, type MoveId } from './engine/moves.ts';

export type Track = 'assisted' | 'raw';
export const TRACKS: Track[] = ['assisted', 'raw'];

/**
 * Payoff columns: `stand` = the opponent starts nothing new; `avg` = the average over everything it
 * could do (stand or any of its moves) as soon as it can act: the typical outcome when you cannot read
 * it; `worst` = its best answer (your worst case); `usual` = it repeats its most used recent attack.
 */
export type Column = 'stand' | 'avg' | 'worst' | 'usual';
export const COLUMNS: Column[] = ['stand', 'avg', 'worst', 'usual'];
/** A concrete opponent action to simulate: `stand` = nothing new. */
export type Reply = 'stand' | MoveId;

export interface QuestionOption {
  id: MoveId;
  /** Text shown to the model. */
  facts: string;
  /** Assisted track: HP swing (dealt minus taken) per column. */
  payoff?: Partial<Record<Column, number>>;
  /** The opponent move behind `worst`. */
  worstReply?: Reply;
  /** Frames ahead (+) or behind (-) of the opponent when the exchange ends, if it stands. */
  adv?: number;
  /** Distance after the exchange if the opponent stands (units). */
  endGap?: number;
  /** Movement only: the best average an attack has from where this move leaves you, and which. */
  then?: { avg: number; move: MoveId };
}

export interface Question {
  fighter: Side;
  track: Track;
  /** Tick of the state the question describes. */
  tick: number;
  instructions: string;
  context: Record<string, string>;
  /** In the order shown (shuffled per question). */
  options: QuestionOption[];
  /** Payoff columns shown (assisted). */
  columns?: Column[];
  /** The opponent's usual attack, when known. */
  usual?: MoveId;
}

/** A fighter sees the opponent as it was this many ticks ago: about human reaction time. */
export const REACTION_TICKS = 10;

const RULES =
  'You control one fighter in a 2D fighting game. Win the round with more HP than the opponent when time runs out, or by knocking them out. ' +
  'Strikes beat throws, throws beat blocks, blocks beat strikes (a blocked strike does 1/4 damage). Block high stops highs and jump kicks; block low stops lows. ' +
  'Standing still and walking back guard high; walking in, dashing, backdashing and jumping do not block. Jumping dodges lows and throws, but any high knocks you out of the air. ' +
  'Frames: 60 per second. You see the opponent with a slight delay.';

const MOVE_NOTES = 'Each option gives the move\'s height, damage, startup and recovery frames, and reach in body-lengths.';

const ASSISTED_HOW =
  'Each option shows your HP swing over the exchange (+ good for you): avg = averaged over everything the opponent could do (the typical result); ' +
  'worst = if it makes its best answer (named); usual = if it repeats its usual attack. adv = frames you can act before (+) or after (-) the opponent when it ends. ' +
  'A move that only repositions shows the better attack it sets up (then).';

const PROBABILITIES = 'Probabilities, when asked for: how likely each move is to be your best choice.';
const PASSIVITY = 'Passivity: 8 s without attacking or stepping in (time under attack does not count) costs 1 HP per second until you engage.';

/** For models with a short context: the essentials only. */
const COMPACT =
  'Pick your fighter\'s next move in a 2D fighting game; more HP at time-out, or a knockout, wins. Strikes beat throws, throws beat blocks, blocks beat strikes.';
const COMPACT_ASSISTED = 'avg / worst / usual = your HP swing if the opponent does anything, on average / its best answer / its usual attack. adv = frames ahead (+) or behind (-).';

export function instructionsFor(track: Track, compact = false, passivity = false): string {
  const pass = passivity ? PASSIVITY : '';
  if (compact) return [COMPACT, pass, track === 'assisted' ? COMPACT_ASSISTED : ''].filter(Boolean).join(' ');
  // No move table: raw options carry each move's numbers, assisted options carry their outcomes.
  return [RULES, pass, track === 'assisted' ? ASSISTED_HOW : MOVE_NOTES, PROBABILITIES].filter(Boolean).join(' ');
}

/** "passive 5 s" once it matters, so the model can see its clock. */
function passiveNote(f: Fighter): string {
  if (f.passive < PASSIVE_WARN_TICKS / 2) return '';
  const secs = Math.floor(f.passive / TICK_HZ);
  return f.passive >= PASSIVE_BLEED_TICKS ? `, passive ${secs} s (losing HP)` : `, passive ${secs} s`;
}

const bl = (units: number) => (units / U).toFixed(1);

export function doing(f: Fighter): string {
  const n = committedFrames(f);
  const atk = f.atk ?? f.move;
  switch (f.phase) {
    case 'idle':
      return 'standing, free to act';
    case 'block':
      return `blocking ${f.guard}`;
    case 'startup':
    case 'active':
      return `attacking with ${atk}, busy ${n} more frames`;
    case 'recovery':
      return `recovering from ${atk}, ${n} frames left`;
    case 'move':
      return f.move === 'jump' ? `in the air, lands in ${n} frames` : `${f.move === 'backdash' ? 'backdashing' : 'walking'}, ${n} frames left`;
    case 'blockstun':
      return `stuck blocking, ${n} frames left`;
    case 'hitstun':
      return `stunned, ${n} frames left`;
    case 'knockdown':
      return `knocked down, gets up in ${n} frames`;
    case 'getup':
      return 'getting up (cannot be hit)';
    case 'ko':
      return 'knocked out';
  }
}

function tally(es: GameEvent[], i: Side, acc: { dealt: number; taken: number }): void {
  for (const e of es) {
    if (e.kind === 'hit' || e.kind === 'armor') {
      if (e.f === i) acc.dealt += e.dmg;
      else acc.taken += e.dmg;
    } else if (e.kind === 'block') {
      if (e.f === i) acc.dealt += e.chip;
      else acc.taken += e.chip;
    }
  }
}

export interface Exchange {
  /** HP dealt minus HP taken. */
  swing: number;
  /** Frames this fighter can act before (+) or after (-) the opponent when it ends. */
  adv: number;
  endGap: number;
  /** The state when it ends. */
  end: GameState;
}

/**
 * Fighter `i` starts `m` now. The opponent starts `reply` on the first tick it can act (now if it is
 * free, later if it is busy), or nothing new (`stand`). With `after`, the opponent first lets `m`
 * play out (guarding, or taking it) and answers once it is over: how a blocked or whiffed move gets
 * punished. Played until both can act again. Null if `reply` never becomes legal.
 */
export function simulateExchange(s: GameState, i: Side, m: MoveId, reply: Reply, after = false): Exchange | null {
  const j = (1 - i) as Side;
  const c = clone(s);
  const acc = { dealt: 0, taken: 0 };
  const minBusy = MOVES[m].kind === 'block' ? MOVES[m].min : 0;
  let replied = reply === 'stand';
  let meFreeSince = -1;
  let oppFreeSince = isActionable(c, j) ? 0 : -1;
  for (let t = 0; t < 160 && c.round.phase === 'fight'; t++) {
    const inputs: [MoveId | null, MoveId | null] = [null, null];
    if (t === 0) inputs[i] = m;
    const mine = c.fighters[i];
    const mineLive = mine.phase === 'startup' || mine.phase === 'active' || (mine.phase === 'move' && t < 12);
    if (!replied && isActionable(c, j) && !(after && (t === 0 || mineLive))) {
      if (!legalMoves(c, j).includes(reply as MoveId)) return null;
      inputs[j] = reply as MoveId;
      replied = true;
    }
    tally(step(c, inputs), i, acc);
    const meFree = isActionable(c, i) && t + 1 >= minBusy;
    const oppFree = isActionable(c, j);
    if (!meFree) meFreeSince = -1;
    else if (meFreeSince < 0) meFreeSince = t + 1;
    if (!oppFree) oppFreeSince = -1;
    else if (oppFreeSince < 0) oppFreeSince = t + 1;
    if (replied && meFree && oppFree && t + 1 >= minBusy) break;
    if (!replied && t > 120) return null;
  }
  return { swing: acc.dealt - acc.taken, adv: Math.max(0, oppFreeSince) - Math.max(0, meFreeSince), endGap: gap(c), end: c };
}

/** Average HP swing of `m` over every answer the opponent could give (now or after `m` plays out). */
export function averageSwing(s: GameState, i: Side, m: MoveId): number | null {
  const stand = simulateExchange(s, i, m, 'stand');
  if (!stand) return null;
  let sum = stand.swing;
  let n = 1;
  for (const r of MOVE_IDS) {
    for (const after of [false, true]) {
      const x = simulateExchange(s, i, m, r, after);
      if (!x) continue;
      sum += x.swing;
      n++;
    }
  }
  return sum / n;
}

/** The best average an attack offers from `s` (a position a movement option leads to). */
function bestFollowUp(s: GameState, i: Side): { avg: number; move: MoveId } | null {
  if (!isActionable(s, i)) return null;
  let best: { avg: number; move: MoveId } | null = null;
  for (const m of offeredMoves(s, i)) {
    if (MOVES[m].kind !== 'attack') continue;
    const a = averageSwing(s, i, m);
    if (a !== null && (!best || a > best.avg)) best = { avg: a, move: m };
  }
  return best && best.avg > 0 ? { avg: Math.round(best.avg * 10) / 10 || 0, move: best.move } : null;
}

/** The opponent's most used attack in the recent exchanges (at least twice), if any. */
export function habit(s: GameState, i: Side): MoveId | null {
  const j = (1 - i) as Side;
  const counts = new Map<MoveId, number>();
  for (const e of s.history) if (e.f === j) counts.set(e.move, (counts.get(e.move) ?? 0) + 1);
  let best: MoveId | null = null;
  let n = 1;
  for (const [m, c] of counts) {
    if (c > n) {
      best = m;
      n = c;
    }
  }
  return best;
}

/** How far an attack can connect from, including any travel (jump kick, special dash). */
export function effectiveReach(m: MoveId): number {
  const d = MOVES[m];
  if (d.kind !== 'attack') return 0;
  return d.range + (d.dash ?? 0) + (d.airborne ? Math.round(d.airborne.dx * 0.6) : 0);
}

/**
 * Moves worth offering: everything legal, minus attacks that cannot possibly connect (more than 0.15
 * beyond their reach) unless the opponent is coming in with an attack.
 */
export function offeredMoves(s: GameState, i: Side): MoveId[] {
  const legal = legalMoves(s, i);
  const opp = s.fighters[(1 - i) as Side];
  const closing = opp.atk !== null && (opp.phase === 'startup' || opp.phase === 'active') && gap(s) <= effectiveReach(opp.atk);
  if (closing) return legal;
  return legal.filter((m) => MOVES[m].kind !== 'attack' || effectiveReach(m) + 150 >= gap(s));
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

function recent(s: GameState, i: Side, n = 4): string {
  const items = s.history.slice(-n).map((e) => {
    const mine = e.f === i;
    switch (e.result) {
      case 'hit':
        return mine ? `you hit ${e.move} (${e.dmg})` : `their ${e.move} hit you (${e.dmg})`;
      case 'blocked':
        return mine ? `your ${e.move} was blocked` : `you blocked their ${e.move}`;
      case 'whiffed':
        return mine ? `your ${e.move} missed` : `their ${e.move} missed`;
      case 'armored':
        return mine ? `your ${e.move} broke armor` : `you armored their ${e.move}`;
    }
  });
  return items.length ? items.join('; ') : 'none yet';
}

/** Token estimate, deliberately on the high side (about 3.2 characters per token). */
export const approxTokens = (text: string) => Math.ceil(text.length / 3.2);

/** Tokens a question costs as sent, with a margin for the request's JSON. */
export const questionTokens = (q: Question) => approxTokens(q.instructions) + approxTokens(questionText(q)) + 40;

export interface QuestionOpts {
  track?: Track;
  /** Keep the whole question under this many tokens (compact rules, fewer columns, then fewer options). */
  maxTokens?: number;
}

/** Deterministic shuffle. */
function shuffle<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  let r = seed >>> 0;
  for (let k = out.length - 1; k > 0; k--) {
    const [v, next] = rand(r);
    r = next;
    const j = Math.floor(v * (k + 1));
    [out[k], out[j]] = [out[j], out[k]];
  }
  return out;
}

const wallDist = (f: Fighter, side: Side) => (side === 0 ? f.x - STAGE_MIN : STAGE_MAX - f.x);

/**
 * The question for fighter `i`. `s` is what the fighter sees (see Perception), in which it can act:
 * the current state, or a predicted one when asked early.
 */
export function buildQuestion(s: GameState, i: Side, opts: QuestionOpts = {}): Question {
  const track = opts.track ?? 'assisted';
  const j = (1 - i) as Side;
  const me = s.fighters[i];
  const opp = s.fighters[j];
  // Shuffled so a model's position bias cannot pass for a preference.
  const moves = shuffle(offeredMoves(s, i), (s.seed ^ Math.imul(s.tick + 1, 2654435761) ^ (i ? 0x9e37 : 0)) >>> 0);
  let context: Record<string, string> = {
    you: `${me.hp} HP, meter ${me.meter}, ${doing(me)}, ${bl(wallDist(me, i))} from your wall${passiveNote(me)}`,
    opponent: `${opp.hp} HP, meter ${opp.meter}, ${doing(opp)}, ${bl(wallDist(opp, j))} from their wall${passiveNote(opp)}`,
    distance: bl(gap(s)),
    time: `round ${s.round.n}, ${Math.ceil(s.round.timer / TICK_HZ)} s left, rounds won ${s.wins[i]}-${s.wins[j]}`,
    recent: recent(s, i),
  };
  const compact = Boolean(opts.maxTokens);
  const instructions = instructionsFor(track, compact, Boolean(s.rules?.passivity));

  let options: QuestionOption[];
  let columns: Column[] | undefined;
  let usual: MoveId | undefined;
  if (track === 'raw') {
    options = moves.map((id) => ({ id, facts: rawFacts(id) }));
  } else {
    usual = habit(s, i) ?? undefined;
    if (usual) context = { ...context, 'their usual attack': usual };
    options = moves.map((id) => {
      const stand = simulateExchange(s, i, id, 'stand')!;
      let worst: { r: Reply; swing: number } = { r: 'stand', swing: stand.swing };
      let sum = stand.swing;
      let n = 1;
      for (const r of MOVE_IDS) {
        for (const after of [false, true]) {
          const x = simulateExchange(s, i, id, r, after);
          if (!x) continue;
          sum += x.swing;
          n++;
          if (x.swing < worst.swing) worst = { r, swing: x.swing };
        }
      }
      const payoff: Partial<Record<Column, number>> = { stand: stand.swing, avg: Math.round((sum / n) * 10) / 10 || 0, worst: worst.swing };
      if (usual) payoff.usual = simulateExchange(s, i, id, usual)?.swing ?? stand.swing;
      // Moving only pays off in what it sets up: the best attack from where it leaves you.
      const then = MOVES[id].kind === 'movement' && stand.swing >= 0 ? bestFollowUp(stand.end, i) : null;
      return { id, payoff, worstReply: worst.r, adv: stand.adv, endGap: stand.endGap, ...(then ? { then } : {}), facts: '' };
    });
    // Only worth saying when it beats the best attack available right now.
    const bestNow = Math.max(0, ...options.filter((o) => MOVES[o.id].kind === 'attack').map((o) => o.payoff!.avg!));
    for (const o of options) if (o.then && o.then.avg <= bestNow + 1) delete o.then;
    const render = (cols: Column[]) => {
      for (const o of options) {
        const p = o.payoff!;
        const parts: string[] = [];
        if (cols.includes('avg')) parts.push(`avg ${signed(p.avg!)}`);
        if (cols.includes('worst')) parts.push(`worst ${signed(p.worst!)}${o.worstReply !== 'stand' ? ` (if ${o.worstReply})` : ''}`);
        if (cols.includes('usual') && p.usual !== undefined) parts.push(`usual ${signed(p.usual)}`);
        const ends = MOVES[o.id].kind === 'movement' ? `, ends ${bl(o.endGap!)}${o.then ? `; then ${o.then.move} avg ${signed(o.then.avg)}` : ''}` : '';
        o.facts = `${parts.join(', ')}; adv ${signed(o.adv!)}f${ends}`;
      }
    };
    // `stand` stays in the data (baselines use it) but is not shown: avg and worst carry the decision.
    let cols: Column[] = usual ? ['avg', 'worst', 'usual'] : ['avg', 'worst'];
    render(cols);
    columns = cols;
    if (opts.maxTokens) {
      const size = () => questionTokens({ fighter: i, track, tick: s.tick, instructions, context, options });
      // Fit: drop the usual column, then the history, then the least promising options.
      if (size() > opts.maxTokens && cols.includes('usual')) {
        cols = ['avg', 'worst'];
        render(cols);
        const { ['their usual attack']: _drop, ...rest } = context;
        context = rest;
      }
      if (size() > opts.maxTokens) context = { ...context, recent: '' };
      const score = (o: QuestionOption) => o.payoff!.avg!;
      while (size() > opts.maxTokens && options.length > 4) {
        const weakest = options.reduce((a, b) => (score(b) < score(a) ? b : a));
        options = options.filter((o) => o !== weakest);
      }
      columns = cols;
    }
  }
  return { fighter: i, track, tick: s.tick, instructions, context, options, ...(columns ? { columns } : {}), ...(usual ? { usual } : {}) };
}

function rawFacts(id: MoveId): string {
  const d = MOVES[id];
  if (d.kind === 'attack') {
    const extra = [
      d.knockdown ? 'knocks down' : '',
      d.antiAirInvuln ? 'beats jump-ins' : '',
      d.chainTo ? `then ${d.chainTo} if it lands` : '',
      d.meterCost ? `dash, costs ${d.meterCost} meter, absorbs a hit` : '',
      d.airborne ? 'jumps in, must be blocked high' : '',
    ].filter(Boolean);
    return `${d.height === 'throw' ? 'unblockable' : d.height}, ${d.dmg} dmg, startup ${d.startup}f, recovery ${d.recovery}f, reach ${bl(effectiveReach(id))}${extra.length ? `, ${extra.join(', ')}` : ''}`;
  }
  if (d.kind === 'block') return d.guard === 'high' ? 'stops highs and jump kicks' : 'stops lows';
  if (id === 'jump') return 'airborne 34f, dodges lows and throws';
  if (id === 'backdash') return 'back 1.0, untouchable 6f';
  if (id === 'dash_forward') return 'forward 0.8 in 9f';
  return id === 'walk_forward' ? 'forward 0.4 in 12f' : 'back 0.4 in 12f, guards high';
}

/** The System One request body for a question. */
export function toSystemOne(q: Question, model: string) {
  return {
    model,
    state: Object.fromEntries(Object.entries(q.context).filter(([, v]) => v)),
    questions: {
      move: {
        type: 'choice',
        instructions: q.instructions,
        criteria: Object.fromEntries(q.options.map((o) => [o.id, o.facts])),
      },
    },
  };
}

/** A plain-text rendering of the question, for chat models and the decision cards. */
export function questionText(q: Question): string {
  const ctx = Object.entries(q.context)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const opts = q.options.map((o) => `- ${o.id}: ${o.facts}`).join('\n');
  return `${ctx}\n\nOptions:\n${opts}`;
}
