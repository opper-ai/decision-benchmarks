import { describe, expect, it } from 'vitest';
import { formatCards } from '../shared/cards';
import { chipsOf, dealOrder, fullView, legalOptions, newHand, observe, publicView, toAct, type HandEvent, type HandState } from '../shared/engine';
import { act, deal, stackDeck } from './support';

const keysOf = (s: HandState) => legalOptions(s).map((o) => o.key);
const opt = (s: HandState, key: string) => legalOptions(s).find((o) => o.key === key);
const ofType = <T extends HandEvent['type']>(s: HandState, type: T) => s.events.filter((e): e is Extract<HandEvent, { type: T }> => e.type === type);
const stacks = (s: HandState) => s.seats.map((p) => p.stack);
const FOUR = [1500, 1500, 1500, 1500];

describe('the deal', () => {
  it('shuffles from the deck seed alone, and deals one card at a time from the seat left of the button', () => {
    const a = newHand({ stacks: FOUR, button: 1, sb: 10, bb: 20, ante: 0, deckSeed: 77 });
    const b = newHand({ stacks: [900, 2000, 1500, 40], button: 1, sb: 10, bb: 20, ante: 0, deckSeed: 77 });
    expect(a.seats.map((p) => p.hole)).toEqual(b.seats.map((p) => p.hole));
    expect(newHand({ stacks: FOUR, button: 1, sb: 10, bb: 20, ante: 0, deckSeed: 78 }).seats[0]!.hole).not.toEqual(a.seats[0]!.hole);
    expect(dealOrder(FOUR, 1)).toEqual([2, 3, 0, 1]);
    // Seat 2 (left of the button) gets the first and fifth cards, the button the fourth and eighth.
    expect(a.seats[2]!.hole).toEqual([a.deck[0], a.deck[4]]);
    expect(a.seats[1]!.hole).toEqual([a.deck[3], a.deck[7]]);
    // Every card once.
    expect(new Set(a.deck).size).toBe(52);
  });

  it('deals the board from the next five cards, flop, turn and river', () => {
    let s = deal({ stacks: [1000, 1000], holes: { 0: 'As Ad', 1: 'Ks Kd' }, board: '2c 3c 4d 9h Jh' });
    expect(formatCards(s.seats[0]!.hole)).toBe('As Ad');
    s = act(s, 'call', 'check');
    expect(formatCards(s.board)).toBe('2c 3c 4d');
    s = act(s, 'check', 'check');
    expect(formatCards(s.board)).toBe('2c 3c 4d 9h');
    s = act(s, 'check', 'check');
    expect(formatCards(s.board)).toBe('2c 3c 4d 9h Jh');
    expect(ofType(s, 'street').map((e) => [e.street, formatCards(e.cards)])).toEqual([['flop', '2c 3c 4d'], ['turn', '9h'], ['river', 'Jh']]);
  });

  it('skips busted seats: no cards, no blinds, no turn', () => {
    const s = deal({ stacks: [1500, 0, 1500, 1500] });
    expect(s.seats[1]!.status).toBe('empty');
    expect(s.seats[1]!.hole).toEqual([]);
    expect([s.sbSeat, s.bbSeat]).toEqual([2, 3]);
    expect(toAct(s)).toBe(0);
    expect(dealOrder([1500, 0, 1500, 1500], 0)).toEqual([2, 3, 0]);
    expect(() => newHand({ stacks: [1500, 0, 0], button: 0, sb: 10, bb: 20, ante: 0, deckSeed: 1 })).toThrow(/two players/);
    expect(() => newHand({ stacks: [1500, 0, 1500], button: 1, sb: 10, bb: 20, ante: 0, deckSeed: 1 })).toThrow(/button/);
  });
});

