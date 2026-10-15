// Which address belongs to a replay route (routes.ts) rather than the lobby: a share link (#/r/<code>), a curated
// replay (#/demo/<file>) or the poster still (#/still/<file>). main.ts leaves the room alone for these, so routes.ts
// must always draw something for them: the replay, or a poster saying why it does not open (a "broken" route).
export const isRouteHash = (hash: string): boolean => /^#\/(?:r|demo|still)\/./.test(hash);

/**
 * A route's address without what auto-linkers and chat apps stick on its end when a link is pasted into a sentence
 * ("…#/r/CODE)", "…#/r/CODE.", "…#/r/CODE/"). Any other address is left as it is.
 */
export const tidyRouteHash = (hash: string): string => (isRouteHash(hash) ? hash.replace(/(?:[)\]}/.,;:!?'"]|%29|%2[Ff])+$/, '') : hash);

export type Route = { kind: 'link'; code: string } | { kind: 'demo'; file: string } | { kind: 'still'; file: string; query: string } | { kind: 'broken' };

/** The route in an address (tidied), "broken" when it looks like one but cannot be read, null for the lobby's. */
export function parseRoute(hash: string): Route | null {
  if (!isRouteHash(hash)) return null;
  const tidy = tidyRouteHash(hash);
  let m: RegExpExecArray | null;
  if ((m = /^#\/r\/([A-Za-z0-9_-]+)$/.exec(tidy))) return { kind: 'link', code: m[1]! };
  if ((m = /^#\/demo\/(.+)$/.exec(tidy))) return { kind: 'demo', file: m[1]! };
  if ((m = /^#\/still\/([^?]+)(?:\?(.*))?$/.exec(tidy))) return { kind: 'still', file: m[1]!, query: m[2] ?? '' };
  return { kind: 'broken' };
}
