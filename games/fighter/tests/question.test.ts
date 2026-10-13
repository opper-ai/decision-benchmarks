import { describe, expect, it } from 'vitest';
import { isActionable, newGame, step, type GameState, type Inputs } from '../shared/engine/engine.ts';
import { fallbackMove } from '../shared/fallback.ts';
import { buildQuestion, questionTokens, REACTION_TICKS, simulateExchange } from '../shared/question.ts';
import { Perception } from '../shared/view.ts';

function fight(g: number, seed = 1): GameState {
  const s = newGame(seed);
  while (s.round.phase !== 'fight') step(s);
  s.fighters[0].x = 5000 - g / 2;
  s.fighters[1].x = 5000 + g / 2;
  return s;
}

describe('questions', () => {
  it('stay within their token budgets', () => {
    for (const g of [800, 1200, 2000, 3500]) {
      const s = fight(g);
      expect(questionTokens(buildQuestion(s, 0, { track: 'assisted' }))).toBeLessThan(1000);
      expect(questionTokens(buildQuestion(s, 0, { track: 'raw' }))).toBeLessThan(750);
      expect(questionTokens(buildQuestion(s, 0, { track: 'assisted', maxTokens: 440 }))).toBeLessThanOrEqual(440);
    }
  });

  it('show a typical and a worst-case column, never a single answer', () => {
    const q = buildQuestion(fight(1000), 0);
    expect(q.columns).toEqual(['avg', 'worst']);
    for (const o of q.options) {
      expect(o.payoff?.stand).toBeDefined();
      expect(o.payoff?.worst).toBeLessThanOrEqual(o.payoff!.stand!);
      expect(o.facts).toMatch(/adv [+-]?\d+f/);
    }
  });

  it('count the punishment of a whiffed or blocked move', () => {
    // A sweep from 1.1 against a standing opponent hits, but a fast answer punishes it.
    const s = fight(1100);
    const stand = simulateExchange(s, 0, 'sweep', 'stand')!;
    expect(stand.swing).toBeGreaterThan(0);
    expect(stand.adv).toBeGreaterThan(0);
    const blocked = simulateExchange(s, 0, 'sweep', 'block_low')!;
    expect(blocked.adv).toBeLessThan(0);
  });

  it('let a busy opponent reply when it can act, instead of freezing it', () => {
    const s = fight(1000);
    step(s, [null, 'high_kick']);
    for (let t = 0; t < 5; t++) step(s);
    expect(isActionable(s, 0)).toBe(true);
    const x = simulateExchange(s, 0, 'block_high', 'sweep');
    expect(x).not.toBeNull();
  });

  it('shuffle option order between questions', () => {
    const orders = new Set<string>();
    for (let seed = 1; seed < 8; seed++) orders.add(buildQuestion(fight(1000, seed), 0).options.map((o) => o.id).join(','));
    expect(orders.size).toBeGreaterThan(3);
  });

  it('hide an opponent move started inside the reaction time', () => {
    const s = fight(1000);
    const p = new Perception();
    const tick = (inputs: Inputs) => {
      p.record(s, inputs);
      step(s, inputs);
    };
    for (let t = 0; t < REACTION_TICKS; t++) tick([null, null]);
    tick([null, 'sweep']);
    for (let t = 0; t < REACTION_TICKS - 3; t++) tick([null, null]);
    expect(buildQuestion(p.view(s, 0), 0).context.opponent).toMatch(/standing/);
    for (let t = 0; t < 4; t++) tick([null, null]);
    expect(buildQuestion(p.view(s, 0), 0).context.opponent).toMatch(/attacking with sweep/);
  });

  it('the fallback only ever guards', () => {
    expect(fallbackMove(fight(1000), 0)).toBe('block_high');
  });
});
