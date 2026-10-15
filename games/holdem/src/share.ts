// Share links: a whole Sit & Go in a URL hash (#/r/<code>), short enough to paste anywhere. A link holds only what
// replays the game: who sat where, the Sit & Go's table key, and every move that is not a bot's (the engine recomputes the
// bots' moves, as verify does). No table talk, reasoning or timings: those stay with the player.
//
// The code is base64url of: a version byte (2 for a table of 2 to 4, 3 for 5 or 6: LINK_VERSIONS); the seat count; a byte per seat (kind in the top two bits, then an index
// into LINK_MODELS or BOT_NAMES); the table key (32 bytes); then a stream of 4-bit moves:
//   0-7  a menu option (fold, check, call, small, half, three_quarters, pot, allin), by its index in OPTION_KEYS
//   8, 9 the fallback's fold and check
//   15   a raise to an amount of one's own (the human's slider), the amount following as 3-bit groups, low first, the
//        top bit of each nibble set while more follow
//   14   padding, as the last nibble only
// Decoding replays the moves through the engine (it knows whose turn it is and when a hand ends), then the result
// goes through verifyRecording: a link that is not a legal, finished game is refused.
import { BOT_NAMES, botDecide, isBotName, type BotName } from '../shared/bots.ts';
import { observe, OPTION_KEYS, toAct, type Action, type OptionKey } from '../shared/engine.ts';
import { verifyRecording, type Player, type RecordedAction, type Recording } from '../shared/recording.ts';
import { keyBytes } from '../shared/rng.ts';
import { actSitAndGo, MAX_SEATS, newSitAndGo, nextHand, STARTING_STACK, type SitAndGo } from '../shared/sitngo.ts';

/**
 * The link versions this page reads, and the seat counts each holds. 2: the table key (32 bytes) replaced the 4-byte
 * seed. 3: tables of 5 and 6, whose blind levels last two orbits (sitngo.ts): the same layout, the seat count past 4. A
 * game of 2 to 4 is still written as version 2, byte for byte as before, so every link made before opens the same game
 * and a page from before opens every link of 2 to 4; it says a link of 5 or 6 was made by another version of the game.
 */
export const LINK_VERSIONS: Readonly<Record<number, { min: number; max: number }>> = { 2: { min: 2, max: 4 }, 3: { min: 5, max: MAX_SEATS } };
/** The newest version: what a link of 5 or 6 seats is written as. */
export const LINK_VERSION = 3;
/** The version a game of `seats` goes in. */
const versionFor = (seats: number): number => (seats <= LINK_VERSIONS[2]!.max ? 2 : LINK_VERSION);
const KEY_BYTES = 32;

/**
 * The models a link can name, by index. Append only: a link made today must open the same table next year, so ids
 * are never removed or reordered here, even when a model leaves the game.
 */
export const LINK_MODELS: readonly string[] = [
  'typesafe/jev-1.13.0',
  'sference/clef',
  'cloudflare:global/clef-flash',
  'opper/kev-4b',
  'berget/convaiinnovations/laya',
  'openai/gpt-6-luna-decisions',
  'azure:global/microsoft-decision-1',
  'empiriolabs/aplomb-1',
  'greenpt/metis',
  'aws/claude-haiku-5-5-eu',
  'vertexai/claude-sonnet-5-5-eu',
  'aws/claude-opus-5-5',
  'anthropic/claude-fable-5-1',
  'azure:eu/gpt-6-luna',
  'azure/gpt-5.6-terra',
  'azure:eu/gpt-6.1-sol',
  'azure/gpt-6-astra-global',
  'vertexai/gemini-4-argon-eu',
  'xai/grok-4.7',
  'melious/deepseek-v4.1-flash',
  'nebius/deepseek-ai/DeepSeek-V4-Pro-0813',
  'tensorx/qwen/qwen3.8-flash-next',
  'alibaba:global/qwen3.8-max',
  'sference/kimi-k3',
  'inceptron/zai-org/GLM-5.3-Flash',
  'inceptron/zai-org/GLM-5.3',
  'nebius/MiniMaxAI/MiniMax-M3',
  'vertexai/gemini-3.1-pro-preview',
  'vertexai/gemini-3.8-flash-eu',
  'vertexai/gemini-3.5-flash-lite-eu',
];

