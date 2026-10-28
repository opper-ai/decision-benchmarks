// The table talk's casting (shared/voices.ts): every chat model speaks in a real Voxtral voice, decision models never
// talk, and the players who meet at a preset table or in a curated replay sound different.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { HOLDEM_MODELS, SETS } from '../shared/models';
import { MOODS, type Recording } from '../shared/recording';
import { speakerOf, voiceFor, VOICES, VOXTRAL_VOICES } from '../shared/voices';

const chat = HOLDEM_MODELS.filter((m) => m.kind === 'chat');
const replays = (JSON.parse(readFileSync(new URL('../public/demo/index.json', import.meta.url), 'utf8')) as { replays: { file: string; players: string[] }[] }).replays;

describe('the voices of the table talk', () => {
  it('casts every chat model, and only the chat models, in voices from the real list', () => {
    expect(Object.keys(VOICES).sort()).toEqual(chat.map((m) => m.id).sort());
    for (const [id, c] of Object.entries(VOICES)) {
      expect(VOXTRAL_VOICES, id).toContain(c.voice);
      for (const [mood, v] of Object.entries(c.moods ?? {})) {
        expect(MOODS, id).toContain(mood);
        expect(VOXTRAL_VOICES, `${id} ${mood}`).toContain(v);
        // A mood is the same speaker, only in another mood.
        expect(speakerOf(v), `${id} ${mood}`).toBe(speakerOf(c.voice));
      }
    }
    for (const m of HOLDEM_MODELS.filter((x) => x.kind === 'decision')) expect(voiceFor(m.id), m.id).toBeNull();
  });

  it('speaks a mood in its variant where the speaker has one, else in the plain voice', () => {
    expect(voiceFor('azure:eu/gpt-6-luna', 'smug')).toBe('gb_jane_sarcasm');
    expect(voiceFor('azure:eu/gpt-6-luna', 'nervous')).toBe('gb_jane_confused');
    expect(voiceFor('azure:eu/gpt-6-luna', 'relaxed')).toBe('gb_jane_neutral');
    expect(voiceFor('azure:eu/gpt-6.1-sol', 'annoyed')).toBe('en_paul_frustrated');
    expect(voiceFor('azure:eu/gpt-6.1-sol', 'nervous')).toBe('en_paul_neutral');
    expect(voiceFor('aws/claude-opus-5-5', 'smug')).toBe(VOICES['aws/claude-opus-5-5']!.voice);
    expect(voiceFor('aws/claude-opus-5-5')).toBe(VOICES['aws/claude-opus-5-5']!.voice);
    expect(voiceFor('toString')).toBeNull();
    expect(voiceFor('openai/gpt-4o')).toBeNull();
  });

  it('gives the players at each preset table, and in each curated replay, different speakers', () => {
    const groups = [...SETS.filter((s) => s.id !== 'decision').map((s) => ({ name: s.name, ids: s.models })), ...replays.map((r) => ({ name: r.file, ids: r.players.filter((id) => VOICES[id]) }))];
    for (const g of groups) {
      const speakers = g.ids.map((id) => speakerOf(VOICES[id]!.voice));
      expect(new Set(speakers).size, `${g.name}: ${speakers.join(', ')}`).toBe(speakers.length);
    }
  });
});

describe("the curated replays' voices (scripts/voices.ts)", () => {
  it('speaks each line the recording says, in the voice the casting gives, and stays small', () => {
    let bytes = 0;
    for (const r of replays) {
      const name = r.file.replace(/\.json\.gz$/, '');
      const rec = JSON.parse(gunzipSync(readFileSync(new URL(`../public/demo/${r.file}`, import.meta.url))).toString('utf8')) as Recording;
      const talk = rec.hands.flatMap((h, i) => h.actions.flatMap((x, a) => (x.say ? [{ key: `${i + 1}-${a}`, say: x.say, voice: voiceFor(rec.players[x.seat]!.id, x.mood) }] : [])));
      const dir = new URL(`../public/voices/${name}/`, import.meta.url);
      if (!talk.length) {
        expect(existsSync(dir), name).toBe(false);
        continue;
      }
      const index = JSON.parse(readFileSync(new URL('index.json', dir), 'utf8')) as { format: number; lines: Record<string, { file: string; say: string; voice: string }> };
      expect(index.format).toBe(1);
      const byKey = new Map(talk.map((t) => [t.key, t]));
      // Nearly every line (the provider refuses the odd one), each the recording's own words in its casting's voice.
      expect(Object.keys(index.lines).length, name).toBeGreaterThanOrEqual(talk.length - 3);
      for (const [key, l] of Object.entries(index.lines)) {
        expect(byKey.get(key), `${name} ${key}`).toMatchObject({ say: l.say, voice: l.voice });
        expect(l.file).toBe(`${key}.mp3`);
        bytes += statSync(new URL(l.file, dir)).size;
      }
    }
    expect(bytes).toBeLessThan(15e6);
  });
});
