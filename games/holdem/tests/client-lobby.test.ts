import { describe, expect, it } from 'vitest';
import { GROUP_NAMES, GROUPS, MODELS, SETS } from '../src/roster';
import { needsSignIn, nextSeat, seatRange } from '../src/views/lobby';

const set = (id: string) => SETS.find((s) => s.id === id)!.models;

describe('the lobby: who can start what', () => {
  it('asks a signed-out visitor to sign in for any table with a chat model, and lets the decision set play free', () => {
    const signedOut = { chat: false, decision: true };
    expect(needsSignIn(set('decision'), signedOut)).toBe(false);
    for (const id of ['claude', 'gpt', 'gemini', 'open', 'titans']) expect(needsSignIn(set(id), signedOut)).toBe(true);
    // A mixed table: one chat seat is enough, from any group.
    expect(needsSignIn(['sference/clef', 'aws/claude-opus-5-5'], signedOut)).toBe(true);
    for (const id of ['xai/grok-4.7', 'melious/deepseek-v4.1-flash', 'inceptron/zai-org/GLM-5.3-Flash', 'nebius/MiniMaxAI/MiniMax-M3']) expect(needsSignIn(['sference/clef', id], signedOut), id).toBe(true);
  });

  it('lets a signed-in player (or the local key) start anything, and asks for a sign-in when the free credits are spent', () => {
    for (const id of ['decision', 'claude', 'gpt', 'gemini', 'open', 'titans']) expect(needsSignIn(set(id), { chat: true, decision: true })).toBe(false);
    expect(needsSignIn(set('decision'), { chat: false, decision: false })).toBe(true);
    // Not known yet: the table answers for itself.
    expect(needsSignIn(set('titans'), undefined)).toBe(false);
  });
});

describe('the seat picker', () => {
  it('lists every model once, in its group: the sets, then the other chat models', () => {
    expect(GROUPS.map((g) => GROUP_NAMES[g])).toEqual(['Decision models', 'Claude', 'GPT', 'Gemini', 'Titans', 'More chat models']);
    const names = (g: string) => MODELS.filter((m) => m.group === g).map((m) => m.name);
    expect(names('gemini')).toEqual(['Gemini 3.1 Pro', 'Gemini 3.8 Flash', 'Gemini 3.5 Flash Lite']);
    // Argon stays a titan.
    expect(names('titan')).toEqual(['Fable 5.1', 'GPT-6 Astra', 'Gemini 4 Argon']);
    expect(names('more')).toEqual(['Grok 4.7', 'DeepSeek V4.1 Flash', 'DeepSeek V4 Pro', 'Qwen3.8 Flash-Next', 'Qwen3.8 Max', 'Kimi K3', 'GLM-5.3 Flash', 'GLM-5.3', 'MiniMax M3']);
    expect(GROUPS.flatMap((g) => MODELS.filter((m) => m.group === g)).length).toBe(MODELS.length);
    expect(SETS.map((s) => s.name)).toEqual(['Decision', 'Open models', 'Titans', 'Gemini', 'Claude', 'GPT']);
    expect(SETS.filter((s) => s.free).map((s) => s.id)).toEqual(['decision']);
    expect(SETS.find((s) => s.id === 'titans')!.blurb).toBe('Fable, Astra and Argon. Big, expensive, very good.');
  });
});

describe('how many seats', () => {
  it('seats you and one to five models, or two to six models watching', () => {
    expect(seatRange('play')).toEqual({ min: 1, max: 5 });
    expect(seatRange('watch')).toEqual({ min: 2, max: 6 });
  });
});

describe('an added seat', () => {
  it('starts with another model of the last seat’s family, one not at the table yet, else any free one', () => {
    const groupOf = (id: string) => MODELS.find((m) => m.id === id)!.group;
    const lineup = set('decision').slice(0, 2);
    const added = nextSeat(lineup);
    expect(lineup).not.toContain(added);
    expect(groupOf(added)).toBe(groupOf(lineup.at(-1)!));
    // Every model of that family taken: the first free one of any.
    const family = MODELS.filter((m) => m.group === groupOf(lineup.at(-1)!)).map((m) => m.id);
    expect(family).not.toContain(nextSeat(family));
    expect(nextSeat(MODELS.map((m) => m.id).slice(0, -1))).toBe(MODELS.at(-1)!.id);
  });
});