/** Far above a real game (a Sit & Go is 40 to 80 hands), so a link can't make the page replay forever. */
const MAX_CODE_LENGTH = 20_000;
const KIND = { human: 0, bot: 1, model: 2 } as const;
const FALLBACK_FOLD = 8;
const FALLBACK_CHECK = 9;
const PAD = 14;
const RAISE = 15;

// ---------- base64url ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let k = 0; k < chars; k++) out += B64[(n >> (18 - 6 * k)) & 63];
  }
  return out;
}

export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 4) {
    const chunk = text.slice(i, i + 4);
    let n = 0;
    for (let k = 0; k < 4; k++) n = (n << 6) | (k < chunk.length ? B64.indexOf(chunk[k]!) : 0);
    const bytes = Math.floor((chunk.length * 6) / 8);
    for (let k = 0; k < bytes; k++) out.push((n >> (16 - 8 * k)) & 255);
  }
  return Uint8Array.from(out);
}

// ---------- encode ----------

/** Why a recording can't be put in a link, or null. */
function unlinkable(rec: Recording): string | null {
  if (rec.mode !== 'sitngo' || !rec.sitngo) return 'only a Sit & Go can be shared';
  if (rec.sitngo.startingStack !== STARTING_STACK) return 'only the standard 1500-chip Sit & Go can be shared';
  if (rec.players.length < 2 || rec.players.length > MAX_SEATS) return `a link holds 2 to ${MAX_SEATS} players`;
  for (const p of rec.players) {
    if (p.kind === 'model' && !LINK_MODELS.includes(p.id)) return `${p.id} can't be named in a link`;
    if (p.kind === 'bot' && !isBotName(p.id)) return `${p.id} is not a bot`;
  }
  return null;
}

/** A finished Sit & Go as a link code; throws for a recording a link can't hold. */
export function encodeGame(rec: Recording): string {
  const problem = unlinkable(rec);
  if (problem) throw new Error(problem);
  const head = [versionFor(rec.players.length), rec.players.length, ...rec.players.map((p) => (KIND[p.kind] << 6) | (p.kind === 'model' ? LINK_MODELS.indexOf(p.id) : p.kind === 'bot' ? BOT_NAMES.indexOf(p.id as BotName) : 0))];
  head.push(...keyBytes(rec.sitngo!.key));
  const nibbles: number[] = [];
  for (const hand of rec.hands) {
    for (const a of hand.actions) {
      if (a.by === 'bot') continue;
      if (a.to !== undefined) {
        nibbles.push(RAISE);
        let n = a.to;
        do {
          const part = n & 7;
          n = Math.floor(n / 8);
          nibbles.push(part | (n > 0 ? 8 : 0));
        } while (n > 0);
      } else if (a.by === 'fallback') nibbles.push(a.key === 'fold' ? FALLBACK_FOLD : FALLBACK_CHECK);
      else nibbles.push(OPTION_KEYS.indexOf(a.key!));
    }
  }
  if (nibbles.length % 2) nibbles.push(PAD);
  const body: number[] = [];
  for (let i = 0; i < nibbles.length; i += 2) body.push((nibbles[i]! << 4) | nibbles[i + 1]!);
  return toBase64Url(Uint8Array.from([...head, ...body]));
}

/** Can this game go in a link? */
export const canShare = (rec: Recording | null): rec is Recording => rec !== null && unlinkable(rec) === null;

// ---------- decode ----------

export type Decoded = { ok: true; recording: Recording } | { ok: false; error: string };

const fail = (error: string): Decoded => ({ ok: false, error });