describe('blinds and the order of play', () => {
  it('posts the small blind left of the button and the big blind next; the seat after the big blind acts first', () => {
    const s = deal({ stacks: FOUR, button: 0 });
    expect([s.sbSeat, s.bbSeat]).toEqual([1, 2]);
    expect(ofType(s, 'post').map((e) => [e.seat, e.blind, e.amount])).toEqual([[1, 'sb', 10], [2, 'bb', 20]]);
    expect(toAct(s)).toBe(3);
    expect(stacks(s)).toEqual([1500, 1490, 1480, 1500]);
  });

  it('heads-up: the button posts the small blind and acts first before the flop, the big blind first after it', () => {
    let s = deal({ stacks: [1000, 1000], button: 1 });
    expect([s.sbSeat, s.bbSeat]).toEqual([1, 0]);
    expect(toAct(s)).toBe(1);
    s = act(s, 'call');
    expect(toAct(s)).toBe(0);
    expect(keysOf(s)).toContain('check');
    s = act(s, 'check');
    expect(s.street).toBe('flop');
    expect(toAct(s)).toBe(0);
    s = act(s, 'check');
    expect(toAct(s)).toBe(1);
  });

  it('gives the big blind its option when everyone limps', () => {
    let s = act(deal({ stacks: FOUR }), 'call', 'call', 'call');
    expect(toAct(s)).toBe(2);
    expect(keysOf(s)).toEqual(['check', 'small', 'half', 'three_quarters', 'pot', 'allin']);
    expect(opt(s, 'small')!.to).toBe(50);
    expect(opt(s, 'half')!.to).toBe(60);
    const raised = act(s, 'small');
    expect(raised.street).toBe('preflop');
    expect(toAct(raised)).toBe(3);
    s = act(s, 'check');
    expect(s.street).toBe('flop');
    // After the flop the first live seat left of the button starts.
    expect(toAct(s)).toBe(1);
  });

  it('puts antes in as dead money: they are not part of the bet to call', () => {
    const s = deal({ stacks: FOUR, sb: 100, bb: 200, ante: 25 });
    expect(ofType(s, 'post').map((e) => [e.seat, e.blind, e.amount])).toEqual([[1, 'ante', 25], [2, 'ante', 25], [3, 'ante', 25], [0, 'ante', 25], [1, 'sb', 100], [2, 'bb', 200]]);
    expect(opt(s, 'call')).toMatchObject({ to: 200, add: 200 });
    expect(publicView(s).pot).toBe(400);
    // Half pot is 200 + half of (400 in the middle + 200 to call), the same as 2.5 big blinds.
    expect(opt(s, 'small')!.to).toBe(500);
    expect(opt(s, 'half')).toBeUndefined();
  });
});

