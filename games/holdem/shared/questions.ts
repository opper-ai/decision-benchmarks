// AI Hold'em's question (the plan's "How models decide"): the one prompt every model gets, in the bench and at the
// table. Everything is built from the engine's observe() for the seat to act, so a model sees its own cards and never
// another's (until a showdown shows them), nor the deck or its seed. The state gives facts only: cards written 'As Kd',
// positions, stacks in chips and in big blinds, the pot, what calling costs and the share of the pot that is, and the
// hand's actions so far; never an equity or a hint of what to play.
//
// - A decision model (System One) gets one `choice` question, named `action`, whose criteria are the legal options
//   (fold, check, call, small, half, three_quarters, pot, allin) with their chip amounts. Its probabilities drive the
//   tell meter.
// - A chat model gets the same instructions, state and options as messages, and answers a strict JSON schema:
//   { action, say, mood, reasoning }. `say` is table talk every player hears (it may bluff), `mood` the face it shows,
//   `reasoning` is shown only in the review after the hand. Lengths are asked for in the instructions and cut on
//   reading, not put in the schema: some Claude routes refuse a strict schema with maxLength (finish_reason "refusal").
//   Opus 5.5 also refused when the reasoning was called "private" and "seen by nobody until the hand is over"; "not
//   seen by the other players during the hand, shown in the review afterwards" says the same and is answered.
//   The reply's fields come back in alphabetical order, and Haiku 5.5 garbles the end of the last string field
//   ("Let's build this pot.','mood':'confident'}", "</br>", runs of ";;;;"). A last field that is no string,
//   `turn_complete: true`, keeps `say` clean; its value means nothing and is not read.
// - At a live table (a TableContext: names and talk) a chat model also hears LIVE_TABLE, the same words for every
//   model: there is an audience, talk on every action, let the face change. The bench's prompt (CHAT_FORMAT, and
//   requestFor without a context) is frozen for the leaderboard: tests/questions-bench-snapshot.test.ts.
//
// Isomorphic and Node-safe: the bench, the service's request checks and the page all word a question the same way.
import type { ChatFormat, ChatMessage } from '../../../packages/kit/shared/chat.ts';
import type { ChoiceQuestion, SystemOneRequest } from '../../../packages/kit/shared/systemone.ts';
import type { HistoryItem, Observation, Option, OptionKey } from './engine.ts';
import { MOODS, type FallbackReason, type Mood } from './recording.ts';

/** The question's name in a request. */
export const QUESTION = 'action';

/** Table talk and private reasoning are cut to these lengths. */
export const MAX_SAY = 90;

/** Table talk cut to `max` characters at a word boundary, with an ellipsis, so a long line never ends mid-word. */
export function clipSay(text: string, max = MAX_SAY): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.\u2014-]+$/u, '')}\u2026`;
}
export const MAX_REASONING = 600;

/** For a live table: the players' names by seat, and what was said this hand (oldest first). The bench gives neither. */
export interface TableContext {
  names?: readonly (string | null | undefined)[];
  talk?: readonly { seat: number; say: string }[];
}

const STREET_NAMES = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' } as const;
const STATUS_TEXT = { empty: 'out', active: 'in the hand', allin: 'all-in', folded: 'folded' } as const;

/** Chips as big blinds, to one decimal. */
const bbOf = (chips: number, bb: number): number => Math.round((10 * chips) / bb) / 10;
const seatName = (seat: number, position: string, ctx?: TableContext): string => {
  const name = ctx?.names?.[seat];
  return `seat ${seat}${position ? ` (${position})` : ''}${name ? ` ${name}` : ''}`;
};

/** One action as the state tells it: "Flop: seat 3 (UTG) raises to 15". */
export function actionText(h: HistoryItem, ctx?: TableContext): string {
  const who = seatName(h.seat, h.position, ctx);
  const allIn = h.allIn ? ' (all-in)' : '';
  const what =
    h.kind === 'fold' ? 'folds'
    : h.kind === 'check' ? 'checks'
    : h.kind === 'call' ? `calls ${h.add}${allIn}`
    : h.kind === 'bet' ? `bets ${h.to}${allIn}`
    : h.kind === 'raise' ? `raises to ${h.to}${allIn}`
    : `goes all-in for ${h.to}`;
  return `${STREET_NAMES[h.street]}: ${who} ${what}`;
}

/** The instructions: the game, who you are, what the options are. The same for every model. */
export function instructionsFor(o: Observation): string {
  const players = o.players.filter((p) => p.status !== 'empty').length;
  const format = o.level
    ? `a Sit & Go of ${players} players left: the blinds go up every few hands and the last player with chips wins.`
    : `a cash game of ${players} players: every hand is played on its own, each player starting it with the same stack.`;
  return (
    `You are playing No-limit Texas Hold'em for play money (chips only, no real money): ${format} ` +
    `You are seat ${o.seat} (${o.position}). The state shows your cards, the board, every player's stack and bet, and the actions so far. ` +
    'Pick your action from the options: each one is legal now and gives its chip amount ("raise to" is your total bet on this street). ' +
    'Play to win as many chips as you can.'
  );
}

