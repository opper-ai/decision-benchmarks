import { describe, expect, it } from 'vitest';
import { formatCard } from '../shared/cards';
import type { HandEvent } from '../shared/engine';
import { chatLinesOf, sayCount, SAY_MAX } from '../src/chat-lines';
import { LocalDriver } from '../src/local-driver';

describe('the table chat: what the dealer says', () => {
  it('opens each hand, gives every move with its street, the board as it comes, and who won what with which hand', async () => {
    const d = new LocalDriver({ thinkScale: 0, sleep: async () => {} });
    let s = await d.start({ seed: 3, seats: [{ kind: 'model', id: 'sference/clef' }, { kind: 'model', id: 'typesafe/jev-1.13.0' }] });
    while (s.view.street !== 'done') s = (await d.step()).snapshot;
    const lines = chatLinesOf(s.events, s.hand);
    expect(lines[0]).toMatchObject({ kind: 'hand', hand: 1, sb: 10, bb: 20 });
    const moves = lines.filter((l) => l.kind === 'move');
    expect(moves.length).toBe(s.events.filter((e) => e.type === 'action').length);
    expect(moves[0]).toMatchObject({ street: 'preflop' });
    for (const l of lines.filter((x) => x.kind === 'board')) expect(l.kind === 'board' && l.cards.every((c) => /^[2-9TJQKA][cdhs]$/.test(c))).toBe(true);
    const wins = lines.filter((l) => l.kind === 'win');
    expect(wins.length).toBeGreaterThan(0);
    expect(lines.at(-1)!.kind).toBe('win');
  });

  it('reads a part of a hand (the events since the last answer) without opening the hand again', () => {
    const events: HandEvent[] = [{ type: 'street', street: 'flop', cards: [0, 13, 26], board: [0, 13, 26] }];
    expect(chatLinesOf(events, 4)).toEqual([{ kind: 'board', street: 'flop', cards: [0, 13, 26].map(formatCard) }]);
  });

  it('keeps your own line short: 90 characters, counted as you type', () => {
    expect(SAY_MAX).toBe(90);
    expect(sayCount('Nice hand.')).toBe('10/90');
    expect(sayCount('x'.repeat(95))).toBe('95/90');
  });
});

describe('your talk in practice', () => {
  it('is taken as the table takes it, goes with the next move, and comes back through onSaid', async () => {
    const watch = new LocalDriver({ thinkScale: 0, sleep: async () => {} });
    await watch.start({ seed: 1, seats: [{ kind: 'model', id: 'sference/clef' }, { kind: 'model', id: 'typesafe/jev-1.13.0' }] });
    expect(watch.say('hello')).toBeNull();

    const d = new LocalDriver({ thinkScale: 0, sleep: async () => {} });
    const heard: { seat: number; say: string }[] = [];
    d.onSaid = (lines) => heard.push(...lines);
    let s = await d.start({ seed: 1, seats: [{ kind: 'human', id: 'you' }, { kind: 'model', id: 'aws/claude-opus-5-5' }] });
    expect(d.say('   ')).toBeNull();
    expect(d.say('  Fold   now. ')).toBe('Fold now.');
    expect(heard).toEqual([]);
    s = s.turn ? (await d.act({ key: 'call' })).snapshot : (await d.step()).snapshot;
    expect(heard).toEqual([expect.objectContaining({ seat: 0, say: 'Fold now.' })]);
    for (let i = 0; i < 6; i++) expect(d.say(`line ${i}`)).not.toBeNull();
    expect(d.say('one too many')).toBeNull();
    expect(s.hand).toBe(1);
  });
});
