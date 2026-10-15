import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DECK } from '../shared/cards';
import { chachaBlock, isTableKey, keyBytes, Keystream, keyedShuffle, TABLE_KEY_HEX } from '../shared/rng';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const bytesOfWords = (w: Uint32Array) => {
  const out = new Uint8Array(w.length * 4);
  w.forEach((x, i) => out.set([x & 255, (x >>> 8) & 255, (x >>> 16) & 255, x >>> 24], 4 * i));
  return out;
};

describe('ChaCha20 (RFC 8439)', () => {
  it('computes the block function test vector of section 2.3.2', () => {
    const key = Uint8Array.from({ length: 32 }, (_, i) => i);
    const nonce = Uint8Array.from([0, 0, 0, 0x09, 0, 0, 0, 0x4a, 0, 0, 0, 0]);
    expect(hex(bytesOfWords(chachaBlock(key, 1, nonce)))).toBe(
      '10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c068030422aa9ac3d46c4ed2826446079faa0914c2d705d98b02a2b5129cd1de164eb9cbd083e8a2503c4e',
    );
  });

  it('gives the keystream of section 2.4.2 (the sunscreen text, counter 1)', () => {
    const key = Uint8Array.from({ length: 32 }, (_, i) => i);
    const nonce = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0x4a, 0, 0, 0, 0]);
    const plain = Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
    const stream = new Uint8Array([...bytesOfWords(chachaBlock(key, 1, nonce)), ...bytesOfWords(chachaBlock(key, 2, nonce))]);
    const cipher = plain.map((b, i) => b ^ stream[i]!);
    expect(hex(cipher).slice(0, 64)).toBe('6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0b');
    expect(hex(cipher).slice(-36)).toBe('5af90bbf74a35be6b40b8eedf2785e42874d');
  });

  it("matches Node's chacha20 for random keys and nonces", () => {
    for (let t = 0; t < 20; t++) {
      const key = new Uint8Array(randomBytes(32));
      const nonce = new Uint8Array(randomBytes(12));
      const counter = t * 7;
      const iv = Buffer.concat([Buffer.from(Uint32Array.of(counter).buffer), Buffer.from(nonce)]);
      const node = createCipheriv('chacha20', key, iv).update(Buffer.alloc(64));
      expect(hex(bytesOfWords(chachaBlock(key, counter, nonce)))).toBe(node.toString('hex'));
    }
  });
});

describe('the keyed deal', () => {
  const key = keyBytes('00'.repeat(31) + '01');

  it('takes a 256-bit key written as 64 lowercase hex digits, and nothing else', () => {
    expect(TABLE_KEY_HEX).toBe(64);
    expect(isTableKey('ab'.repeat(32))).toBe(true);
    for (const bad of ['AB'.repeat(32), 'ab'.repeat(31), 'zz'.repeat(32), 42, null, '']) expect(isTableKey(bad)).toBe(false);
    expect(() => keyBytes('abc')).toThrow();
    expect(keyBytes('ff'.repeat(32))).toEqual(new Uint8Array(32).fill(255));
  });

  it('draws whole numbers below n uniformly from the keystream (rejection sampling, no modulo bias)', () => {
    const ks = new Keystream(key, 0, 0);
    const counts = new Array(6).fill(0);
    for (let i = 0; i < 60_000; i++) counts[ks.below(6)] += 1;
    for (const c of counts) expect(Math.abs(c - 10_000)).toBeLessThan(500);
    // A bound just over half of 2^32 rejects about half of the words; every draw is still in range.
    const big = 2 ** 31 + 1;
    for (let i = 0; i < 1000; i++) expect(ks.below(big)).toBeLessThan(big);
  });

  it('shuffles a whole deck, the same for the same key, nonce and purpose, and differently for any other', () => {
    const a = keyedShuffle(DECK, key, 3);
    expect([...a].sort((x, y) => x - y)).toEqual([...DECK]);
    expect(keyedShuffle(DECK, key, 3)).toEqual(a);
    expect(keyedShuffle(DECK, key, 4)).not.toEqual(a);
    const flipped = keyBytes('00'.repeat(31) + '03');
    expect(keyedShuffle(DECK, flipped, 3)).not.toEqual(a);
    // Every card can land first: the shuffle uses the keystream, not a 32-bit state.
    const firsts = new Set(Array.from({ length: 2000 }, (_, i) => keyedShuffle(DECK, key, i)[0]));
    expect(firsts.size).toBe(52);
  });
});
