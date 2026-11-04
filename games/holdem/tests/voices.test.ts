// The table talk's casting (shared/voices.ts): every chat model speaks in a voice of Fish Audio's own, decision models
// never talk, and every model has a voice no other has.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { HOLDEM_MODELS } from '../shared/models';
import type { Recording } from '../shared/recording';
import { TTS_MODEL, TTS_VOICES, voiceFor, VOICES } from '../shared/voices';

const chat = HOLDEM_MODELS.filter((m) => m.kind === 'chat');
const replays = (JSON.parse(readFileSync(new URL('../public/demo/index.json', import.meta.url), 'utf8')) as { replays: { file: string; players: string[] }[] }).replays;

describe('the voices of the table talk', () => {
  it('casts every chat model, and only the chat models, in a voice with a Fish Audio id', () => {
    expect(Object.keys(VOICES).sort()).toEqual(chat.map((m) => m.id).sort());
    for (const [id, v] of Object.entries(VOICES)) expect(TTS_VOICES[v], id).toMatch(/^[0-9a-f]{32}$/);
    for (const m of HOLDEM_MODELS.filter((x) => x.kind === 'decision')) expect(voiceFor(m.id), m.id).toBeNull();
    expect(voiceFor('toString')).toBeNull();
    expect(voiceFor('openai/gpt-4o')).toBeNull();
    expect(voiceFor('azure:eu/gpt-6.1-sol')).toBe('Troy');
  });

  it('gives every model a voice of its own, and lists only voices that are cast', () => {
    expect(new Set(Object.values(VOICES)).size).toBe(Object.keys(VOICES).length);
    expect(Object.keys(TTS_VOICES).sort()).toEqual(Object.values(VOICES).sort());
    expect(new Set(Object.values(TTS_VOICES)).size).toBe(Object.keys(TTS_VOICES).length);
  });
});

describe("the curated replays' voices (scripts/voices.ts)", () => {
  it('speaks each line the recording says, in the voice the casting gives, and stays small', () => {
    let bytes = 0;
    for (const r of replays) {
      const name = r.file.replace(/\.json\.gz$/, '');
      const rec = JSON.parse(gunzipSync(readFileSync(new URL(`../public/demo/${r.file}`, import.meta.url))).toString('utf8')) as Recording;
      const talk = rec.hands.flatMap((h, i) => h.actions.flatMap((x, a) => (x.say ? [{ key: `${i + 1}-${a}`, say: x.say, voice: voiceFor(rec.players[x.seat]!.id) }] : [])));
      const dir = new URL(`../public/voices/${name}/`, import.meta.url);
      if (!talk.length) {
        expect(existsSync(dir), name).toBe(false);
        continue;
      }
      const index = JSON.parse(readFileSync(new URL('index.json', dir), 'utf8')) as { format: number; model: string; lines: Record<string, { file: string; say: string; voice: string }> };
      expect(index.format).toBe(1);
      expect(index.model).toBe(TTS_MODEL);
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