describe('the option menu', () => {
  it('fills in each size: current bet + share of (pot + call); small unopened is 2.5 big blinds, or half pot if less', () => {
    // 4-handed, under the gun: half pot (45) is less than 2.5 big blinds (50), so small is 45 and half goes.
    const s = deal({ stacks: FOUR });
    expect(legalOptions(s).map((o) => [o.key, o.kind, o.to, o.add])).toEqual([
      ['fold', 'fold', 0, 0],
      ['call', 'call', 20, 20],
      ['small', 'raise', 45, 45],
      ['three_quarters', 'raise', 58, 58],
      ['pot', 'raise', 70, 70],
      ['allin', 'allin', 1500, 1500],
    ]);
    expect(legalOptions(s).map((o) => o.label)).toEqual(['Fold', 'Call 20', 'Raise to 45 (half pot)', 'Raise to 58 (three quarters of the pot)', 'Raise to 70 (pot)', 'All-in for 1500']);
    // Heads-up, the button: the sizes still rise in menu order.
    const hu = deal({ stacks: [1500, 1500] });
    expect(legalOptions(hu).map((o) => [o.key, o.to])).toEqual([['fold', 10], ['call', 20], ['small', 40], ['three_quarters', 50], ['pot', 60], ['allin', 1500]]);
    // After limps, 2.5 big blinds is the smaller.
    const limped = act(deal({ stacks: FOUR }), 'call', 'call', 'call');
    expect(legalOptions(limped).find((o) => o.key === 'small')!.label).toBe('Raise to 50 (2.5 big blinds)');
  });

  it('sizes a third of the pot once someone has raised, and after the flop', () => {
    let s = act(deal({ stacks: FOUR }), 100);
    // Pot 130, 100 to call: a third of 230 is 77, so raise to 177; the minimum raise is to 180.
    expect(opt(s, 'small')!.to).toBe(180);
    expect(opt(s, 'pot')!.to).toBe(330);
    s = act(deal({ stacks: FOUR }), 'call', 'call', 'call', 'check');
    expect(publicView(s).pot).toBe(80);
    expect(legalOptions(s).map((o) => [o.key, o.kind, o.to])).toEqual([
      ['check', 'check', 0],
      ['small', 'bet', 27],
      ['half', 'bet', 40],
      ['three_quarters', 'bet', 60],
      ['pot', 'bet', 80],
      ['allin', 'allin', 1480],
    ]);
    expect(opt(s, 'small')!.label).toBe('Bet 27 (a third of the pot)');
  });

  it('raises each size to the minimum raise and drops sizes that repeat, keeping the smaller key', () => {
    // After the flop with 80 in the middle, a bet of 100: a third of (180 + 100) is 93, under the minimum (to 200).
    const s = act(deal({ stacks: FOUR }), 'call', 'call', 'call', 'check', 100);
    expect(legalOptions(s).map((o) => [o.key, o.to])).toEqual([
      ['fold', 0],
      ['call', 100],
      ['small', 200],
      ['half', 240],
      ['three_quarters', 310],
      ['pot', 380],
      ['allin', 1480],
    ]);
    expect(act(s, 'small').minRaise).toBe(100);
    // With antes in the middle, 2.5 big blinds and half the pot come to the same 500: half pot goes.
    const antes = deal({ stacks: FOUR, sb: 100, bb: 200, ante: 25 });
    expect(legalOptions(antes).map((o) => [o.key, o.to])).toEqual([['fold', 0], ['call', 200], ['small', 500], ['three_quarters', 650], ['pot', 800], ['allin', 1475]]);
  });

  it('turns a size the stack cannot cover into all-in only, and an all-in that only calls into a call', () => {
    const s = act(deal({ stacks: [1500, 1500, 1500, 300] }), 'call', 'call', 'call', 'check', 'check', 'check');
    // Seat 3 has 280 left; pot 80: the pot-size bet (80) fits, the rest come to more than it has.
    expect(toAct(s)).toBe(3);
    expect(legalOptions(s).map((o) => [o.key, o.to])).toEqual([['check', 0], ['small', 27], ['half', 40], ['three_quarters', 60], ['pot', 80], ['allin', 280]]);
    const big = act(s, 'check', 1000);
    // Now facing 1000 with seat 3 to act after the others: a call of 280 is all it can do, so no all-in option.
    const f = act(big, 'fold', 'fold');
    expect(toAct(f)).toBe(3);
    expect(legalOptions(f).map((o) => [o.key, o.kind, o.to, o.add])).toEqual([['fold', 'fold', 0, 0], ['call', 'call', 280, 280]]);
    expect(opt(f, 'call')!.label).toBe('Call 280 (all-in)');
  });

  it('offers fold only when facing a bet, and refuses what is not on the menu', () => {
    const s = act(deal({ stacks: FOUR }), 'call', 'call', 'call');
    expect(keysOf(s)).not.toContain('fold');
    expect(() => act(s, 'fold')).toThrow(/not a legal option/);
    expect(() => act(s, 'call')).toThrow(/not a legal option/);
    expect(() => act(deal({ stacks: FOUR }), 'check')).toThrow(/not a legal option/);
  });
});