/** A link code back to a recording, replayed and verified; never throws. */
export function decodeGame(code: string): Decoded {
  if (code.length > MAX_CODE_LENGTH) return fail('This link is too long to be a game.');
  const bytes = fromBase64Url(code);
  if (!bytes || bytes.length < 2 + 2 + KEY_BYTES) return fail('This link is not a game.');
  const seats = LINK_VERSIONS[bytes[0]!];
  if (!seats) return fail('This link was made by another version of the game.');
  const n = bytes[1]!;
  if (n < seats.min || n > seats.max || bytes.length < 2 + n + KEY_BYTES) return fail('This link is not a game.');
  const players: Player[] = [];
  for (let i = 0; i < n; i++) {
    const b = bytes[2 + i]!;
    const kind = b >> 6;
    const index = b & 63;
    if (kind === KIND.human && index === 0) players.push({ kind: 'human', id: 'human' });
    else if (kind === KIND.bot && BOT_NAMES[index]) players.push({ kind: 'bot', id: BOT_NAMES[index]! });
    else if (kind === KIND.model && LINK_MODELS[index]) players.push({ kind: 'model', id: LINK_MODELS[index]! });
    else return fail('This link names a player the game does not know.');
  }
  if (players.filter((p) => p.kind === 'human').length > 1) return fail('This link is not a game.');
  const at = 2 + n;
  const key = Array.from(bytes.subarray(at, at + KEY_BYTES), (b) => b.toString(16).padStart(2, '0')).join('');
  const nibbles: number[] = [];
  for (const b of bytes.subarray(at + KEY_BYTES)) nibbles.push(b >> 4, b & 15);
  if (nibbles.at(-1) === PAD) nibbles.pop();

  let g: SitAndGo = newSitAndGo({ seats: n, key });
  const hands: Recording['hands'] = [{ actions: [] }];
  let i = 0;
  const next = (): number => {
    if (i >= nibbles.length) throw new Error('The link stops before the game ended.');
    return nibbles[i++]!;
  };
  try {
    for (let guard = 0; guard < 50_000; guard++) {
      if (toAct(g.hand) === null) {
        if (g.over) break;
        g = nextHand(g);
        hands.push({ actions: [] });
        continue;
      }
      const seat = toAct(g.hand)!;
      const p = players[seat]!;
      let recorded: RecordedAction;
      let action: Action;
      if (p.kind === 'bot') {
        const key = botDecide(p.id as BotName, observe(g.hand, seat));
        recorded = { seat, key, by: 'bot' };
        action = { key };
      } else {
        const v = next();
        if (v === RAISE) {
          let to = 0;
          let scale = 1;
          for (let part = next(); ; part = next()) {
            to += (part & 7) * scale;
            scale *= 8;
            if (!(part & 8)) break;
            if (scale > 2 ** 33) throw new Error('This link is not a game.');
          }
          if (p.kind !== 'human') throw new Error('Only a human raises to an amount of its own.');
          recorded = { seat, to, by: 'human' };
          action = { kind: 'raise', to };
        } else if (v === FALLBACK_FOLD || v === FALLBACK_CHECK) {
          const key: OptionKey = v === FALLBACK_FOLD ? 'fold' : 'check';
          recorded = { seat, key, by: 'fallback' };
          action = { key };
        } else if (v < OPTION_KEYS.length) {
          const key = OPTION_KEYS[v]!;
          recorded = { seat, key, by: p.kind === 'human' ? 'human' : 'answer' };
          action = { key };
        } else throw new Error('This link is not a game.');
      }
      g = actSitAndGo(g, action);
      hands.at(-1)!.actions.push(recorded);
    }
  } catch (e) {
    const m = (e as Error).message;
    return fail(m.startsWith('This link') || m.startsWith('The link') || m.startsWith('Only') ? m : 'This link holds a move the rules do not allow.');
  }
  if (!g.over) return fail('The link stops before the game ended.');
  if (i < nibbles.length) return fail('This link has moves after the game ended.');
  const recording: Recording = { format: 1, game: 'holdem', mode: 'sitngo', players, sitngo: { key, startingStack: STARTING_STACK }, hands, result: { chips: g.hand.seats.map((s) => s.stack), places: g.places as number[] } };
  const verdict = verifyRecording(recording);
  return verdict.ok ? { ok: true, recording } : fail(`This link does not replay: ${verdict.error}`);
}

/** The page's link for a game: this page's address with the game in the hash. */
export function shareLink(rec: Recording, base: string): string {
  return `${base.replace(/#.*$/, '')}#/r/${encodeGame(rec)}`;
}

/** The link code in a hash like #/r/<code>, or null. */
export const linkCodeOf = (hash: string): string | null => /^#\/r\/([A-Za-z0-9_-]+)$/.exec(hash)?.[1] ?? null;
