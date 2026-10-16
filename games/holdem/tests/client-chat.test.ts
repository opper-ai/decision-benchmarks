import { describe, expect, it } from 'vitest';
import { formatCard } from '../shared/cards';
import type { HandEvent } from '../shared/engine';
import { MAX_SAY } from '../shared/questions';
import { chatLinesOf, PendingTalk, SAY_MAX } from '../src/chat-lines';
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

  it('keeps your own line short: the input takes 90 characters, the table’s own cap', () => {
    expect(SAY_MAX).toBe(90);
    expect(SAY_MAX).toBe(MAX_SAY);
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

describe('your lines on their way', () => {
  it('are settled oldest first, by order, whatever the table made of their words', () => {
    const p = new PendingTalk<string>();
    for (const x of ['Oh really…', 'two', 'three']) p.add(x);
    // The server said the first as 'Oh really...' (cleaned again): it is still the first line's answer.
    expect(p.take(1)).toEqual(['Oh really…']);
    expect(p.take(2)).toEqual(['two', 'three']);
    expect(p.take(1)).toEqual([]);
    expect(p.size).toBe(0);
  });
});

describe('the chat’s Show thinking switch', () => {
  it('is on when watching and off when playing, until the player sets it, per kind of table', async () => {
    const { showThinking, thinkingKey } = await import('../src/chat-lines');
    expect(showThinking('watch', null)).toBe(true);
    expect(showThinking('play', null)).toBe(false);
    expect(showThinking('play', 'on')).toBe(true);
    expect(showThinking('watch', 'off')).toBe(false);
    expect(showThinking('watch', 'nonsense')).toBe(true);
    expect(thinkingKey('play')).not.toBe(thinkingKey('watch'));
  });
});

describe('a replay jumped to a later hand', () => {
  it('lays out the hands before it as they were played: every move with its words, your talk where it was said', async () => {
    const { playedHandLines } = await import('../src/chat-lines');
    const d = new LocalDriver({ thinkScale: 0, sleep: async () => {} });
    let s = await d.start({ seed: 5, seats: [{ kind: 'human', id: 'you' }, { kind: 'model', id: 'aws/claude-opus-5-5' }] });
    let first = true;
    while (s.view.street !== 'done') {
      if (s.turn) {
        if (first) (d.say('Nice try.'), (first = false));
        s = (await d.act({ key: s.turn.options.find((o) => o.key === 'check' || o.key === 'call')!.key })).snapshot;
      } else s = (await d.step()).snapshot;
    }
    s = await d.nextHand();
    const hand = (await d.review()).hands[0]!;
    const lines = playedHandLines(hand);
    const moves = lines.filter((l) => 'line' in l && l.line.kind === 'move');
    expect(moves.length).toBe(hand.actions.length);
    // Each move carries its own action's words.
    moves.forEach((m, i) => 'line' in m && expect(m.words?.say).toBe(hand.actions[i]!.say));
    // Your line, just before the move it came with.
    const talk = lines.findIndex((l) => 'talk' in l);
    expect(hand.talk?.length).toBe(1);
    expect(lines[talk]).toEqual({ talk: { seat: 0, say: 'Nice try.' } });
    const after = hand.talk![0]!.after;
    expect(lines.slice(0, talk).filter((l) => 'line' in l && l.line.kind === 'move').length).toBe(after);
  });
});
