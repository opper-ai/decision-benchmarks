// How a chat model directs the delivery of its table talk at a live table: a line may carry at most MAX_TAGS of the
// directions text-to-speech is allowed to hear (DELIVERY_TAGS: [pause], [laughs], [whispering], ...), each where it
// happens. The server splits each line in two (splitSay):
//
// - shown: what every screen, the chat, the bubbles, the other models' prompts, the review and the recording get. No
//   tag of any kind: anything bracket- or angle-shaped is taken out, then the whitespace tidied, then cut to MAX_SAY.
//   Fish Audio also acts on full-width brackets and on single words in parentheses ((laugh), (sigh)), so those go too;
//   words in parentheses with a space among them are read out like any others, and stay.
// - spoken: what text-to-speech gets, only in the sealed token (server/token.ts). The same words with the allowed tags
//   kept, written one way (so splitting it again gives it back). Fish Audio acts on any bracketed words, so only the
//   list gets through: any other tag is dropped. A line cut to MAX_SAY is spoken plain.
//
// The model's mood adds nothing: a line is spoken with exactly the tags its model wrote, or none. The bench's prompt
// says nothing of tags, and its answers are never split.
//
// Node-safe, erasable TypeScript only.
// questions.ts imports this module too: only functions are used from it, at call time.
import { clipSay } from './questions.ts';
import { DELIVERY_TAGS, MAX_TAGS } from './voices.ts';

/** Longest raw line read: a model told 90 characters writes nowhere near it, and anything past it is cut first. */
const MAX_RAW = 1000;
/** The longest spoken line: MAX_SAY (90) of words and two tags, with room to spare. */
export const MAX_SPOKEN = 160;

/** Spaces collapsed, none before punctuation or at either end. */
const tidy = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:…])/g, '$1')
    .trim();

/** A line as the screens show it, and as it is spoken (equal when it has no tags). */
export function splitSay(raw: string): { shown: string; spoken: string } {
  let words = '';
  let tagged = '';
  let tags = 0;
  // A bracket or angle group with no bracket or angle inside it, or a word in parentheses; whatever is left of the
  // brackets and angles is stray. A group taken out still parts the words either side of it, in both forms alike.
  for (const part of raw.slice(0, MAX_RAW).split(/(\[[^[\]<>]*\]|<[^<>[\]]*>|[［【][^［］【】]*[］】]|\(\S*?\))/)) {
    if (!part) continue;
    if (part.startsWith('[') && part.endsWith(']')) {
      const name = tidy(part.slice(1, -1)).toLowerCase();
      if ((DELIVERY_TAGS as readonly string[]).includes(name) && tags < MAX_TAGS) {
        tagged += ` [${name}] `;
        tags++;
      } else tagged += ' ';
      words += ' ';
      continue;
    }
    if (/^(<.*>|[［【].*[］】]|\(\S*\))$/s.test(part)) {
      words += ' ';
      tagged += ' ';
      continue;
    }
    const text = part.replace(/[[\]<>［］【】]/g, ' ');
    words += text;
    tagged += text;
  }
  const full = tidy(words);
  const shown = clipSay(full);
  if (!shown) return { shown: '', spoken: '' };
  return { shown, spoken: tags && shown === full ? tidy(tagged) : shown };
}

/** A spoken line as the token may hold it: only the allowed tags, at most MAX_SPOKEN long (server/token.ts parseState). */
export function isSpoken(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_SPOKEN && splitSay(v).spoken === v;
}
