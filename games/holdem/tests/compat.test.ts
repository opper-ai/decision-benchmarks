// 2- to 4-seat games stay exactly what they were: the curated replays, share links and table tokens frozen in
// tests/fixtures/two-to-four-seats.json (written before tables of 5 and 6 came in) replay to the same events, chips and
// places, ask every decision with the same words, and rebuild the same table, byte for byte (compat.ts).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeGame, encodeGame } from '../src/share';
import { demoVectors, LINEUPS, linkVector, linkVectors, type LinkVector } from './compat';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/two-to-four-seats.json', import.meta.url), 'utf8')) as { demos: ReturnType<typeof demoVectors>; links: LinkVector[] };

describe('2- to 4-seat games, as frozen before 5 and 6 seats', () => {
  it('the four curated replays verify with the same fingerprint, replay and decisions', () => {
    expect(Object.keys(fixture.demos)).toHaveLength(4);
    expect(demoVectors()).toEqual(fixture.demos);
  });

  it('every frozen share link decodes to the same game, asks the same questions and rebuilds the same token', () => {
    expect(fixture.links.map((l) => l.seats)).toEqual([2, 2, 3, 3, 4, 4, 4, 4]);
    for (const v of fixture.links) {
      expect(linkVector(v.code)).toEqual(v);
      const d = decodeGame(v.code);
      expect(d.ok && encodeGame(d.recording)).toBe(v.code);
    }
    // The links hold slider raises, fallbacks, bots and every seat count.
    const recs = fixture.links.map((v) => decodeGame(v.code)).flatMap((d) => (d.ok ? [d.recording] : []));
    const actions = recs.flatMap((r) => r.hands.flatMap((h) => h.actions));
    expect(actions.some((x) => x.to !== undefined) && actions.some((x) => x.by === 'fallback') && actions.some((x) => x.by === 'bot')).toBe(true);
    expect(Math.max(...recs.map((r) => r.hands.length))).toBeGreaterThan(48);
  });

  it('the same tables played today make the same links', () => {
    expect(linkVectors()).toEqual(fixture.links);
    expect(LINEUPS).toHaveLength(fixture.links.length);
  });
});
