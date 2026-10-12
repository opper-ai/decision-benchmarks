import { describe, expect, it } from 'vitest';
import { answerKey, answerMessage, answerVerifier, signAnswer, signAnswers } from '../server/answers';

const SECRET = 's'.repeat(64);

describe('answer signatures', () => {
  const message = answerMessage('j@13,5', 'pacman', 'left', 'typesafe/jev-1.13.0');

  it('verifies a signature made with the same game key, and nothing else', () => {
    const key = answerKey(SECRET, 'snake');
    const sig = signAnswer(key, message);
    expect(sig).toMatch(/^[\w-]{22}$/);
    const verify = answerVerifier(key);
    expect(verify(message, sig)).toBe(true);
    expect(verify(answerMessage('j@13,5', 'pacman', 'right', 'typesafe/jev-1.13.0'), sig)).toBe(false);
    expect(verify(message, 'A'.repeat(22))).toBe(false);
    expect(verify(message, sig.slice(1))).toBe(false);
  });

  it('keys every game apart: an answer signed for one game never verifies in another', () => {
    const snake = answerKey(SECRET, 'snake');
    const fighter = answerKey(SECRET, 'fighter');
    expect(snake.equals(fighter)).toBe(false);
    expect(answerVerifier(fighter)(message, signAnswer(snake, message))).toBe(false);
    // The key is HMAC(SESSION_SECRET, "decision-benchmarks:answers:" + slug), so another secret is another key too.
    expect(answerVerifier(answerKey('t'.repeat(64), 'snake'))(message, signAnswer(snake, message))).toBe(false);
  });

  it('signs only answered questions that came with a key, at most eight', () => {
    const key = answerKey(SECRET, 'coin');
    const sigs = signAnswers(key, { coin: 'flip-1', other: 'x', long: 'k'.repeat(65) }, { coin: { choice: 'heads' }, other: {}, long: { choice: 'a' } }, 'opper/kev-4b');
    expect(Object.keys(sigs)).toEqual(['coin']);
    expect(answerVerifier(key)(answerMessage('flip-1', 'coin', 'heads', 'opper/kev-4b'), sigs.coin!)).toBe(true);
    expect(signAnswers(key, undefined, { coin: { choice: 'heads' } }, 'm')).toEqual({});
  });
});