describe('raises', () => {
  it('needs at least the last full raise, and at least the big blind', () => {
    let s = deal({ stacks: FOUR });
    expect(() => act(s, 39)).toThrow(/at least 40/);
    s = act(s, 60);
    expect(s.minRaise).toBe(40);
    expect(() => act(s, 99)).toThrow(/at least 100/);
    s = act(s, 100);
    expect(s.currentBet).toBe(100);
    expect(() => act(s, 139)).toThrow(/at least 140/);
    expect(() => act(s, 1501)).toThrow();
    expect(() => act(s, 140.5)).toThrow();
    // After the flop the smallest bet is the big blind.
    const flop = act(deal({ stacks: FOUR }), 'call', 'call', 'call', 'check');
    expect(() => act(flop, 19)).toThrow(/at least 20/);
    expect(act(flop, 20).currentBet).toBe(20);
  });

  it('does not reopen the betting with an all-in short of a full raise', () => {
    // Seat 3 raises to 100 (a raise of 80); the button goes all-in for 130, 30 more; the blinds have not acted.
    let s = act(deal({ stacks: [130, 1500, 1500, 1500] }), 100, 'allin');
    expect(s.currentBet).toBe(130);
    expect(s.minRaise).toBe(80);
    expect(keysOf(s)).toContain('allin');
    expect(opt(s, 'small')!.to).toBeGreaterThanOrEqual(210);
    expect(opt(s, 'small')!.to).toBe(257);
    s = act(s, 'fold', 'call');
    // Back to the raiser, who only faces 30 more: call or fold.
    expect(toAct(s)).toBe(3);
    expect(keysOf(s)).toEqual(['fold', 'call']);
    expect(() => act(s, 300)).toThrow(/cannot raise/);
  });

  it('reopens the betting when short all-ins add up to a full raise', () => {
    // Raise to 100; all-in to 170 (70 more); all-in to 200 (100 over the raise the raiser made).
    let s = act(deal({ stacks: [170, 200, 1500, 1500] }), 100, 'allin', 'allin');
    expect(s.currentBet).toBe(200);
    s = act(s, 'call');
    expect(toAct(s)).toBe(3);
    expect(keysOf(s)).toEqual(['fold', 'call', 'small', 'half', 'three_quarters', 'pot', 'allin']);
    expect(opt(s, 'small')!.to).toBe(457);
  });

  it('offers no raise when nobody else could call it', () => {
    let s = act(deal({ stacks: [500, 1500, 300], button: 0 }), 'call', 'call');
    // The big blind shoves 300, the button 500; the small blind has nobody left to raise against.
    s = act(s, 'allin', 'allin');
    expect(toAct(s)).toBe(1);
    expect(keysOf(s)).toEqual(['fold', 'call']);
  });
});

describe('short stacks', () => {
  it('posts a short blind all-in, and the others still call the full big blind', () => {
    let s = deal({ stacks: [1500, 5, 1500], holes: { 0: '7c 2d', 1: 'As Ad', 2: 'Kc Kd' }, board: '3h 8s 9d Jc 4c' });
    expect(ofType(s, 'post').map((e) => [e.seat, e.amount, e.allIn])).toEqual([[1, 5, true], [2, 20, false]]);
    expect(s.seats[1]!.status).toBe('allin');
    expect(opt(s, 'call')!.to).toBe(20);
    s = act(s, 'call', 'check', 'check', 'check', 'check', 'check', 'check', 'check');
    expect(s.street).toBe('done');
    // Seat 1 wins the 15 it could match; seat 2 the side pot of 30.
    expect(ofType(s, 'award').map((e) => [e.pot, e.amount, e.winners])).toEqual([[0, 15, [1]], [1, 30, [2]]]);
    expect(stacks(s)).toEqual([1480, 15, 1510]);
  });

  it('posts an ante all-in, and then no blind', () => {
    const s = deal({ stacks: [1500, 20, 1500], sb: 50, bb: 100, ante: 25 });
    expect(ofType(s, 'post').map((e) => [e.seat, e.blind, e.amount, e.allIn])).toEqual([[1, 'ante', 20, true], [2, 'ante', 25, false], [0, 'ante', 25, false], [2, 'bb', 100, false]]);
    expect(opt(s, 'call')!.to).toBe(100);
  });

  it('calls only what a lone all-in opponent can match when nobody else is left to bet', () => {
    // Heads-up, the big blind has 15: the button calls 5 more, then the cards run out.
    let s = deal({ stacks: [1000, 15], button: 0 });
    expect(toAct(s)).toBe(0);
    expect(legalOptions(s).map((o) => [o.key, o.to, o.add])).toEqual([['fold', 10, 0], ['call', 15, 5]]);
    s = act(s, 'call');
    expect(s.street).toBe('done');
    expect(s.board).toHaveLength(5);
    expect(chipsOf(s)).toBe(1015);
  });

  it('runs out a hand at once when the blinds put everyone all-in', () => {
    const s = deal({ stacks: [10, 20], button: 0 });
    expect(toAct(s)).toBeNull();
    expect(s.street).toBe('done');
    expect(ofType(s, 'street')).toHaveLength(3);
    expect(chipsOf(s)).toBe(30);
  });
});

