// The question every model gets: built from the seat's own observation, so it never shows another seat's cards or the
// deck, its options are exactly the legal ones, and a chat model's reply is read strictly.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chatRequestBody, REFUSAL } from '../../../packages/kit/shared/chat';
import { botDecide, BOT_NAMES } from '../shared/bots';
import { formatCard } from '../shared/cards';
import { applyAction, legalOptions, newHand, observe, toAct, type HandState } from '../shared/engine';
import { CHAT_MODELS, HOLDEM_MODELS, SETS } from '../shared/models';
import { CHAT_FORMAT, CHAT_SYSTEM, chatFormatFor, chatSchema, LIVE_CHAT_FORMAT, LIVE_CHAT_SYSTEM, LIVE_TABLE, MAX_REASONING, MAX_SAY, parseChatAnswer, QUESTION, questionFor, readAnswer, requestFor, stateFor } from '../shared/questions';
import { actSitAndGo, newSitAndGo } from '../shared/sitngo';
import { deriveSeed, keyFromSeed } from '../shared/rng';
import { deal, act } from './support';

const CARD = /\b[2-9TJQKA][cdhs]\b/g;

/** Every decision of `hands` bot-played hands: the state before it. */
function spots(hands: number): HandState[] {
  const out: HandState[] = [];
  for (let h = 0; h < hands; h++) {
    let s = newHand({ stacks: [200, 200, 200, 200], button: h % 4, sb: 1, bb: 2, deckSeed: deriveSeed(987_654_321, h) });
    while (toAct(s) !== null) {
      out.push(s);
      const seat = toAct(s)!;
      s = applyAction(s, { key: botDecide(BOT_NAMES[(seat + h) % 4]!, observe(s, seat)) });
    }
  }
  return out;
}

