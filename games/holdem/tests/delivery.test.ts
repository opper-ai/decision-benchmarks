// A live table's talk split into what the screens show and what is spoken (shared/delivery.ts): only Grok TTS's
// delivery tags reach text-to-speech, and no tag of any kind reaches a screen.
import { describe, expect, it } from 'vitest';
import { isSpoken, MAX_SPOKEN, MAX_TAGS, splitSay } from '../shared/delivery';
import { LIVE_CHAT_FORMAT, CHAT_FORMAT, MAX_SAY, readAnswer } from '../shared/questions';

const ANY_TAG = /[[\]<>]/;

describe('a line of talk with delivery tags', () => {
  it('keeps the allowed tags for speech and shows the words alone', () => {
    expect(splitSay("Button's cheap tonight. [laugh] I'll call...")).toEqual({ shown: "Button's cheap tonight. I'll call...", spoken: "Button's cheap tonight. [laugh] I'll call..." });
    expect(splitSay('Fine. Take it. <whisper>For now.</whisper>')).toEqual({ shown: 'Fine. Take it. For now.', spoken: 'Fine. Take it. <whisper>For now.</whisper>' });
    expect(splitSay('<slow>I have been waiting</slow> [long-pause] for this.')).toEqual({ shown: 'I have been waiting for this.', spoken: '<slow>I have been waiting</slow> [long-pause] for this.' });
    expect(splitSay('<soft>easy</soft> now [breath]').spoken).toBe('<soft>easy</soft> now [breath]');
    // Written one way: case and spaces inside a tag tidied.
    expect(splitSay('Ha [ LAUGH ] < Whisper >quiet</ whisper >').spoken).toBe('Ha [laugh] <whisper>quiet</whisper>');
  });

  it('gives a line with no tags back as it was, shown and spoken alike', () => {
    expect(splitSay('  Raise.   Your move,  Opus .')).toEqual({ shown: 'Raise. Your move, Opus.', spoken: 'Raise. Your move, Opus.' });
    expect(splitSay('')).toEqual({ shown: '', spoken: '' });
  });

  it(`keeps at most ${MAX_TAGS} tags, the first ones`, () => {
    expect(splitSay('a [laugh] b [sigh] c [pause] d <whisper>e</whisper>')).toEqual({ shown: 'a b c d e', spoken: 'a [laugh] b [sigh] c d e' });
    expect(splitSay('<whisper>a</whisper> [laugh] [sigh]').spoken).toBe('<whisper>a</whisper> [laugh]');
  });

  it('drops unknown, malformed, nested, unclosed and stray tags, keeping their words plain', () => {
    expect(splitSay('[emotion=x] Call. [angry] [laughs] [laugh')).toEqual({ shown: 'Call. laugh', spoken: 'Call. laugh' });
    expect(splitSay('<script>alert(1)</script> Hi')).toEqual({ shown: 'alert(1) Hi', spoken: 'alert(1) Hi' });
    expect(splitSay('<img src=x onerror=alert(1)> Hi')).toEqual({ shown: 'Hi', spoken: 'Hi' });
    expect(splitSay('<whisper>For now.')).toEqual({ shown: 'For now.', spoken: 'For now.' });
    expect(splitSay('For now.</whisper>')).toEqual({ shown: 'For now.', spoken: 'For now.' });
    expect(splitSay('<whisper><slow>x</slow></whisper> ok')).toEqual({ shown: 'x ok', spoken: '<whisper>x</whisper> ok' });
    expect(splitSay('<whisper>a</slow> b')).toEqual({ shown: 'a b', spoken: 'a b' });
    // Anything angle-shaped goes, words and all: '< y >' could be a tag.
    expect(splitSay('x < y > z, [[laugh]] <<whisper>>a</whisper>').shown).toBe('x z, a');
    expect(splitSay('[<laugh>] [pause<]')).toEqual({ shown: 'pause', spoken: 'pause' });
    // A wrapper round no words is no tag, and takes no place.
    expect(splitSay('Fine. <soft> </soft> done [sigh]')).toEqual({ shown: 'Fine. done', spoken: 'Fine. done [sigh]' });
    for (const raw of ['[[[[', '<<<>>>', '<a<b>c>d', '[a[b]c]d', '</>', '<>', '[]', '<whisper', 'whisper>', '<<whisper>>', '[[laugh]]']) {
      const r = splitSay(raw);
      expect(r.shown, raw).not.toMatch(ANY_TAG);
      expect(r.spoken === r.shown || isSpoken(r.spoken), raw).toBe(true);
    }
  });

  it('says nothing for a line of tags with no words', () => {
    expect(splitSay('[laugh] [sigh]')).toEqual({ shown: '', spoken: '' });
    expect(splitSay('<whisper></whisper>')).toEqual({ shown: '', spoken: '' });
    expect(splitSay('<script></script>[emotion=sad]')).toEqual({ shown: '', spoken: '' });
  });

  it(`counts only the words towards ${MAX_SAY} characters, and speaks a line that had to be cut plain`, () => {
    const words = 'w'.repeat(MAX_SAY - 10);
    expect(splitSay(`[laugh] ${words} <whisper>yes</whisper>`)).toEqual({ shown: `${words} yes`, spoken: `[laugh] ${words} <whisper>yes</whisper>` });
    const long = splitSay(`[laugh] ${'word '.repeat(5000)}`);
    expect(long.shown.length).toBeLessThanOrEqual(MAX_SAY);
    expect(long.spoken).toBe(long.shown);
    expect(splitSay('<'.repeat(100_000)).shown).toBe('');
  });

  it('splits again to the same line, and tells a spoken line from anything else', () => {
    for (const raw of ['Nice. [laugh] <whisper>For now.</whisper>', '<slow>a b</slow>, [pause] c!', 'Ha [ LAUGH ] go']) {
      const { spoken } = splitSay(raw);
      expect(splitSay(spoken).spoken).toBe(spoken);
      expect(isSpoken(spoken)).toBe(true);
    }
    for (const v of ['', 'x'.repeat(MAX_SPOKEN + 1), 'a <script>b</script>', 'a [emotion=x]', 'a [LAUGH]', 'a  b', 1, null]) expect(isSpoken(v), String(v)).toBe(false);
  });
});