describe('the end of a hand', () => {
  it('returns an uncalled bet and gives the pot to the last player in, without a showdown', () => {
    const s = act(deal({ stacks: FOUR }), 60, 'fold', 'fold', 'fold');
    expect(s.street).toBe('done');
    expect(ofType(s, 'return')).toEqual([{ type: 'return', seat: 3, amount: 40 }]);
    expect(ofType(s, 'award')).toEqual([{ type: 'award', pot: 0, amount: 50, eligible: [3], winners: [3], shares: [50] }]);
    expect(ofType(s, 'showdown')).toEqual([]);
    expect(stacks(s)).toEqual([1500, 1490, 1480, 1530]);
    expect(s.events.at(-1)).toEqual({ type: 'end', stacks: [1500, 1490, 1480, 1530], net: [0, -10, -20, 30] });
  });

  it('runs out the board when the players are all-in, and shows down', () => {
    const s = act(deal({ stacks: [1000, 1000], holes: { 0: 'As Ad', 1: 'Ks Kd' }, board: '2c 7d 9h Jc 3s' }), 'allin', 'call');
    expect(toAct(s)).toBeNull();
    expect(s.street).toBe('done');
    expect(s.events.map((e) => e.type)).toEqual(['start', 'post', 'post', 'hole', 'hole', 'action', 'action', 'street', 'street', 'street', 'showdown', 'award', 'end']);
    expect(ofType(s, 'showdown')[0]!.hands.map((h) => [h.seat, h.category])).toEqual([[1, 'pair'], [0, 'pair']]);
    expect(stacks(s)).toEqual([2000, 0]);
  });

  it('makes side pots: each all-in wins at most what it matched, folded chips stay in', () => {
    // 100, 300 and 1000 all-in or called; the shortest stack has the best hand, the middle the second best.
    let s = deal({ stacks: [100, 300, 1000], holes: { 0: 'As Ad', 1: 'Ks Kd', 2: 'Qs Qd' }, board: '2c 7d 9h Jc 3s' });
    s = act(s, 'allin', 'allin', 'call');
    expect(ofType(s, 'award').map((e) => [e.pot, e.amount, e.winners])).toEqual([[0, 300, [0]], [1, 400, [1]]]);
    expect(stacks(s)).toEqual([300, 400, 700]);
    // A raise and a call that fold later are dead money in the pot the others contest.
    let t = deal({ stacks: [1500, 1500, 200, 1500], holes: { 2: 'As Ad', 3: 'Ks Kd' }, board: '2c 7d 9h Jc 3s' });
    t = act(t, 100, 'call', 'fold', 'allin', 'call', 'fold');
    expect(t.street).toBe('done');
    expect(ofType(t, 'award')).toEqual([{ type: 'award', pot: 0, amount: 510, eligible: [2, 3], winners: [2], shares: [510] }]);
    expect(stacks(t)).toEqual([1400, 1490, 510, 1300]);
  });

  it('splits a pot, the odd chip to the first winner left of the button', () => {
    let s = deal({ stacks: [1000, 1000, 1000], sb: 5, bb: 10, holes: { 0: '2c 3d', 2: '4c 5d' }, board: 'Ts Js Qs Ks As' });
    s = act(s, 'call', 'fold', 'check', 'check', 'check', 'check', 'check', 'check', 'check');
    expect(ofType(s, 'award')).toEqual([{ type: 'award', pot: 0, amount: 25, eligible: [0, 2], winners: [2, 0], shares: [13, 12] }]);
    expect(stacks(s)).toEqual([1002, 995, 1003]);
  });

  it('shows the last river bettor first, else the first seat left of the button', () => {
    let s = deal({ stacks: [1000, 1000, 1000], holes: { 0: 'As Ad', 1: 'Ks Kd', 2: 'Qs Qd' }, board: '2c 7d 9h Jc 3s' });
    s = act(s, 'call', 'call', ...Array<'check'>(7).fill('check'));
    // River: seat 1 checks, seat 2 bets, seat 0 and seat 1 call.
    s = act(s, 'check', 40, 'call', 'call');
    expect(ofType(s, 'showdown')[0]!.hands.map((h) => h.seat)).toEqual([2, 0, 1]);
    let t = deal({ stacks: [1000, 1000, 1000], holes: { 0: 'As Ad', 1: 'Ks Kd', 2: 'Qs Qd' }, board: '2c 7d 9h Jc 3s' });
    t = act(t, 'call', 'call', 'check', ...Array<'check'>(9).fill('check'));
    expect(ofType(t, 'showdown')[0]!.hands.map((h) => h.seat)).toEqual([1, 2, 0]);
    expect(ofType(t, 'showdown')[0]!.hands[0]).toMatchObject({ category: 'pair', best: expect.any(Array) });
  });

  it('refuses actions once the hand is over', () => {
    const s = act(deal({ stacks: FOUR }), 'fold', 'fold', 'fold');
    expect(toAct(s)).toBeNull();
    expect(legalOptions(s)).toEqual([]);
    expect(() => act(s, 'check')).toThrow(/nobody is to act/);
  });

  it('never changes the state it is given', () => {
    const s = deal({ stacks: FOUR });
    const copy = structuredClone(s);
    act(s, 100, 'call', 'fold', 'allin');
    expect(s).toEqual(copy);
  });
});

