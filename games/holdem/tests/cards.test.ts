import { describe, expect, it } from 'vitest';
import { cardOf, DECK, formatCard, formatCards, parseCard, parseCards, rankOf, suitOf } from '../shared/cards';
import { deriveSeed, hashText, mulberry32, shuffle } from '../shared/rng';

describe('the PRNG', () => {
  it('is mulberry32, as snake uses it', () => {
    const [a, s1] = mulberry32(0);
    const [b] = mulberry32(s1);
    expect(a).toBeCloseTo(0.26642920868471265, 12);
    expect(b).toBeCloseTo(0.0003297457005828619, 12);
  });

  it('shuffles from a seed alone: a permutation, the same every time, different for other seeds', () => {
    const a = shuffle(DECK, 42);
    expect(a).toEqual(shuffle(DECK, 42));
    expect([...a].sort((x, y) => x - y)).toEqual([...DECK]);
    expect(a).not.toEqual(DECK);
    const firsts = new Set(Array.from({ length: 200 }, (_, i) => shuffle(DECK, i)[0]));
    expect(firsts.size).toBeGreaterThan(40);
    // The input is left as it was.
    expect(DECK[0]).toBe(0);
  });

  it('derives sub-seeds that differ by every part, in order, and stay 32-bit integers', () => {
    const seeds = new Set<number>();
    for (let hand = 0; hand < 50; hand++) for (let seat = 0; seat < 4; seat++) seeds.add(deriveSeed(7, hand, seat));
    expect(seeds.size).toBe(200);
    expect(deriveSeed(7, 1, 2)).toBe(deriveSeed(7, 1, 2));
    expect(deriveSeed(7, 1, 2)).not.toBe(deriveSeed(7, 2, 1));
    expect(deriveSeed(7, 1)).not.toBe(deriveSeed(8, 1));
    for (const s of seeds) expect(Number.isInteger(s) && s >= -(2 ** 31) && s < 2 ** 31).toBe(true);
  });

  it('hashes text to 32 hex digits', () => {
    expect(hashText('abc')).toMatch(/^[0-9a-f]{32}$/);
    expect(hashText('abc')).toBe(hashText('abc'));
    expect(hashText('abc')).not.toBe(hashText('abd'));
    expect(hashText('')).not.toBe(hashText(' '));
  });
});

describe('cards', () => {
  it('numbers cards 0 to 51: rank in the high bits (2 to A), suit in the low two (c d h s)', () => {
    expect(DECK).toHaveLength(52);
    expect(parseCard('2c')).toBe(0);
    expect(parseCard('2s')).toBe(3);
    expect(parseCard('As')).toBe(51);
    expect(rankOf(parseCard('Td'))).toBe(8);
    expect(suitOf(parseCard('Td'))).toBe(1);
    expect(cardOf(12, 2)).toBe(parseCard('Ah'));
  });

  it('parses and formats every card both ways, with or without spaces', () => {
    for (const c of DECK) expect(parseCard(formatCard(c))).toBe(c);
    expect(parseCards('As Kd 7h')).toEqual([51, 45, 22]);
    expect(parseCards('AsKd7h')).toEqual(parseCards('As Kd 7h'));
    expect(formatCards(parseCards('Qh Jc'))).toBe('Qh Jc');
    expect(parseCards('')).toEqual([]);
  });

  it('refuses what is not a card', () => {
    for (const bad of ['1s', 'Ax', 'A', '10s', 'as', '']) expect(() => parseCard(bad)).toThrow();
    expect(() => parseCards('As K')).toThrow();
  });
});
