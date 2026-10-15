// AI Hold'em's randomness: every deck, every bot's coin and every sampled run-out comes from a seed through these
// functions, so a game is its seeds plus its actions and replays the same everywhere. Isomorphic, erasable TypeScript.

/**
 * mulberry32 (Tommy Ettinger's 32-bit PRNG), as a step on its state: the next number in [0, 1) and the next state.
 * The same form as snake's, kept as plain numbers so a state stays a plain, copyable value.
 */
export function mulberry32(state: number): [number, number] {
  const a = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, a];
}

/** A whole number in [0, n) and the next state. */
export function nextInt(state: number, n: number): [number, number] {
  const [r, next] = mulberry32(state);
  return [Math.floor(r * n), next];
}

/** A seeded Fisher-Yates shuffle (from the last item down): a new array, the input untouched. */
export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed | 0;
  for (let i = out.length - 1; i > 0; i--) {
    let j: number;
    [j, state] = nextInt(state, i + 1);
    const t = out[i]!;
    out[i] = out[j]!;
    out[j] = t;
  }
  return out;
}

/** murmur3's finalizer: spreads every input bit over the whole 32-bit result. */
function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
}

/**
 * A sub-seed from a seed and whole numbers (a hand number, a seat, a count): a signed 32-bit integer that depends on
 * every part and their order. The deck of hand h of a Sit & Go is shuffled with deriveSeed(seed, h), for example.
 */
export function deriveSeed(seed: number, ...parts: readonly number[]): number {
  let h = fmix((seed | 0) ^ 0x9e3779b9);
  for (const p of parts) h = fmix(Math.imul(h ^ (p | 0), 0x27d4eb2f) + 0x165667b1);
  return h | 0;
}

/**
 * A 128-bit hash of text, as 32 hex digits (cyrb128: four murmur-style lanes). Not cryptographic: it names a game
 * played (a recording's fingerprint), so the same game sent twice is recognised, in the browser and in Node alike.
 */
export function hashText(text: string): string {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
}

// ---------- the keyed deal: ChaCha20 (RFC 8439) ----------
//
// A live Sit & Go is dealt from a secret 256-bit table key, not a seed: hand h's deck is a Fisher-Yates shuffle driven
// by the ChaCha20 keystream under the key (nonce: the hand and the purpose), with rejection sampling so every index is
// uniform. The cards a player sees then say nothing about the cards to come: finding the key from them means breaking
// ChaCha20, where a 32-bit seed falls to brute force in minutes. The duplicate cash benchmark keeps its public seeds
// (shuffle above): its deals are meant to be known.

/** A table key: 32 bytes as 64 lowercase hex digits (how recordings and tokens carry it). */
export const TABLE_KEY_HEX = 64;

export const isTableKey = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

/** The key's 32 bytes; throws for anything that is not a table key. */
export function keyBytes(key: string): Uint8Array {
  if (!isTableKey(key)) throw new Error('a table key is 64 lowercase hex digits');
  return Uint8Array.from({ length: 32 }, (_, i) => parseInt(key.slice(2 * i, 2 * i + 2), 16));
}

const word = (b: Uint8Array, i: number): number => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
const rotl = (x: number, n: number): number => ((x << n) | (x >>> (32 - n))) >>> 0;

/** ChaCha20's block function: 16 words of keystream for a 32-byte key, a block counter and a 12-byte nonce. */
export function chachaBlock(key: Uint8Array, counter: number, nonce: Uint8Array): Uint32Array {
  if (key.length !== 32 || nonce.length !== 12) throw new Error('ChaCha20 takes a 32-byte key and a 12-byte nonce');
  const init = new Uint32Array(16);
  init.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
  for (let i = 0; i < 8; i++) init[4 + i] = word(key, 4 * i);
  init[12] = counter >>> 0;
  for (let i = 0; i < 3; i++) init[13 + i] = word(nonce, 4 * i);
  const x = Uint32Array.from(init);
  const qr = (a: number, b: number, c: number, d: number) => {
    x[a] = (x[a]! + x[b]!) >>> 0;
    x[d] = rotl(x[d]! ^ x[a]!, 16);
    x[c] = (x[c]! + x[d]!) >>> 0;
    x[b] = rotl(x[b]! ^ x[c]!, 12);
    x[a] = (x[a]! + x[b]!) >>> 0;
    x[d] = rotl(x[d]! ^ x[a]!, 8);
    x[c] = (x[c]! + x[d]!) >>> 0;
    x[b] = rotl(x[b]! ^ x[c]!, 7);
  };
  for (let round = 0; round < 10; round++) {
    qr(0, 4, 8, 12);
    qr(1, 5, 9, 13);
    qr(2, 6, 10, 14);
    qr(3, 7, 11, 15);
    qr(0, 5, 10, 15);
    qr(1, 6, 11, 12);
    qr(2, 7, 8, 13);
    qr(3, 4, 9, 14);
  }
  for (let i = 0; i < 16; i++) x[i] = (x[i]! + init[i]!) >>> 0;
  return x;
}

/** What a keystream is for, in the nonce: one stream per hand's deck, one for the first button. */
export const PURPOSE = { deck: 0, button: 1 } as const;

/** The ChaCha20 keystream under a table key for one index (a hand) and purpose, read as 32-bit words. */
export class Keystream {
  private readonly key: Uint8Array;
  private readonly nonce: Uint8Array;
  private counter = 0;
  private block: Uint32Array = new Uint32Array(0);
  private at = 16;

  constructor(key: Uint8Array, index: number, purpose: number) {
    this.key = key;
    const n = new Uint8Array(12);
    const put = (i: number, v: number) => n.set([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255], i);
    put(0, index >>> 0);
    put(4, purpose >>> 0);
    this.nonce = n;
  }

  /** The next 32-bit word. */
  next(): number {
    if (this.at === 16) {
      this.block = chachaBlock(this.key, this.counter++, this.nonce);
      this.at = 0;
    }
    return this.block[this.at++]!;
  }

  /** A whole number in [0, n), uniform: words past the largest multiple of n are drawn again. */
  below(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > 2 ** 32) throw new Error('below(n) takes n from 1 to 2^32');
    const limit = 2 ** 32 - (2 ** 32 % n);
    for (;;) {
      const w = this.next();
      if (w < limit) return w % n;
    }
  }
}

/** A Fisher-Yates shuffle (from the last item down) driven by the keystream of `key` for `index` (a hand). */
export function keyedShuffle<T>(items: readonly T[], key: Uint8Array, index: number): T[] {
  const out = [...items];
  const ks = new Keystream(key, index, PURPOSE.deck);
  for (let i = out.length - 1; i > 0; i--) {
    const j = ks.below(i + 1);
    const t = out[i]!;
    out[i] = out[j]!;
    out[j] = t;
  }
  return out;
}

/**
 * A table key made from a small seed, for tests and practice tables only: anyone who knows the seed knows the key, so a
 * real table's key comes from a cryptographic random source (the service's randomBytes, the browser's getRandomValues).
 */
export function keyFromSeed(seed: number): string {
  let state = seed | 0;
  let out = '';
  for (let i = 0; i < 8; i++) {
    let r: number;
    [r, state] = mulberry32(state);
    out += Math.floor(r * 2 ** 32).toString(16).padStart(8, '0');
  }
  return out;
}
