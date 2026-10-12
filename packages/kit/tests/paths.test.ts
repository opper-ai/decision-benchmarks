import { describe, expect, it } from 'vitest';
import { appPath, SHARE_URL, shareUrlFor, withBase } from '../client/paths';

describe('client paths', () => {
  it.each([
    ['/', '/api/me', '/api/me'],
    ['/', '/', '/'],
    ['/', '/?model=sference%2Fclef', '/?model=sference%2Fclef'],
    ['/decision-benchmarks/snake/', '/api/me', '/decision-benchmarks/snake/api/me'],
    ['/decision-benchmarks/snake/', '/', '/decision-benchmarks/snake/'],
    ['/decision-benchmarks/snake/', '/?model=sference%2Fclef', '/decision-benchmarks/snake/?model=sference%2Fclef'],
    ['/decision-benchmarks/snake/', 'leaderboard', '/decision-benchmarks/snake/leaderboard'],
    ['/decision-benchmarks/snake/', '/demo/jev-demo.json', '/decision-benchmarks/snake/demo/jev-demo.json'],
  ])('withBase(%s, %s) = %s', (base, path, expected) => {
    expect(withBase(base, path)).toBe(expected);
  });

  it('builds for the root by default', () => {
    expect(appPath('/leaderboard.json')).toBe(withBase(import.meta.env.BASE_URL, '/leaderboard.json'));
    expect(SHARE_URL).toMatch(/^https:\/\//);
  });

  it('shares the bare origin at the root and the app address below a prefix', () => {
    expect(shareUrlFor('/', 'https://example.com', 'https://example.com/')).toBe('https://example.com');
    expect(shareUrlFor('/decision-benchmarks/snake/', 'https://opper.ai', 'https://opper.ai/decision-benchmarks/snake/')).toBe('https://opper.ai/decision-benchmarks/snake/');
  });
});