describe('the question', () => {
  it("shows only the seat's own cards and the board, never the deck or its seed, and offers exactly the legal options", () => {
    const all = spots(60);
    expect(all.length).toBeGreaterThan(300);
    for (const s of all) {
      const seat = toAct(s)!;
      const req = requestFor(observe(s, seat));
      const text = JSON.stringify(req);
      const visible = new Set([...s.seats[seat]!.hole, ...s.board].map(formatCard));
      for (const c of text.match(CARD) ?? []) expect(visible.has(c), `${c} leaked to seat ${seat}`).toBe(true);
      expect(text).not.toContain(String(s.deckSeed));
      for (const [i, p] of s.seats.entries()) if (i !== seat) expect(text).not.toContain(p.hole.map(formatCard).join(' '));
      const q = req.questions[QUESTION]!;
      expect(Object.keys(q.criteria)).toEqual(legalOptions(s).map((o) => o.key));
      expect(Object.keys(req.questions)).toEqual([QUESTION]);
    }
  });

  it('gives facts in chips and big blinds, the pot odds when facing a bet, and the actions so far', () => {
    // UTG raises to 5, the button calls: the small blind faces 4 more into a pot of 13.
    const s = act(deal({ stacks: [200, 200, 200, 200], sb: 1, bb: 2, holes: { 1: 'As Kd' } }), 'small', 'call');
    const o = observe(s, 1);
    const state = stateFor(o);
    expect(state.you).toEqual({ seat: 1, position: 'SB', cards: 'As Kd', stack: 199, stackBigBlinds: 99.5 });
    expect(state).toMatchObject({ street: 'preflop', board: 'none yet', blinds: '1/2', pot: 13, potBigBlinds: 6.5, toCall: 4 });
    expect(state.potOdds).toBe('Calling 4 to win 13: your call would be 24% of the pot after it.');
    expect(state.actions).toEqual(['Preflop: seat 3 (UTG) raises to 5', 'Preflop: seat 0 (BTN) calls 5']);
    expect(state.players).toContainEqual({ seat: 3, position: 'UTG', stack: 195, stackBigBlinds: 97.5, betThisStreet: 5, status: 'in the hand' });
    const q = requestFor(o).questions[QUESTION]!;
    expect(q.instructions).toContain('play money');
    expect(q.instructions).toContain('You are seat 1 (SB)');
    expect(q.criteria.fold).toMatch(/^Fold/);
    expect(q.criteria.call).toBe('Call 4: puts in 4 more chips (2 big blinds)');
    // No equity, no advice.
    expect(JSON.stringify(requestFor(o))).not.toMatch(/equity|should|recommend/i);
  });

  it('names players and repeats their table talk at a live table, and only then', () => {
    const s = act(deal({ stacks: [200, 200, 200], sb: 1, bb: 2 }), 'small');
    const o = observe(s, 1);
    const state = stateFor(o, { names: ['Opus', 'You', 'Clef'], talk: [{ seat: 0, say: 'I have it this time.' }] });
    expect(state.tableTalk).toEqual(['seat 0 (BTN) Opus: "I have it this time."']);
    expect(state.actions).toEqual(['Preflop: seat 0 (BTN) Opus raises to 5']);
    expect(stateFor(o)).not.toHaveProperty('tableTalk');
  });

  it('lists all six players of a six-seat live table, with their names, positions, every action and every line said', () => {
    const names = ['Human', 'Clef', 'Haiku 5.5', 'Jev 1.13', 'Opus 5.5', 'GPT-6.1 Sol'];
    let g = newSitAndGo({ seats: 6, key: keyFromSeed(4) });
    const talk: { seat: number; say: string }[] = [];
    for (let i = 0; i < 4; i++) {
      talk.push({ seat: toAct(g.hand)!, say: `Line ${i} from ${names[toAct(g.hand)!]}, said out loud at a full table.` });
      g = actSitAndGo(g, { key: i % 2 ? 'small' : 'call' });
    }
    const o = observe(g.hand, toAct(g.hand)!);
    const state = stateFor(o, { names, talk });
    const players = state.players as { seat: number; name: string; position: string }[];
    expect(players.map((p) => p.seat)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(players.map((p) => p.name)).toEqual(names);
    expect(new Set(players.map((p) => p.position))).toEqual(new Set(['BTN', 'SB', 'BB', 'UTG', 'MP', 'CO']));
    expect(state.actions).toHaveLength(4);
    expect(state.tableTalk).toHaveLength(4);
    for (const t of talk) expect((state.tableTalk as string[]).some((line) => line.endsWith(JSON.stringify(t.say)))).toBe(true);
    expect(state.level).toBe('Hand 1, level 1: the blinds go up to 15/30 after 12 hands, this one included.');
    const prompt = LIVE_CHAT_FORMAT.messages(state, questionFor(o)).at(-1)!.content;
    for (const name of names) expect(prompt).toContain(`"name": "${name}"`);
    expect(questionFor(o).instructions).toContain('a Sit & Go of 6 players left');
  });
});

describe("a chat model's answer", () => {
  const keys = ['fold', 'call', 'half'];
  const ok = { action: 'call', say: 'Let us see a flop.', mood: 'relaxed', reasoning: 'Suited connectors, good price.' };

  it('asks a strict schema whose action is one of the options, with no length limits that make some routes refuse', () => {
    const f = chatSchema(keys) as { json_schema: { strict: boolean; schema: { required: string[]; properties: Record<string, { enum?: string[]; maxLength?: number }> } } };
    expect(f.json_schema.strict).toBe(true);
    expect(f.json_schema.schema.required).toEqual(['action', 'say', 'mood', 'reasoning', 'turn_complete']);
    // Not a string, and last in alphabetical order: Haiku 5.5 garbles the end of the last string field.
    expect(Object.keys(f.json_schema.schema.properties).sort().at(-1)).toBe('turn_complete');
    expect(f.json_schema.schema.properties.action!.enum).toEqual(keys);
    expect(f.json_schema.schema.properties.mood!.enum).toEqual(['relaxed', 'confident', 'nervous', 'annoyed', 'smug']);
    expect(JSON.stringify(f)).not.toContain('maxLength');
    const q = requestFor(observe(act(deal({ stacks: [200, 200] }), 'call'), 1)).questions[QUESTION]!;
    const [system, user] = CHAT_FORMAT.messages({ a: 1 }, q);
    expect(system!.content).toContain('play-money');
    expect(system!.content).not.toMatch(/private|nobody sees/i);
    expect(user!.content).toContain(q.instructions);
    expect(user!.content).toContain('- check: Check');
  });

  it('accepts a valid reply, fenced or not, cutting long talk and reasoning', () => {
    expect(parseChatAnswer(JSON.stringify(ok), keys)).toEqual({ type: 'choice', choice: 'call', say: ok.say, mood: ok.mood, reasoning: ok.reasoning });
    expect(parseChatAnswer('```json\n' + JSON.stringify(ok) + '\n```', keys)?.choice).toBe('call');
    const long = parseChatAnswer(JSON.stringify({ ...ok, say: 'x'.repeat(500), reasoning: 'y'.repeat(5000) }), keys)!;
    expect(long.say).toHaveLength(MAX_SAY);
    expect(long.reasoning).toHaveLength(MAX_REASONING);
  });

  it('refuses anything else, so the fallback plays', () => {
    const bad = [
      'call',
      '[]',
      JSON.stringify({ ...ok, action: 'allin' }),
      JSON.stringify({ ...ok, action: undefined }),
      JSON.stringify({ ...ok, mood: 'furious' }),
      JSON.stringify({ ...ok, say: 3 }),
      JSON.stringify({ ...ok, reasoning: null }),
    ];
    for (const content of bad) expect(parseChatAnswer(content, keys), content).toBeNull();
  });

  it('reads both kinds of answer into a move, or the reason there is none', () => {
    const options = ['fold', 'call', 'half'] as const;
    expect(readAnswer({ type: 'choice', choice: 'half', probabilities: { half: 0.6, call: 0.3, allin: 0.1, fold: 7 } }, options)).toEqual({ key: 'half', probabilities: { half: 0.6, call: 0.3 } });
    expect(readAnswer({ type: 'choice', choice: 'call', say: 'Fine.', mood: 'smug', reasoning: 'Cheap.' }, options)).toEqual({ key: 'call', say: 'Fine.', mood: 'smug', reasoning: 'Cheap.' });
    expect(readAnswer({ ...REFUSAL }, options)).toEqual({ why: 'refusal' });
    for (const a of [null, {}, { type: 'choice', choice: 'pot' }, { choice: 'call' }]) expect(readAnswer(a, options)).toEqual({ why: 'invalid' });
  });
});

describe('a live table', () => {
  const q = requestFor(observe(act(deal({ stacks: [200, 200] }), 'call'), 1)).questions[QUESTION]!;
  const live = { names: ['Opus 5.5', 'Sol'], talk: [] };

  it('asks with the live-table words only when there is a table context; the bench keeps its own', () => {
    expect(chatFormatFor()).toBe(CHAT_FORMAT);
    expect(chatFormatFor(live)).toBe(LIVE_CHAT_FORMAT);
    expect(chatFormatFor({})).toBe(LIVE_CHAT_FORMAT);
    const [benchSystem, benchUser] = CHAT_FORMAT.messages({ a: 1 }, q);
    const [liveSystem, liveUser] = LIVE_CHAT_FORMAT.messages({ a: 1 }, q);
    expect(benchSystem!.content).toBe(CHAT_SYSTEM);
    expect(benchSystem!.content).not.toContain(LIVE_TABLE);
    expect(liveSystem!.content).toBe(LIVE_CHAT_SYSTEM);
    expect(liveSystem!.content.endsWith(LIVE_TABLE)).toBe(true);
    // The question itself is the same; only the system message differs.
    expect(liveUser).toEqual(benchUser);
  });

  it('is the same text for every model: the format has no say in who is asked', () => {
    const asked = CHAT_MODELS.map(() => LIVE_CHAT_FORMAT.messages({ a: 1 }, q)[0]!.content);
    expect(new Set(asked)).toEqual(new Set([LIVE_CHAT_SYSTEM]));
    for (const m of CHAT_MODELS) expect(LIVE_CHAT_SYSTEM).not.toContain(m.name);
  });

  it('asks for talk on every action and the whole range of faces, with no poker advice and nothing about hiding cards', () => {
    expect(LIVE_TABLE).toMatch(/audience/);
    expect(LIVE_TABLE).toMatch(/on every action, say something out loud/i);
    for (const mood of ['annoyed', 'nervous', 'smug']) expect(LIVE_TABLE).toContain(mood);
    expect(LIVE_TABLE).not.toMatch(/fold|call|raise|bet|equity|odds|position|should|strong|weak|cards|hand\b|reveal|hide/i);
    expect(LIVE_TABLE.length).toBeLessThan(450);
  });

  it('lists the moods in a neutral (alphabetical) order, in the description and the schema', () => {
    expect(LIVE_CHAT_SYSTEM).toContain('one of annoyed, confident, nervous, relaxed, smug.');
    const f = LIVE_CHAT_FORMAT.responseFormat(q) as { json_schema: { schema: { properties: { mood: { enum: string[] } } } } };
    expect(f.json_schema.schema.properties.mood.enum).toEqual(['annoyed', 'confident', 'nervous', 'relaxed', 'smug']);
    // Answers are read the same way at a live table.
    const reply = JSON.stringify({ action: 'check', say: 'Your move.', mood: 'smug', reasoning: 'Free card.', turn_complete: true });
    expect(LIVE_CHAT_FORMAT.parse(reply, q)).toEqual(CHAT_FORMAT.parse(reply, q));
  });
});

describe('the models', () => {
  it('lists each chat model once with the 20 s time bank, each decision model with 2.5 s, and every set seat', () => {
    const ids = HOLDEM_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of HOLDEM_MODELS) expect(m.timeoutMs).toBe(m.kind === 'chat' ? 20_000 : 2500);
    expect(Object.fromEntries(SETS.map((s) => [s.id, s.models.length]))).toEqual({ decision: 3, claude: 3, gpt: 3, gemini: 3, open: 3, titans: 3 });
    expect(SETS.find((s) => s.id === 'open')!.models).toEqual(['nebius/deepseek-ai/DeepSeek-V4-Pro-0813', 'sference/kimi-k3', 'inceptron/zai-org/GLM-5.3']);
    expect(SETS.find((s) => s.id === 'gemini')!.models).toEqual(['vertexai/gemini-3.1-pro-preview', 'vertexai/gemini-3.8-flash-eu', 'vertexai/gemini-3.5-flash-lite-eu']);
    expect(SETS.find((s) => s.id === 'titans')!.models).toEqual(['anthropic/claude-fable-5-1', 'azure/gpt-6-astra-global', 'vertexai/gemini-4-argon-eu']);
    expect(CHAT_MODELS.map((m) => m.name)).toEqual([
      'Haiku 5.5', 'Sonnet 5.5', 'Opus 5.5', 'GPT-6 Luna', 'GPT-5.6 Terra', 'GPT-6.1 Sol', 'Gemini 3.1 Pro', 'Gemini 3.8 Flash', 'Gemini 3.5 Flash Lite', 'Fable 5.1', 'GPT-6 Astra', 'Gemini 4 Argon',
      'Grok 4.7', 'DeepSeek V4.1 Flash', 'DeepSeek V4 Pro', 'Qwen3.8 Flash-Next', 'Qwen3.8 Max', 'Kimi K3', 'GLM-5.3 Flash', 'GLM-5.3', 'MiniMax M3',
    ]);
    // The models outside the sets sit at no preset table.
    for (const id of ['xai/grok-4.7', 'melious/deepseek-v4.1-flash', 'nebius/MiniMaxAI/MiniMax-M3']) expect(HOLDEM_MODELS.find((m) => m.id === id)!.sets).toEqual([]);
  });

  it('asks each chat model at low reasoning effort, unless its route needs none or none sent', () => {
    const effort = Object.fromEntries(CHAT_MODELS.map((m) => [m.id, m.reasoningEffort ?? null]));
    // Vertex's Gemini refuses low (it takes a thinking level), Nebius's MiniMax does not think: no effort sent.
    expect(effort['vertexai/gemini-4-argon-eu']).toBeNull();
    expect(effort['nebius/MiniMaxAI/MiniMax-M3']).toBeNull();
    // At low these think past the time bank on the turn and river.
    for (const id of ['melious/deepseek-v4.1-flash', 'nebius/deepseek-ai/DeepSeek-V4-Pro-0813', 'tensorx/qwen/qwen3.8-flash-next', 'alibaba:global/qwen3.8-max']) expect(effort[id], id).toBe('none');
    const special = new Set(['vertexai/gemini-4-argon-eu', 'nebius/MiniMaxAI/MiniMax-M3', 'melious/deepseek-v4.1-flash', 'nebius/deepseek-ai/DeepSeek-V4-Pro-0813', 'tensorx/qwen/qwen3.8-flash-next', 'alibaba:global/qwen3.8-max']);
    for (const m of CHAT_MODELS) if (!special.has(m.id)) expect(m.reasoningEffort, m.id).toBe('low');
    // The request leaves reasoning_effort out when there is none.
    expect(chatRequestBody({ model: 'nebius/MiniMaxAI/MiniMax-M3', maxTokens: 4000 }, [], {})).not.toHaveProperty('reasoning_effort');
    expect(chatRequestBody({ model: 'sference/kimi-k3', reasoningEffort: 'low' }, [], {})).toMatchObject({ reasoning_effort: 'low' });
  });

  it('has an avatar for every model, keyed by the same id', () => {
    const index = JSON.parse(readFileSync(new URL('../public/avatars/index.json', import.meta.url), 'utf8')) as Record<string, { slug: string }>;
    for (const m of HOLDEM_MODELS) expect(index[m.id], m.id).toBeDefined();
  });
});

describe('clipSay', () => {
  it('keeps short lines and cuts long ones at a word boundary with an ellipsis', async () => {
    const { clipSay, MAX_SAY } = await import('../shared/questions.ts');
    expect(clipSay('  Pay the man.  ')).toBe('Pay the man.');
    const long = 'Third diamond on the board and I still like my hand, but I hope that top kicker survives the river card';
    const cut = clipSay(long);
    expect(cut.length).toBeLessThanOrEqual(MAX_SAY);
    expect(cut.endsWith('…')).toBe(true);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    expect(long[cut.length - 1]).toBe(' ');
    expect(clipSay('x'.repeat(200)).length).toBe(MAX_SAY);
  });
});
