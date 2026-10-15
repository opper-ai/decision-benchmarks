import { describe, expect, it } from 'vitest';
import { keyFromSeed } from '../shared/rng';
import { decodeAction, encodeAction, parseState, rebuild, type TableState } from '../server/token';

const state = (over: Partial<TableState> = {}): TableState => ({ v: 2, id: 'x', key: keyFromSeed(42), mode: 'play', seats: [null, 'sference/clef'], log: [''], meta: [], at: 0, exp: 1, ...over });

describe("the table token's contents", () => {
  it('writes each action in a few characters and reads it back for the seat that made it', () => {
    expect(encodeAction({ key: 'three_quarters', by: 'answer' })).toBe('t');
    expect(encodeAction({ key: 'check', by: 'fallback', why: 'timeout' })).toBe('Xt');
    expect(encodeAction({ key: 'fold', by: 'fallback', why: 'refusal' })).toBe('Fr');
    expect(encodeAction({ to: 450, by: 'human' })).toBe('r450');
    expect(decodeAction('t', 1, false)).toEqual({ seat: 1, key: 'three_quarters', by: 'answer' });
    expect(decodeAction('t', 0, true)).toEqual({ seat: 0, key: 'three_quarters', by: 'human' });
    expect(decodeAction('Xt', 1, false)).toEqual({ seat: 1, key: 'check', by: 'fallback', why: 'timeout' });
    expect(decodeAction('r450', 0, true)).toEqual({ seat: 0, to: 450, by: 'human' });
    // A human has no fallback, and a model no raise to an amount of its own.
    for (const [code, human] of [['Xt', true], ['r450', false], ['q', false], ['Ct', false], ['', true]] as const) expect(decodeAction(code, 0, human)).toBeNull();
  });

  it('refuses contents this server would not seal: another version, unknown models, the wrong number of humans', () => {
    expect(parseState(state())).not.toBeNull();
    expect(parseState(state({ v: 1 as 2 }))).toBeNull();
    expect(parseState(state({ seats: [null, 'openai/gpt-4o'] }))).toBeNull();
    expect(parseState(state({ seats: [null, null] }))).toBeNull();
    expect(parseState(state({ mode: 'watch' }))).toBeNull();
    expect(parseState(state({ log: [] }))).toBeNull();
    // 2 to 6 seats.
    const clef = 'sference/clef';
    expect(parseState(state({ seats: [null, clef, clef, clef, clef, clef] }))).not.toBeNull();
    expect(parseState(state({ mode: 'watch', seats: [clef, clef, clef, clef, clef, clef] }))).not.toBeNull();
    expect(parseState(state({ seats: [null, clef, clef, clef, clef, clef, clef] }))).toBeNull();
    expect(parseState(state({ seats: [null] }))).toBeNull();
    expect(parseState(null)).toBeNull();
  });

  it('rebuilds the table from its seed and actions, and refuses actions that do not replay', () => {
    const t = rebuild(state({ log: ['c'] }));
    expect(t.hands[0]).toHaveLength(1);
    expect(() => rebuild(state({ log: ['c', 'x'] }))).toThrow(/stops before it ended/);
    expect(() => rebuild(state({ log: ['zz'] }))).toThrow(/no action/);
    // A six-seat table: every seat folds round to the big blind.
    const six = rebuild(state({ seats: [null, 'sference/clef', 'sference/clef', 'sference/clef', 'sference/clef', 'sference/clef'], log: ['f,f,f,f,f', ''] }));
    expect(six.g.hand.seats).toHaveLength(6);
    expect(six.g.handIndex).toBe(1);
    expect(six.g.hand.level).toMatchObject({ hand: 2, handsUntilNextLevel: 11 });
  });
});
