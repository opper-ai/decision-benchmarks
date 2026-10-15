// The curated replays (public/demo/): every entry in index.json is well formed, its file is there, replays to the end
// of a Sit & Go, and says what the entry says (players, hands), with the models' metadata the replay view shows.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { holdemModel } from '../shared/models';
import { verifyRecording, type Recording } from '../shared/recording';
import { parseDemoIndex } from '../src/views/watch-list';

const dir = new URL('../public/demo/', import.meta.url);
const raw = JSON.parse(readFileSync(new URL('index.json', dir), 'utf8')) as { format: number; replays: unknown[] };
const entries = parseDemoIndex(raw);

describe('the curated replays', () => {
  it('lists only well-formed entries', () => {
    expect(raw.format).toBe(1);
    expect(entries).toHaveLength(raw.replays.length);
    expect(new Set(entries.map((e) => e.file)).size).toBe(entries.length);
  });

  it.each(entries.map((e) => [e.file, e] as const))('%s replays and matches its entry', (file, e) => {
    const bytes = readFileSync(new URL(file, dir));
    expect(bytes.length).toBeLessThan(200 * 1024);
    const rec = JSON.parse((file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8')) as Recording;
    const verdict = verifyRecording(rec);
    expect(verdict.ok ? null : verdict.error).toBeNull();
    expect(rec.players.map((p) => p.id)).toEqual(e.players);
    expect(rec.hands.length).toBe(e.hands);
    const actions = rec.hands.flatMap((h) => h.actions);
    // Every model's move kept its latency; the chat models talk, the decision models show their tells.
    expect(actions.every((x) => x.latencyMs !== undefined)).toBe(true);
    rec.players.forEach((p, seat) => {
      const mine = actions.filter((x) => x.seat === seat && x.by === 'answer');
      if (holdemModel(p.id)?.kind === 'decision') expect(mine.every((x) => x.probabilities)).toBe(true);
      else if (mine.length) expect(mine.some((x) => x.say || x.reasoning)).toBe(true);
    });
  });
});
