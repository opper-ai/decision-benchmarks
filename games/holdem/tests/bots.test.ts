import { describe, expect, it } from 'vitest';
import { parseCards } from '../shared/cards';
import { BOT_NAMES, botDecide, chenScore, equity, fallbackKey, type BotName } from '../shared/bots';
import { applyAction, legalOptions, newHand, observe, toAct, type HandState, type OptionKey } from '../shared/engine';
import { mulberry32, nextInt } from '../shared/rng';
import { act, deal } from './support';

const chen = (text: string) => chenScore(parseCards(text)[0]!, parseCards(text)[1]!);
const FOUR = [1500, 1500, 1500, 1500];
const decide = (name: BotName, s: HandState) => botDecide(name, observe(s, toAct(s)!));

describe('the preflop score (Chen)', () => {
  it('scores the reference hands', () => {
    expect(chen('As Ad')).toBe(20);
    expect(chen('Ks Kd')).toBe(16);
    expect(chen('2s 2d')).toBe(5);
    expect(chen('As Ks')).toBe(12);
    expect(chen('Ad Ks')).toBe(10);
    expect(chen('Js Ts')).toBe(9);
    expect(chen('7c 2d')).toBe(-1);
    expect(chen('5h 7h')).toBe(6);
    expect(chen('Ks Kd')).toBe(chen('Kd Ks'));
  });
});

describe('equity', () => {
  it('samples run-outs against random hands', () => {
    expect(equity(parseCards('As Ad'), [], 1, 4000, 1)).toBeCloseTo(0.85, 1);
    expect(equity(parseCards('7c 2d'), [], 1, 4000, 1)).toBeCloseTo(0.35, 1);
    expect(equity(parseCards('As Ad'), [], 3, 4000, 1)).toBeCloseTo(0.64, 1);
    expect(equity(parseCards('As Ks'), parseCards('Qs Js Ts 2c 3d'), 2, 200, 1)).toBe(1);
    expect(equity(parseCards('As Ks'), parseCards('Qs Js Ts'), 1, 200, 9)).toBe(equity(parseCards('As Ks'), parseCards('Qs Js Ts'), 1, 200, 9));
  });
});

describe('the bots', () => {
  it('rock: raises big pairs, folds rags to a raise, folds a weak hand to a bet', () => {
    expect(decide('rock', deal({ stacks: FOUR, holes: { 3: 'As Ad' } }))).toBe('small');
    expect(decide('rock', act(deal({ stacks: FOUR, holes: { 0: '7c 2d' } }), 100))).toBe('fold');
    const flop = act(deal({ stacks: FOUR, holes: { 1: '7c 2d' }, board: 'As Kd Qh 9s 3c' }), 'call', 'call', 'call', 'check', 'check', 'pot', 'fold', 'fold');
    expect(toAct(flop)).toBe(1);
    expect(decide('rock', flop)).toBe('fold');
  });

  it('station: calls a bet with any pair, folds nothing at all', () => {
    const spot = (hole: string, board: string) => act(deal({ stacks: FOUR, holes: { 1: hole }, board }), 'call', 'call', 'call', 'check', 'check', 'half', 'fold', 'fold');
    expect(decide('station', spot('7c 3d', 'As Kd 7h 9s 2c'))).toBe('call');
    expect(decide('station', spot('2c 3d', 'As Kd 9h Js Tc'))).toBe('fold');
    // A flush draw is enough to call.
    expect(decide('station', spot('2h 3h', 'Ah Kh 9c Js Tc'))).toBe('call');
  });

  it('maniac: raises from the start with almost anything playable', () => {
    expect(['small', 'half', 'three_quarters', 'pot', 'allin']).toContain(decide('maniac', deal({ stacks: FOUR, holes: { 3: 'Ks Qd' } })));
  });

  it('decide only from what the player sees: hidden cards change nothing', () => {
    const a = act(deal({ stacks: FOUR, holes: { 0: 'Jc Td', 2: 'As Ad' }, board: '2c 7d 9h Jh 3s' }), 'call', 'call', 'call', 'check', 'check', 'check', 'check');
    const b = act(deal({ stacks: FOUR, holes: { 0: 'Jc Td', 2: '4s 5d' }, board: '2c 7d 9h Jh 3s' }), 'call', 'call', 'call', 'check', 'check', 'check', 'check');
    expect(observe(a, 0)).toEqual(observe(b, 0));
    for (const name of BOT_NAMES) expect(decide(name, a)).toBe(decide(name, b));
  });

  it('always pick a legal option, the same one every time, and play to type', () => {
    const stats = Object.fromEntries(BOT_NAMES.map((n) => [n, { raises: 0, folds: 0, facing: 0, decisions: 0 }]));
    for (let i = 0; i < 400; i++) {
      let s = newHand({ stacks: FOUR, button: i % 4, sb: 10, bb: 20, deckSeed: mulberry32(i)[1] });
      let r = i;
      while (toAct(s) !== null) {
        const o = observe(s, toAct(s)!);
        for (const name of BOT_NAMES) {
          const key = botDecide(name, o);
          expect(o.options.map((x) => x.key)).toContain(key);
          expect(botDecide(name, o)).toBe(key);
          const st = stats[name]!;
          st.decisions++;
          if (['small', 'half', 'three_quarters', 'pot', 'allin'].includes(key)) st.raises++;
          if (o.toCall > 0) {
            st.facing++;
            if (key === 'fold') st.folds++;
          }
        }
        // The hand goes on with a random option, so the bots see all kinds of spots.
        let k: number;
        [k, r] = nextInt(r, o.options.length);
        s = applyAction(s, { key: o.options[k]!.key });
      }
    }
    const rate = (n: BotName, f: 'raises' | 'folds') => stats[n]![f] / stats[n]![f === 'raises' ? 'decisions' : 'facing'];
    expect(rate('maniac', 'raises')).toBeGreaterThan(2 * rate('rock', 'raises'));
    expect(rate('maniac', 'raises')).toBeGreaterThan(2 * rate('station', 'raises'));
    expect(rate('station', 'folds')).toBeLessThan(rate('rock', 'folds'));
    expect(rate('rock', 'folds')).toBeGreaterThan(0.5);
  });

  it('random: picks every option sometimes', () => {
    const seen = new Set<OptionKey>();
    for (let i = 0; i < 300; i++) seen.add(decide('random', newHand({ stacks: FOUR, button: 0, sb: 10, bb: 20, deckSeed: i })));
    expect(seen).toEqual(new Set(legalOptions(newHand({ stacks: FOUR, button: 0, sb: 10, bb: 20, deckSeed: 0 })).map((o) => o.key)));
  });
});

describe('the fallback', () => {
  it('checks when it is free, else folds', () => {
    expect(fallbackKey(legalOptions(deal({ stacks: FOUR })))).toBe('fold');
    expect(fallbackKey(legalOptions(act(deal({ stacks: FOUR }), 'call', 'call', 'call')))).toBe('check');
  });
});
