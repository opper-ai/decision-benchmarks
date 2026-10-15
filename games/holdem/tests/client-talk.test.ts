import { describe, expect, it } from 'vitest';
import { actionChip, bubbleMs, logNote, STREET_NAMES } from '../src/view-model';

const a = (kind: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin', to = 0, add = 0, allIn = false) => ({ kind, to, add, allIn });

describe('the thinking log and the review: an action as a chip', () => {
  it('names the move and its amount, coloured by what it does', () => {
    expect(actionChip(a('fold'))).toEqual({ label: 'Fold', tone: 'fold' });
    expect(actionChip(a('check'))).toEqual({ label: 'Check', tone: 'calm' });
    expect(actionChip(a('call', 40, 40))).toEqual({ label: 'Call 40', tone: 'calm' });
    expect(actionChip(a('bet', 120, 120))).toEqual({ label: 'Bet 120', tone: 'push' });
    expect(actionChip(a('raise', 450, 410))).toEqual({ label: 'Raise to 450', tone: 'push' });
    expect(actionChip(a('raise', 1500, 1460, true))).toEqual({ label: 'All-in 1,500', tone: 'allin' });
    expect(actionChip(a('allin', 1500, 1500, true))).toEqual({ label: 'All-in 1,500', tone: 'allin' });
    expect(actionChip(a('call', 900, 300, true))).toEqual({ label: 'Call 300, all-in', tone: 'allin' });
  });

  it('heads each street of each hand', () => {
    expect(STREET_NAMES.preflop).toBe('Before the flop');
    expect(STREET_NAMES.river).toBe('River');
  });
});

describe('a speech bubble', () => {
  it('stays up long enough to read: longer for more words, shorter when the table is sped up, never a flash', () => {
    const short = bubbleMs('Call.', 1);
    const long = bubbleMs('I have been waiting all night for a hand like this one, and here it is.', 1);
    expect(short).toBeGreaterThanOrEqual(2500);
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThanOrEqual(8000);
    expect(bubbleMs('I have been waiting all night for a hand like this one.', 4)).toBeLessThan(bubbleMs('I have been waiting all night for a hand like this one.', 1));
    expect(bubbleMs('Call.', 8)).toBeGreaterThanOrEqual(1200);
  });
});

describe('an empty thinking log', () => {
  it('says why when only decision models sit at the table', () => {
    expect(logNote(['decision', 'decision', null])).toBe('Decision models don’t explain their moves: their tell meters show how sure they were.');
    expect(logNote(['decision', 'chat'])).toBe('Nothing said yet. What the models say, and why they play as they do, shows here.');
  });
});
