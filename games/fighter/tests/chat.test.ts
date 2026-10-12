import { describe, expect, it } from 'vitest';
import { toDistribution } from '../adapters/chat.ts';

describe('chat answers', () => {
  const offered = ['jab', 'sweep', 'block_high', 'backdash'] as const;
  it('build a full distribution from move, confidence and alternatives', () => {
    const d = toDistribution('sweep', 0.6, [{ move: 'jab', probability: 0.2 }], [...offered])!;
    expect(d.sweep).toBeCloseTo(0.6);
    expect(d.jab).toBeCloseTo(0.2);
    expect(d.block_high).toBeCloseTo(0.1);
    expect(Object.values(d).reduce((a, b) => a + b!, 0)).toBeCloseTo(1);
  });
  it('ignore alternatives that are not offered, and treat a missing confidence as uncalibrated', () => {
    const d = toDistribution('jab', 1, [{ move: 'throw', probability: 0.5 }], [...offered])!;
    expect(d.jab).toBeCloseTo(1);
    expect(toDistribution('jab', 'high', [], [...offered])).toBeNull();
  });
});
