import { describe, expect, it } from 'vitest';
import { jointLeaders, mean, rankLabels, round, sortBest, stdError, tooCloseToCall } from '../shared/stats';

describe('stats', () => {
  it('takes the mean and its standard error', () => {
    expect(mean([])).toBe(0);
    expect(mean([1, 2, 3])).toBe(2);
    expect(stdError([5])).toBe(0);
    // Sample standard deviation 1 over the square root of 3.
    expect(stdError([1, 2, 3])).toBeCloseTo(1 / Math.sqrt(3), 12);
    expect(round(1.23456, 2)).toBe(1.23);
  });

  it('calls two means too close when they are within two standard errors of their difference', () => {
    expect(tooCloseToCall({ mean: 100, stdError: 10 }, { mean: 75, stdError: 10 })).toBe(true); // 25 < 28.3
    expect(tooCloseToCall({ mean: 100, stdError: 10 }, { mean: 70, stdError: 10 })).toBe(false); // 30 > 28.3
    expect(tooCloseToCall({ mean: 1, stdError: 0 }, { mean: 1, stdError: 0 })).toBe(false);
  });

  it('ranks best first either way round, and ties the leader with everything within its margin as =1', () => {
    const rows = [
      { id: 'b', mean: 90, stdError: 5 },
      { id: 'a', mean: 100, stdError: 5 },
      { id: 'c', mean: 50, stdError: 1 },
    ];
    const best = sortBest(rows, (r) => r, true);
    expect(best.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(sortBest(rows, (r) => r, false).map((r) => r.id)).toEqual(['c', 'b', 'a']);
    expect(jointLeaders(best, (r) => r).map((r) => r.id)).toEqual(['a', 'b']);
    expect(rankLabels(best, (r) => r)).toEqual(['=1', '=1', '3']);
    // A clear leader is plain 1.
    expect(rankLabels([{ mean: 100, stdError: 1 }, { mean: 50, stdError: 1 }], (r) => r)).toEqual(['1', '2']);
  });

  it('ties anything between the leader and the last model within its margin', () => {
    // c is within a's wide margin, b sits between them with a narrow one: all three share first.
    const rows = [
      { mean: 100, stdError: 1 },
      { mean: 95, stdError: 0.1 },
      { mean: 80, stdError: 20 },
      { mean: 10, stdError: 1 },
    ];
    expect(rankLabels(rows, (r) => r)).toEqual(['=1', '=1', '=1', '4']);
  });
});
