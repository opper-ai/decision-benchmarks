import { describe, expect, it } from 'vitest';
import { legalOptions, visibleEvents } from '../shared/engine';
import { LocalDriver } from '../src/local-driver';
import { applyEvent, emptyModel } from '../src/table-model';
import { actionText, cardFace, chips, chipStack, hueOf, levelText, menuButtons, ordinal, personOf, potLabels, slotsFor, tellBars } from '../src/view-model';
import { placeholderFace } from '../src/views/parts';
import { act, deal } from './support';

describe('view model', () => {
  it('seats the viewer at the bottom and the others clockwise', () => {
    expect(slotsFor(4, 2)).toEqual(['top', 'right', 'bottom', 'left']);
    expect(slotsFor(4, null)).toEqual(['bottom', 'left', 'top', 'right']);
    expect(slotsFor(3, 0)).toEqual(['bottom', 'top-left', 'top-right']);
    expect(slotsFor(2, 1)).toEqual(['top', 'bottom']);
    expect(() => slotsFor(5, 0)).toThrow();
  });

  it('writes actions, cards, levels and places as people read them', () => {
    expect(actionText({ kind: 'raise', to: 1200, add: 1100, allIn: false })).toBe('raises to 1,200');
    expect(actionText({ kind: 'call', to: 300, add: 280, allIn: true })).toBe('calls 280, all-in');
    expect(actionText({ kind: 'allin', to: 1500, add: 1500, allIn: true })).toBe('is all-in for 1,500');
    expect(actionText({ kind: 'check', to: 0, add: 0, allIn: false })).toBe('checks');
    expect(actionText({ kind: 'raise', to: 1200, add: 1100, allIn: false }, true)).toBe('raise to 1,200');
    expect(actionText({ kind: 'allin', to: 1500, add: 1500, allIn: true }, true)).toBe('are all-in for 1,500');
    expect(actionText({ kind: 'call', to: 300, add: 280, allIn: true }, true)).toBe('call 280, all-in');
    expect(cardFace('Td')).toEqual({ rank: '10', suit: '♦', red: true, label: 'Ten of diamonds' });
    expect(cardFace('As')).toMatchObject({ rank: 'A', suit: '♠', red: false });
    expect(() => cardFace('1x')).toThrow();
    expect(levelText({ hand: 7, level: 1, sb: 10, bb: 20, ante: 0, handsUntilNextLevel: 2, next: { sb: 15, bb: 30, ante: 0 } })).toEqual({ blinds: '10/20', next: '15/30 in 2 hands' });
    expect(levelText({ hand: 48, level: 6, sb: 100, bb: 200, ante: 25, handsUntilNextLevel: 1, next: { sb: 150, bb: 300, ante: 38 } })).toEqual({ blinds: '100/200, ante 25', next: '150/300 next hand' });
    expect([1, 2, 3, 4, 11, 12, 13, 21].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st']);
    expect(chips(6000)).toBe('6,000');
    expect(potLabels([{ amount: 300, eligible: [0, 1, 2] }, { amount: 80, eligible: [0, 1] }])).toEqual([{ label: 'Pot', amount: 300 }, { label: 'Side pot', amount: 80 }]);
  });

  it('folds probabilities into the tell meter', () => {
    expect(tellBars({ fold: 0.2, call: 0.3, half: 0.25, allin: 0.25 })).toEqual({ fold: 0.2, call: 0.3, raise: 0.5 });
    expect(tellBars({ check: 1 })).toEqual({ fold: 0, call: 1, raise: 0 });
    expect(tellBars(undefined)).toBeNull();
    expect(tellBars({})).toBeNull();
  });

  it('draws a chip stack from big chips down, capped', () => {
    expect(chipStack(1635)).toEqual(['gold', 'violet', 'black', 'green', 'red', 'red']);
    expect(chipStack(1635, 3)).toEqual(['gold', 'violet', 'black']);
    expect(chipStack(0)).toEqual([]);
  });

  it('names who sits where', () => {
    expect(personOf({ kind: 'human', id: 'you' })).toMatchObject({ name: 'You', slug: null });
    expect(personOf({ kind: 'bot', id: 'maniac' })).toMatchObject({ name: 'Maniac', badge: 'Bot' });
    expect(personOf({ kind: 'model', id: 'aws/claude-opus-5-5' })).toEqual({ name: 'Opus 5.5', short: 'Opus', tag: 'Claude 5.5', badge: 'Claude', slug: 'anthropic-claude-opus-5-5', style: 'chat' });
    expect(personOf({ kind: 'model', id: 'sference/clef' })).toMatchObject({ badge: 'Decision model', style: 'decision' });
    expect(personOf({ kind: 'model', id: 'azure/gpt-6-astra-global' })).toMatchObject({ badge: 'Titan', short: 'Astra', tag: 'GPT-6' });
    expect(personOf({ kind: 'model', id: 'openai/gpt-6-luna-decisions' })).toMatchObject({ short: 'Luna', tag: 'GPT-6 Decisions' });
    expect(personOf({ kind: 'model', id: 'vertexai/gemini-4-argon-eu' })).toEqual({ name: 'Gemini 4 Argon', short: 'Argon', tag: 'Gemini 4', badge: 'Titan', slug: 'google-gemini-4-argon', style: 'chat' });
    expect(personOf({ kind: 'model', id: 'vertexai/gemini-3.8-flash-eu' })).toEqual({ name: 'Gemini 3.8 Flash', short: 'Flash', tag: 'Gemini 3.8', badge: 'Gemini', slug: 'google-gemini-3-8-flash', style: 'chat' });
    // Outside the sets, the badge is the maker.
    expect(personOf({ kind: 'model', id: 'nebius/deepseek-ai/DeepSeek-V4-Pro-0813' })).toMatchObject({ name: 'DeepSeek V4 Pro', short: 'V4 Pro', tag: 'DeepSeek', badge: 'DeepSeek', slug: 'deepseek-v4-pro' });
    expect(personOf({ kind: 'model', id: 'inceptron/zai-org/GLM-5.3' })).toMatchObject({ badge: 'Zhipu', short: 'GLM' });
  });
});

describe('table model', () => {
  it('follows a hand event by event: blinds, bets, the street gathering bets, the uncalled bet back, the pot paid', () => {
    let s = deal({ stacks: [1000, 1000], holes: { 0: 'As Ad', 1: 'Ks Kd' }, board: '2c 7d 9s 3h 4c' });
    s = act(s, 'call', 'check', 'check', 'pot', 'fold');
    const steps = s.events.reduce((acc, e) => [...acc, applyEvent(acc.at(-1)!, e)], [emptyModel(2)]);
    const afterBlinds = steps[3]!;
    expect(afterBlinds.seats.map((p) => p.bet)).toEqual([10, 20]);
    const end = steps.at(-1)!;
    expect(end.street).toBe('done');
    expect(end.middle).toBe(0);
    expect(end.seats.map((p) => p.stack)).toEqual(s.seats.map((p) => p.stack));
    expect(end.seats[1]!.folded).toBe(true);
    expect(end.seats[0]!.won).toBe(40); // the blinds; the uncalled pot bet went back
    expect(end.board).toEqual(['2c', '7d', '9s']);
  });

  it('keeps every chip on the table through whole Sit & Gos, and hides cards the viewer may not see', async () => {
    const d = new LocalDriver({ thinkScale: 0, sleep: async () => {} });
    let snap = await d.start({ seed: 77, seats: [{ kind: 'bot', id: 'maniac' }, { kind: 'bot', id: 'station' }, { kind: 'bot', id: 'rock' }, { kind: 'bot', id: 'random' }] });
    while (!(snap.view.street === 'done' && snap.over)) snap = snap.view.street === 'done' ? await d.nextHand() : (await d.step()).snapshot;
    const review = await d.review();
    for (const h of review.hands) {
      let m = emptyModel(4);
      for (const e of h.events) {
        m = applyEvent(m, e);
        expect(m.seats.reduce((a, p) => a + p.stack + p.bet, 0) + m.middle).toBe(6000);
      }
      const end = h.events.find((e) => e.type === 'end')!;
      expect(m.seats.map((p) => p.stack)).toEqual(end.type === 'end' && end.stacks);
      const hidden = visibleEvents(h.events, 0).reduce(applyEvent, emptyModel(4));
      const shown = new Set(h.events.flatMap((e) => (e.type === 'showdown' ? e.hands.map((x) => x.seat) : [])));
      hidden.seats.forEach((p, seat) => {
        if (seat !== 0 && p.dealt && !shown.has(seat)) expect(p.cards).toEqual([]);
      });
    }
  });
});

describe('the action menu', () => {
  it('turns the legal options into buttons with amounts and shortcuts', () => {
    let s = deal({ stacks: [1000, 1000, 1000], button: 0, holes: { 0: 'As Ad' } });
    // Three-handed, the button acts first before the flop, facing the big blind.
    const buttons = menuButtons(legalOptions(s));
    expect(buttons.map((b) => [b.key, b.look, b.what, b.amount, b.shortcut])).toEqual([
      ['fold', 'fold', 'Fold', '', 'F'],
      ['call', 'call', 'Call', '20', 'C'],
      // Half the pot (45) is less than 2.5 big blinds here, so the smallest size is half the pot.
      ['small', 'raise', 'Raise to ½ pot', '45', null],
      ['three_quarters', 'raise', 'Raise to ¾ pot', '58', null],
      ['pot', 'raise', 'Raise to Pot', '70', null],
      ['allin', 'allin', 'All-in', '1,000', 'A'],
    ]);
    s = act(s, 'call', 'call', 'check');
    expect(menuButtons(legalOptions(s)).map((b) => b.what)).toEqual(['Check', 'Bet ⅓ pot', 'Bet ½ pot', 'Bet ¾ pot', 'Bet Pot', 'All-in']);
  });
});

describe('pots in the table model', () => {
  it('match the engine’s main and side pots at every step of whole games', async () => {
    const { potsOfModel, modelOf } = await import('../src/table-model');
    let checked = 0;
    let sides = 0;
    for (const seed of [3, 4, 5]) {
      const d = new LocalDriver({ thinkScale: 0, sleep: async () => {} });
      let snap = await d.start({ seed, seats: [{ kind: 'bot', id: 'maniac' }, { kind: 'bot', id: 'station' }, { kind: 'bot', id: 'rock' }, { kind: 'bot', id: 'maniac' }] });
      while (!(snap.view.street === 'done' && snap.over)) {
        if (snap.view.street === 'done') snap = await d.nextHand();
        else {
          snap = (await d.step()).snapshot;
          if (snap.view.street === 'done') continue;
          const mine = potsOfModel(modelOf(4, snap.events));
          expect(mine).toEqual(snap.view.pots.map((p) => ({ amount: p.amount, eligible: p.eligible })));
          checked++;
          if (mine.length > 1) sides++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(sides).toBeGreaterThan(0);
  });
});

describe('a face that has not loaded yet', () => {
  it('has a colour of its own, the same every time', () => {
    const hues = ['openai-gpt-6-luna-decisions', 'berget-convaiinnovations-laya', 'sference-clef'].map(hueOf);
    expect(hues.every((x) => Number.isInteger(x) && x >= 0 && x < 360)).toBe(true);
    expect(new Set(hues).size).toBe(3);
    expect(hueOf('berget-convaiinnovations-laya')).toBe(hues[1]);
  });

  it('stands in as a disc in that colour with the short name’s first letter', () => {
    const laya = personOf({ kind: 'model', id: 'berget/convaiinnovations/laya' });
    const svg = decodeURIComponent(placeholderFace(laya).replace('data:image/svg+xml,', ''));
    expect(svg).toContain(`hsl(${hueOf(laya.slug!)} `);
    expect(svg).toMatch(/>L<\/text>/);
  });
});
