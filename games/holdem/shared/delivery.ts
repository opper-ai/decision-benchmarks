// How a chat model directs the delivery of its table talk at a live table: a line may carry at most MAX_TAGS of Grok
// TTS's delivery tags, inline ([pause], [laugh], ...) or wrapping a few words (<whisper>For now.</whisper>). The
// server splits each line in two (splitSay):
//
// - shown: what every screen, the chat, the bubbles, the other models' prompts, the review and the recording get. No
//   tag of any kind: anything bracket- or angle-shaped is taken out, then the whitespace tidied, then cut to MAX_SAY.
// - spoken: what text-to-speech gets, only in the sealed token (server/token.ts). The same words with the allowed tags
//   kept, written one way (so splitting it again gives it back); any other tag, an unclosed or stray wrapper, a wrapper inside another, or
//   a wrapper around no words is dropped (its words stay, plain). A line cut to MAX_SAY is spoken plain.
//
// The model's mood adds nothing: a line is spoken with exactly the tags its model wrote, or none. The bench's prompt
// says nothing of tags, and its answers are never split.
//
// Node-safe, erasable TypeScript only.
// questions.ts imports this module too: only functions are used from it, at call time.
import { clipSay } from './questions.ts';

/** Tags that stand where they are said. */
export const INLINE_TAGS = ['pause', 'long-pause', 'laugh', 'sigh', 'breath'] as const;
/** Tags that wrap the words they change. */
export const WRAP_TAGS = ['whisper', 'slow', 'soft'] as const;
/** At most this many tags a line (a wrapper and its words count once). */
export const MAX_TAGS = 2;
/** Longest raw line read: a model told 90 characters writes nowhere near it, and anything past it is cut first. */
const MAX_RAW = 1000;
/** The longest spoken line: MAX_SAY (90) of words and two tags, with room to spare. */
export const MAX_SPOKEN = 160;

type Piece = { text: string; wrap?: { tag: string; id: number } } | { inline: string };

/** Spaces collapsed, none before punctuation or at either end. */
const tidy = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:…])/g, '$1')
    .trim();

/** A line as the screens show it, and as it is spoken (equal when it has no tags). */
export function splitSay(raw: string): { shown: string; spoken: string } {
  const pieces: Piece[] = [];
  let tags = 0;
  let open: { tag: string; id: number; at: number } | null = null;
  let ids = 0;
  // A bracket or angle group with no bracket or angle inside it; whatever is left of those characters is stray.
  for (const part of raw.slice(0, MAX_RAW).split(/(\[[^[\]<>]*\]|<[^<>[\]]*>)/)) {
    if (!part) continue;
    if (part.startsWith('[') && part.endsWith(']')) {
      const name = part.slice(1, -1).trim().toLowerCase();
      if ((INLINE_TAGS as readonly string[]).includes(name) && tags < MAX_TAGS) {
        pieces.push({ inline: name });
        tags++;
      }
      continue;
    }
    if (part.startsWith('<') && part.endsWith('>')) {
      const m = /^<\s*(\/?)\s*([a-z-]+)\s*>$/i.exec(part);
      const name = m?.[2]!.toLowerCase();
      if (m && !m[1] && !open && tags < MAX_TAGS && (WRAP_TAGS as readonly string[]).includes(name!)) {
        open = { tag: name!, id: ++ids, at: pieces.length };
        tags++;
      } else if (m && m[1] && open && name === open.tag) {
        const words = pieces.slice(open.at).some((p) => 'text' in p && p.text.trim());
        if (!words) tags--;
        for (const p of pieces.slice(open.at)) if ('text' in p && words) p.wrap = { tag: open.tag, id: open.id };
        open = null;
      }
      continue;
    }
    pieces.push({ text: part.replace(/[[\]<>]/g, ' ') });
  }
  // A wrapper never closed: its words stay, plain.
  if (open) tags--;
  const full = tidy(pieces.map((p) => ('text' in p ? p.text : ' ')).join(''));
  const shown = clipSay(full);
  if (!shown) return { shown: '', spoken: '' };
  if (!tags || shown !== full) return { shown, spoken: shown };
  let spoken = '';
  let inside: { tag: string; id: number } | undefined;
  for (const p of pieces) {
    const wrap = 'text' in p ? p.wrap : undefined;
    if (inside && wrap?.id !== inside.id) {
      spoken = `${spoken.trimEnd()}</${inside.tag}> `;
      inside = undefined;
    }
    if ('inline' in p) spoken += ` [${p.inline}] `;
    else {
      if (wrap && !inside) {
        spoken += ` <${wrap.tag}>`;
        inside = wrap;
        spoken += p.text.trimStart();
      } else spoken += p.text;
    }
  }
  if (inside) spoken = `${spoken.trimEnd()}</${inside.tag}>`;
  return { shown, spoken: tidy(spoken) };
}

/** A spoken line as the token may hold it: only the allowed tags, at most MAX_SPOKEN long (server/token.ts parseState). */
export function isSpoken(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_SPOKEN && splitSay(v).spoken === v;
}