/** An option's text: the engine's label, then what it puts in, in chips and big blinds. */
export function criterion(op: Option, bb: number): string {
  if (op.kind === 'fold') return 'Fold: give up the hand and what you have put in';
  if (op.kind === 'check') return 'Check: put in nothing more';
  return `${op.label}: puts in ${op.add} more chips (${bbOf(op.add, bb)} big blinds)`;
}

/** The question for the seat to act: one option per legal menu entry, in menu order (fold, then smallest to largest). */
export function questionFor(o: Observation): ChoiceQuestion {
  if (!o.options.length) throw new Error(`seat ${o.seat} is not to act`);
  return { type: 'choice', instructions: instructionsFor(o), criteria: Object.fromEntries(o.options.map((op) => [op.key, criterion(op, o.blinds.bb)])) };
}

/** The state for the seat to act: what it can see, as facts. */
export function stateFor(o: Observation, ctx?: TableContext): Record<string, unknown> {
  const bb = o.blinds.bb;
  const me = o.players[o.seat]!;
  const state: Record<string, unknown> = {
    you: { seat: o.seat, position: o.position, cards: o.holeCards.join(' '), stack: me.stack, stackBigBlinds: bbOf(me.stack, bb) },
    street: o.street,
    board: o.board.length ? o.board.join(' ') : 'none yet',
    blinds: `${o.blinds.sb}/${bb}${o.blinds.ante ? `, ante ${o.blinds.ante}` : ''}`,
    pot: o.pot,
    potBigBlinds: bbOf(o.pot, bb),
    toCall: o.toCall,
  };
  if (o.toCall > 0) {
    const after = o.pot + o.toCall;
    state.potOdds = `Calling ${o.toCall} to win ${o.pot}: your call would be ${Math.round((100 * o.toCall) / after)}% of the pot after it.`;
  }
  if (o.level) {
    const l = o.level;
    state.level = `Hand ${l.hand}, level ${l.level}: the blinds go up to ${l.next.sb}/${l.next.bb}${l.next.ante ? ` with an ante of ${l.next.ante}` : ''} after ${l.handsUntilNextLevel === 1 ? 'this hand' : `${l.handsUntilNextLevel} hands, this one included`}.`;
  }
  state.players = o.players
    .filter((p) => p.status !== 'empty')
    .map((p) => ({
      seat: p.seat,
      ...(ctx?.names?.[p.seat] ? { name: ctx.names[p.seat] } : {}),
      position: p.position,
      ...(p.seat === o.seat ? { you: true } : {}),
      stack: p.stack,
      stackBigBlinds: bbOf(p.stack, bb),
      betThisStreet: p.bet,
      status: STATUS_TEXT[p.status],
      ...(p.seat !== o.seat && p.cards ? { shownCards: p.cards.join(' ') } : {}),
    }));
  state.actions = o.history.length ? o.history.map((h) => actionText(h, ctx)) : ['none yet: the blinds are in'];
  if (ctx?.talk?.length) state.tableTalk = ctx.talk.map((t) => `${seatName(t.seat, o.players[t.seat]?.position ?? '', ctx)}: ${JSON.stringify(clipSay(t.say))}`);
  return state;
}

