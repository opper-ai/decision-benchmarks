// The table talk's casting (shared/voices.ts): every chat model speaks in a real Grok TTS voice, decision models never
// talk, and the players who meet at a preset table or in a curated replay sound different.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { HOLDEM_MODELS, SETS } from '../shared/models';
import type { Recording } from '../shared/recording';
import { TTS_MODEL, TTS_VOICES, voiceFor, VOICES } from '../shared/voices';

const chat = HOLDEM_MODELS.filter((m) => m.kind === 'chat');
const replays = (JSON.parse(readFileSync(new URL('../public/demo/index.json', import.meta.url), 'utf8')) as { replays: { file: string; players: string[] }[] }).replays;

describe('the voices of the table talk', () => {
  it('casts every chat model, and only the chat models, in one of the real voices', () => {
    expect(Object.keys(VOICES).sort()).toEqual(chat.map((m) => m.id).sort());
    for (const [id, v] of Object.entries(VOICES)) expect(TTS_VOICES, id).toContain(v);
    for (const m of HOLDEM_MODELS.filter((x) => x.kind === 'decision')) expect(voiceFor(m.id), m.id).toBeNull();
    expect(voiceFor('toString')).toBeNull();
    expect(voiceFor('openai/gpt-4o')).toBeNull();
    expect(voiceFor('azure:eu/gpt-6.1-sol')).toBe('rex');
  });

  it('gives the players at each preset table, and in each curated replay, different voices (Claude vs GPT: four men, three male voices)', () => {
    const groups = [...SETS.filter((s) => s.id !== 'decision').map((s) => ({ name: s.name, ids: s.models })), ...replays.map((r) => ({ name: r.file, ids: r.players.filter((id) => VOICES[id]) }))];
    for (const g of groups) {
      const voices = g.ids.map((id) => VOICES[id]!);
      // The one exception, by design (shared/voices.ts): Opus 5.5 and GPT-5.6 Terra share leo there.
      const shared = g.name === 'claude-vs-gpt.json.gz' ? 1 : 0;
      expect(new Set(voices).size, `${g.name}: ${voices.join(', ')}`).toBe(voices.length - shared);
    }
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