describe('reading a chat answer', () => {
  const reply = (say: string) => JSON.stringify({ action: 'call', say, mood: 'smug', reasoning: 'r', turn_complete: true });
  const q = { type: 'choice', instructions: '', criteria: { fold: 'x', call: 'y' } } as never;

  it('splits the talk at a live table: say is the words, spoken the words with their tags', () => {
    const a = LIVE_CHAT_FORMAT.parse(reply('Take it. <whisper>For now.</whisper> <b>x</b>'), q)!;
    expect(a).toMatchObject({ say: 'Take it. For now. x', spoken: 'Take it. <whisper>For now.</whisper> x' });
    expect(readAnswer(a, ['fold', 'call'])).toMatchObject({ say: 'Take it. For now. x', spoken: 'Take it. <whisper>For now.</whisper> x' });
    expect(LIVE_CHAT_FORMAT.parse(reply('Just words.'), q)).not.toHaveProperty('spoken');
  });

  it('leaves the bench as it was: its talk is never split', () => {
    expect(CHAT_FORMAT.parse(reply('Take it. <whisper>For now.</whisper>'), q)).toMatchObject({ say: 'Take it. <whisper>For now.</whisper>' });
    expect(CHAT_FORMAT.parse(reply('x'), q)).not.toHaveProperty('spoken');
  });

  it('takes a spoken line only when it is the words said, with allowed tags', () => {
    const base = { type: 'choice', choice: 'call', say: 'Take it.' };
    expect(readAnswer({ ...base, spoken: 'Take it. [laugh]' }, ['call'])).toHaveProperty('spoken', 'Take it. [laugh]');
    expect(readAnswer({ ...base, spoken: 'Something else. [laugh]' }, ['call'])).not.toHaveProperty('spoken');
    expect(readAnswer({ ...base, spoken: 'Take it. <script>x</script>' }, ['call'])).not.toHaveProperty('spoken');
    expect(readAnswer({ type: 'choice', choice: 'call', spoken: '[laugh]' }, ['call'])).not.toHaveProperty('spoken');
  });
});