/** The request body (state and question) for the seat to act. */
export const requestFor = (o: Observation, ctx?: TableContext): Pick<SystemOneRequest, 'state' | 'questions'> => ({ state: stateFor(o, ctx), questions: { [QUESTION]: questionFor(o) } });

// ---------- chat models ----------

/** The system message's field-by-field description, the moods listed in `moods`' order. */
const chatSystemText = (moods: readonly Mood[]): string =>
  "You are a player in AI Hold'em, a game of No-limit Texas Hold'em for play-money chips against other players. " +
  'Each turn you get the instructions, the state of the hand and your options, and answer with JSON only: ' +
  '"action": one of the option keys; ' +
  `"say": what you say out loud at the table, at most ${MAX_SAY} characters. Every player hears it; it may be true or a bluff, or empty; ` +
  `"mood": the face you show the table, one of ${moods.join(', ')}. It can bluff too; ` +
  `"reasoning": why you chose this action, at most ${MAX_REASONING} characters. The other players do not see it during the hand; it is shown in the review afterwards; ` +
  '"turn_complete": true.';

/**
 * What a chat model is told besides the question, in the bench: the play-money framing and what each field of its
 * answer is for. Frozen (tests/questions-bench-snapshot.test.ts): the published leaderboard was played on it.
 */
export const CHAT_SYSTEM = chatSystemText(MOODS);

/**
 * At a live table the moods are listed alphabetically, so no face comes first as the default (the bench's order, kept
 * for the leaderboard, starts with relaxed).
 */
export const LIVE_MOODS: readonly Mood[] = [...MOODS].sort();

/**
 * What every chat model is told at a live table (and only there), the same for all of them: there is an audience, so
 * talk on every action and let the face change. No poker advice, and nothing about hiding or showing one's cards.
 */
export const LIVE_TABLE =
  'This is a live table with an audience watching. On every action, say something out loud: a short line in your own voice ' +
  '(needle, bluff, banter, or answer what the others said); leave "say" empty only if you truly want silence. ' +
  'For "mood", pick the face you want to show at this moment and use the whole range, annoyed, nervous and smug included: ' +
  "real players' faces change as the game goes, and a face can be true or a bluff.";

/** The system message at a live table: the bench's description (moods in LIVE_MOODS order), then LIVE_TABLE. */
export const LIVE_CHAT_SYSTEM = `${chatSystemText(LIVE_MOODS)} ${LIVE_TABLE}`;

/** The user message for one question: the instructions, the state and each option with what it means. */
export function chatPrompt(state: Record<string, unknown>, q: ChoiceQuestion): string {
  const options = Object.entries(q.criteria).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  return `${q.instructions}\n\nState:\n${JSON.stringify(state, null, 1)}\n\nOptions:\n${options}`;
}

/** The messages a chat model gets for one question (in the bench). */
export const chatMessages = (state: Record<string, unknown>, q: ChoiceQuestion): ChatMessage[] => [
  { role: 'system', content: CHAT_SYSTEM },
  { role: 'user', content: chatPrompt(state, q) },
];

/** The strict JSON schema of a chat model's answer: the action among the question's option keys. */
export function chatSchema(keys: readonly string[], moods: readonly Mood[] = MOODS): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'holdem_action',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'say', 'mood', 'reasoning', 'turn_complete'],
        properties: {
          action: { type: 'string', enum: [...keys] },
          say: { type: 'string' },
          mood: { type: 'string', enum: [...moods] },
          reasoning: { type: 'string' },
          turn_complete: { type: 'boolean' },
        },
      },
    },
  };
}

