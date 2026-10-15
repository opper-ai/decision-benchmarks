import { describe, expect, it } from 'vitest';
import { isRouteHash, parseRoute, tidyRouteHash } from '../src/route-hash';
import { linkCodeOf } from '../src/share';

describe('a route in the address', () => {
  it('reads a share link, a curated replay and the poster still', () => {
    expect(parseRoute('#/r/AQQ_x-9')).toEqual({ kind: 'link', code: 'AQQ_x-9' });
    expect(parseRoute('#/demo/titans.json.gz')).toEqual({ kind: 'demo', file: 'titans.json.gz' });
    expect(parseRoute('#/still/titans.json.gz?hand=3')).toEqual({ kind: 'still', file: 'titans.json.gz', query: 'hand=3' });
    expect(parseRoute('')).toBeNull();
    expect(parseRoute('#leaderboard')).toBeNull();
  });

  it('forgives what auto-linkers and chat apps stick on a link’s end', () => {
    for (const tail of [')', '/', '.', ',', ').', '%29']) {
      expect(tidyRouteHash(`#/r/AQQ${tail}`)).toBe('#/r/AQQ');
      expect(parseRoute(`#/r/AQQ${tail}`)).toEqual({ kind: 'link', code: 'AQQ' });
    }
    expect(linkCodeOf(tidyRouteHash('#/r/AQQ)'))).toBe('AQQ');
    expect(tidyRouteHash('#leaderboard.')).toBe('#leaderboard.');
  });

  it('calls a route-looking address it cannot read broken, so the room says so instead of staying blank', () => {
    for (const hash of ['#/r/AQ Q', '#/r/AQQ/extra', '#/r/!!']) {
      expect(isRouteHash(hash)).toBe(true);
      expect(parseRoute(hash)).toEqual({ kind: 'broken' });
    }
  });
});
