// Sharing to X and LinkedIn: the words a post starts with, and the links that open each network's composer. Pure, so
// tests check the wording and the budget. A result's post is written from the end screen: in the player's voice after
// a game they played ("I finished 2nd ..."), as a spectator after watching or a replay ("GPT-6 Astra took every chip
// ..."), with the best moment's sentence (highlights.ts) and a link that replays the whole game. No hashtags.
//
// Per-result link previews (an og:image for each shared game) would need the server to store or render images: v2.
// Today a shared link previews with the page's poster.
import type { Player } from '../shared/recording.ts';
import type { Review } from './driver.ts';
import { momentOf } from './highlights.ts';
import { ordinal, personOf } from './view-model.ts';

/** X counts any link as 23 characters; a post holds 280. */
export const X_LINK = 23;
export const X_LIMIT = 280;
/** The words before the link stay under this, so the post reads well on either network. */
export const TEXT_BUDGET = 240;

export type ShareSource = 'end' | 'replay';

/** "A", "A and B", "A, B and C". */
export const listOf = (names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** The best moment's sentence in the player's own voice: "you" becomes "I", "your" "my". */
export function firstPerson(sentence: string): string {
  return sentence
    .replace(/\bYou were\b/g, 'I was')
    .replace(/\byou were\b/g, 'I was')
    .replace(/\bYour\b/g, 'My')
    .replace(/\byour\b/g, 'my')
    .replace(/\bYou\b/g, 'I')
    .replace(/\byou\b/g, 'I');
}

export interface ResultFacts {
  players: readonly Player[];
  /** Finishing place per seat (1 won). */
  places: readonly (number | null)[];
  /** The player's seat, or null for a spectator (watch, replay). */
  viewer: number | null;
  /** The best moment's sentence as the end screen says it, without "Hand N." (null if none). */
  moment: string | null;
}

/** The facts a result post needs, from a finished game. */
export function resultFacts(review: Review, places: readonly (number | null)[], viewer: number | null): ResultFacts {
  const m = momentOf(review.hands, review.players, (s) => personOf(review.players[s]!).name);
  return { players: review.players, places, viewer, moment: m ? m.text.replace(/^Hand \d+\. /, '') : null };
}

/**
 * A result's post, under TEXT_BUDGET characters: who won (or where the player finished) and against whom, the best
 * moment, and an invitation. When it is too long it drops, in turn: the pot size, the full model names (for their
 * short names), the invitation, the moment.
 */
export function resultText(f: ResultFacts, budget = TEXT_BUDGET): string {
  const winner = f.places.indexOf(1);
  const attempts: string[] = [];
  for (const short of [false, true]) {
    const name = (seat: number) => {
      const p = personOf(f.players[seat]!);
      return short ? p.short : p.name;
    };
    const others = (except: number) => listOf(f.players.map((_, s) => s).filter((s) => s !== except && s !== f.viewer).map(name));
    let head: string;
    let invite: string;
    if (f.viewer !== null) {
      const mine = f.places[f.viewer] ?? f.places.length;
      head = mine === 1 ? `I won the table at AI Hold'em against ${others(f.viewer)}.` : `I finished ${ordinal(mine)} at AI Hold'em against ${others(f.viewer)}.`;
      invite = mine === 1 ? 'Can you do it too?' : 'Can you beat them?';
    } else {
      head = `${name(winner)} took every chip from ${others(winner)} at AI Hold'em.`;
      invite = 'Watch the whole game:';
    }
    const voice = (s: string) => (f.viewer !== null ? firstPerson(s) : s);
    const moment = f.moment ? voice(f.moment) : null;
    const lead = f.viewer !== null ? '' : 'Best moment: ';
    const short2 = moment?.replace(/ Pot: .*$/, '');
    if (moment) attempts.push(`${head} ${lead}${moment} ${invite}`, `${head} ${lead}${short2} ${invite}`);
    attempts.push(`${head} ${invite}`);
    if (moment) attempts.push(`${head} ${lead}${short2}`);
  }
  const fits = attempts.find((t) => t.length <= budget);
  if (fits) return fits;
  // Still too long (very long names): cut at a word.
  const last = attempts.at(-1)!;
  return `${last.slice(0, budget - 1).replace(/\s+\S*$/, '')}…`;
}

/** The X composer, text and link prefilled. */
export const xIntentUrl = (text: string, url: string): string => `https://x.com/intent/post?${new URLSearchParams({ text, url })}`;

/**
 * LinkedIn's composer with the text prefilled (the link in it, so LinkedIn previews it). LinkedIn's share-offsite only
 * takes a link, so a post that must keep its words uses the feed's shareActive form.
 */
export const linkedInUrl = (text: string, url: string): string => `https://www.linkedin.com/feed/?${new URLSearchParams({ shareActive: 'true', text: `${text} ${url}` })}`;

/** LinkedIn's link-only share (no words), the fallback. */
export const linkedInLinkUrl = (url: string): string => `https://www.linkedin.com/sharing/share-offsite/?${new URLSearchParams({ url })}`;

/** How long X will count a post: the text, a space, and the link at 23. */
export const xLength = (text: string): number => [...text].length + 1 + X_LINK;