/** A chat model's answer: the action, table talk, mood and reasoning. */
export interface ChatAnswer {
  type: 'choice';
  choice: string;
  say: string;
  mood: Mood;
  reasoning: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A chat model's reply read against the options: null unless it is a JSON object whose action is one of `keys`, with
 * say and reasoning as text and mood one of the moods. Talk and reasoning longer than asked are cut, not refused.
 */
export function parseChatAnswer(content: string, keys: readonly string[]): ChatAnswer | null {
  let v: unknown;
  try {
    v = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return null;
  }
  if (!isObj(v) || typeof v.action !== 'string' || !keys.includes(v.action)) return null;
  if (typeof v.say !== 'string' || typeof v.reasoning !== 'string' || !MOODS.includes(v.mood as Mood)) return null;
  return { type: 'choice', choice: v.action, say: clipSay(v.say), mood: v.mood as Mood, reasoning: v.reasoning.trim().slice(0, MAX_REASONING) };
}

/** How the bench asks a chat model: GameDefinition.chat. Frozen with CHAT_SYSTEM. */
export const CHAT_FORMAT: ChatFormat = {
  messages: chatMessages,
  responseFormat: (q) => chatSchema(Object.keys(q.criteria)),
  parse: (content, q) => parseChatAnswer(content, Object.keys(q.criteria)) as Record<string, unknown> | null,
};

/** How a live table asks a chat model: the same question and answer, with LIVE_CHAT_SYSTEM and the moods in LIVE_MOODS order. */
export const LIVE_CHAT_FORMAT: ChatFormat = {
  messages: (state, q) => [
    { role: 'system', content: LIVE_CHAT_SYSTEM },
    { role: 'user', content: chatPrompt(state, q) },
  ],
  responseFormat: (q) => chatSchema(Object.keys(q.criteria), LIVE_MOODS),
  parse: CHAT_FORMAT.parse,
};

/** The chat format for a question: a live table's when there is a TableContext (the table service), else the bench's. */
export const chatFormatFor = (ctx?: TableContext): ChatFormat => (ctx ? LIVE_CHAT_FORMAT : CHAT_FORMAT);

// ---------- reading an answer ----------

/** A model's move read from its answer: the option, and whatever came with it (probabilities, or talk and mood). */
export interface ReadAnswer {
  key: OptionKey;
  probabilities?: Partial<Record<OptionKey, number>>;
  say?: string;
  mood?: Mood;
  reasoning?: string;
}

/**
 * The answer to the action question, from either kind of model: a move, or why there is none ('refusal' for a refused
 * reply, 'invalid' for anything that is not one of `options`).
 */
export function readAnswer(answer: unknown, options: readonly OptionKey[]): ReadAnswer | { why: Extract<FallbackReason, 'invalid' | 'refusal'> } {
  if (isObj(answer) && answer.type === 'refusal') return { why: 'refusal' };
  if (!isObj(answer) || answer.type !== 'choice' || typeof answer.choice !== 'string' || !options.includes(answer.choice as OptionKey)) return { why: 'invalid' };
  const out: ReadAnswer = { key: answer.choice as OptionKey };
  if (isObj(answer.probabilities)) {
    const p: Partial<Record<OptionKey, number>> = {};
    for (const k of options) {
      const x = answer.probabilities[k];
      if (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1) p[k] = x;
    }
    if (Object.keys(p).length) out.probabilities = p;
  }
  if (typeof answer.say === 'string') out.say = clipSay(answer.say);
  if (MOODS.includes(answer.mood as Mood)) out.mood = answer.mood as Mood;
  if (typeof answer.reasoning === 'string') out.reasoning = answer.reasoning.slice(0, MAX_REASONING);
  return out;
}
