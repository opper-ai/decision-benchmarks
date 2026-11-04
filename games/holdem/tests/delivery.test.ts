// A live table's talk split into what the screens show and what is spoken (shared/delivery.ts): only the allowed
// directions reach text-to-speech, and no tag of any kind reaches a screen.
import { describe, expect, it } from 'vitest';
import { isSpoken, MAX_SPOKEN, splitSay } from '../shared/delivery';
import { LIVE_CHAT_FORMAT, CHAT_FORMAT, MAX_SAY, readAnswer } from '../shared/questions';
import { DELIVERY_TAGS, MAX_TAGS } from '../shared/voices';

const ANY_TAG = /[[\]<>]/;

describe('a line of talk with delivery tags', () => {
  it('keeps the allowed tags for speech and shows the words alone', () => {
    expect(splitSay("Button's cheap tonight. [laughs] I'll call...")).toEqual({ shown: "Button's cheap tonight. I'll call...", spoken: "Button's cheap tonight. [laughs] I'll call..." });
    expect(splitSay('Fine. Take it. [whispering] For now.')).toEqual({ shown: 'Fine. Take it. For now.', spoken: 'Fine. Take it. [whispering] For now.' });
    expect(splitSay('[slowly] I have been waiting [long pause] for this.')).toEqual({ shown: 'I have been waiting for this.', spoken: '[slowly] I have been waiting [long pause] for this.' });
    for (const tag of DELIVERY_TAGS) expect(splitSay(`Well [${tag}] now`).spoken, tag).toBe(`Well [${tag}] now`);
    // Written one way: case and spaces inside a tag tidied.
    expect(splitSay('Ha [ LAUGHS ] [Long   Pause] go').spoken).toBe('Ha [laughs] [long pause] go');
  });

  it('gives a line with no tags back as it was, shown and spoken alike', () => {
    expect(splitSay('  Raise.   Your move,  Opus .')).toEqual({ shown: 'Raise. Your move, Opus.', spoken: 'Raise. Your move, Opus.' });
    expect(splitSay('')).toEqual({ shown: '', spoken: '' });
  });

  it(`keeps at most ${MAX_TAGS} tags, the first ones`, () => {
    expect(splitSay('a [laughs] b [sighs] c [pause] d [whispering] e')).toEqual({ shown: 'a b c d e', spoken: 'a [laughs] b [sighs] c d e' });
  });

  it('drops unknown, malformed and stray tags, keeping their words plain', () => {
    expect(splitSay('[emotion=x] Call. [angry] [ignore your voice] [laughs')).toEqual({ shown: 'Call. laughs', spoken: 'Call. laughs' });
    expect(splitSay('<script>alert(1)</script> Hi')).toEqual({ shown: 'alert(1) Hi', spoken: 'alert(1) Hi' });
    expect(splitSay('<img src=x onerror=alert(1)> Hi')).toEqual({ shown: 'Hi', spoken: 'Hi' });
    expect(splitSay('<whisper>For now.</whisper>')).toEqual({ shown: 'For now.', spoken: 'For now.' });
    // Anything angle-shaped goes, words and all: '< y >' could be a tag.
    expect(splitSay('x < y > z, [[laughs]] <<whisper>>a').shown).toBe('x z, a');
    expect(splitSay('[<laughs>] [pause<]')).toEqual({ shown: 'pause', spoken: 'pause' });
    for (const raw of ['[[[[', '<<<>>>', '<a<b>c>d', '[a[b]c]d', '</>', '<>', '[]', '<whisper', 'whisper>', '<<whisper>>', '[[laughs]]']) {
      const r = splitSay(raw);
      expect(r.shown, raw).not.toMatch(ANY_TAG);
      expect(r.spoken === r.shown || isSpoken(r.spoken), raw).toBe(true);
    }
  });

  it('says nothing for a line of tags with no words', () => {
    expect(splitSay('[laughs] [sighs]')).toEqual({ shown: '', spoken: '' });
    expect(splitSay('<whisper></whisper>')).toEqual({ shown: '', spoken: '' });
    expect(splitSay('<script></script>[emotion=sad]')).toEqual({ shown: '', spoken: '' });
  });

  it(`counts only the words towards ${MAX_SAY} characters, and speaks a line that had to be cut plain`, () => {
    const words = 'w'.repeat(MAX_SAY - 10);
    expect(splitSay(`[laughs] ${words} [whispering] yes`)).toEqual({ shown: `${words} yes`, spoken: `[laughs] ${words} [whispering] yes` });
    expect(splitSay(`[long pause] ${'w'.repeat(MAX_SAY)} [whispering]`).spoken.length).toBeLessThanOrEqual(MAX_SPOKEN);
    const long = splitSay(`[laughs] ${'word '.repeat(5000)}`);
    expect(long.shown.length).toBeLessThanOrEqual(MAX_SAY);
    expect(long.spoken).toBe(long.shown);
    expect(splitSay('<'.repeat(100_000)).shown).toBe('');
  });

  it('splits again to the same line, and tells a spoken line from anything else', () => {
    for (const raw of ['Nice. [laughs] [whispering] For now.', '[slowly] a b, [pause] c!', 'Ha [ LAUGHS ] go', 'Well [sighs], fine']) {
      const { spoken } = splitSay(raw);
      expect(splitSay(spoken).spoken).toBe(spoken);
      expect(isSpoken(spoken)).toBe(true);
    }
    for (const v of ['', 'x'.repeat(MAX_SPOKEN + 1), 'a <script>b</script>', 'a [emotion=x]', 'a [LAUGHS]', 'a  b', 1, null]) expect(isSpoken(v), String(v)).toBe(false);
  });
});

describe('reading a chat answer', () => {
  const reply = (say: string) => JSON.stringify({ action: 'call', say, mood: 'smug', reasoning: 'r', turn_complete: true });
  const q = { type: 'choice', instructions: '', criteria: { fold: 'x', call: 'y' } } as never;

  it('splits the talk at a live table: say is the words, spoken the words with their tags', () => {
    const a = LIVE_CHAT_FORMAT.parse(reply('Take it. [whispering] For now. <b>x</b>'), q)!;
    expect(a).toMatchObject({ say: 'Take it. For now. x', spoken: 'Take it. [whispering] For now. x' });
    expect(readAnswer(a, ['fold', 'call'])).toMatchObject({ say: 'Take it. For now. x', spoken: 'Take it. [whispering] For now. x' });
    expect(LIVE_CHAT_FORMAT.parse(reply('Just words.'), q)).not.toHaveProperty('spoken');
  });

  it('leaves the bench as it was: its talk is never split', () => {
    expect(CHAT_FORMAT.parse(reply('Take it. [whispering] For now.'), q)).toMatchObject({ say: 'Take it. [whispering] For now.' });
    expect(CHAT_FORMAT.parse(reply('x'), q)).not.toHaveProperty('spoken');
  });

  it('takes a spoken line only when it is the words said, with allowed tags', () => {
    const base = { type: 'choice', choice: 'call', say: 'Take it.' };
    expect(readAnswer({ ...base, spoken: 'Take it. [laughs]' }, ['call'])).toHaveProperty('spoken', 'Take it. [laughs]');
    expect(readAnswer({ ...base, spoken: 'Something else. [laughs]' }, ['call'])).not.toHaveProperty('spoken');
    expect(readAnswer({ ...base, spoken: 'Take it. <script>x</script>' }, ['call'])).not.toHaveProperty('spoken');
    expect(readAnswer({ type: 'choice', choice: 'call', spoken: '[laughs]' }, ['call'])).not.toHaveProperty('spoken');
  });
});