describe('views', () => {
  const s = act(deal({ stacks: FOUR, holes: { 0: 'As Ad', 1: 'Ks Kd', 2: 'Qs Qd', 3: '7c 2d' } }), 'fold');

  it("gives a player its own cards, never another's, and its options when it is to act", () => {
    const o = observe(s, 0);
    expect(o.holeCards).toEqual(['As', 'Ad']);
    expect(o.players.map((p) => p.cards)).toEqual([['As', 'Ad'], null, null, null]);
    expect(o.options.map((x) => x.key)).toEqual(['fold', 'call', 'small', 'three_quarters', 'pot', 'allin']);
    expect(o.toCall).toBe(20);
    expect(observe(s, 1).options).toEqual([]);
    expect(observe(s, 1).holeCards).toEqual(['Ks', 'Kd']);
    expect(JSON.stringify(observe(s, 1))).not.toMatch(/"As"|"Qs"/);
  });

  it('names positions from the button, and lists the hand so far', () => {
    const o = observe(s, 0);
    expect(o.players.map((p) => p.position)).toEqual(['BTN', 'SB', 'BB', 'UTG']);
    expect(o.history).toEqual([{ street: 'preflop', seat: 3, position: 'UTG', key: 'fold', kind: 'fold', to: 0, add: 0, allIn: false }]);
    expect(observe(deal({ stacks: [100, 100] }), 0).players.map((p) => p.position)).toEqual(['BTN', 'BB']);
    expect(observe(deal({ stacks: [100, 100, 100] }), 0).players.map((p) => p.position)).toEqual(['BTN', 'SB', 'BB']);
    expect(observe(deal({ stacks: [100, 0, 100, 100, 100, 100] }), 0).players.map((p) => p.position)).toEqual(['BTN', '', 'SB', 'BB', 'UTG', 'CO']);
  });

  it('shows hole cards in the public view only at a showdown, and all of them in the full view', () => {
    expect(publicView(s).players.every((p) => p.cards === null)).toBe(true);
    expect(fullView(s).players.map((p) => p.cards)).toEqual([['As', 'Ad'], ['Ks', 'Kd'], ['Qs', 'Qd'], ['7c', '2d']]);
    const shown = act(s, 'allin', 'fold', 'call');
    expect(publicView(shown).players.map((p) => p.cards)).toEqual([['As', 'Ad'], null, ['Qs', 'Qd'], null]);
    expect(publicView(shown).board).toHaveLength(5);
    // Folded to: nothing shown.
    const folded = act(s, 'allin', 'fold', 'fold');
    expect(publicView(folded).players.every((p) => p.cards === null)).toBe(true);
  });

  it('lists the pots, side pots included', () => {
    const t = act(deal({ stacks: [100, 300, 1000] }), 'allin', 'allin');
    // The big blind is still to act, so it can still win every pot.
    expect(publicView(t).pots).toEqual([{ amount: 220, eligible: [0, 1, 2] }, { amount: 200, eligible: [1, 2] }]);
    expect(publicView(t).pot).toBe(420);
  });
});
