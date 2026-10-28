// Speaks the table talk of the curated replays once, so a replay's visitors (signed out, anyone) hear the voices without
// a live text-to-speech call: every chat model's `say` in public/demo/*.json.gz, in its voice (shared/voices.ts), as
// written (the recordings carry no delivery tags).
//
//   node games/holdem/scripts/voices.ts [--only <replay>]... [--force] [--bitrate 24]
//
// Writes games/holdem/public/voices/<replay>/<hand>-<action>.mp3 (mono, 22.05 kHz, --bitrate kbps) and
// voices/<replay>/index.json: { format: 1, model, lines: { "<hand>-<action>": { file, say } } }, which the replay view
// reads (src/voice.ts replayVoices); a line plays only while the recording still says the same words. A line already
// rendered with the same model, voice and words is kept unless --force. Replays without talk (the decision models) get no folder.
//
// Calls Opper's speech API (POST /v3/audio/speech) with OPPER_API_KEY; with an organization key, also set OPPER_PROJECT
// to a project UUID. Needs ffmpeg on PATH (to make the files small). About $0.0008 a line (xAI Grok TTS: $15 per million
// characters); the cost and the size are printed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { speak } from '../server/speech.ts';
import type { Recording } from '../shared/recording.ts';
import { TTS_MODEL, voiceFor } from '../shared/voices.ts';

const here = dirname(fileURLToPath(import.meta.url));

interface Line {
  key: string;
  say: string;
  voice: string;
}

async function main() {
  const { values } = parseArgs({
    options: {
      only: { type: 'string', multiple: true, default: [] },
      force: { type: 'boolean', default: false },
      bitrate: { type: 'string', default: '24' },
      concurrency: { type: 'string', default: '4' },
      demo: { type: 'string', default: join(here, '../public/demo') },
      out: { type: 'string', default: join(here, '../public/voices') },
    },
  });
  const die = (msg: string): never => {
    console.error(msg);
    process.exit(1);
  };
  const apiKey = process.env.OPPER_API_KEY || die('set OPPER_API_KEY (and OPPER_PROJECT for an organization key)');
  const project = process.env.OPPER_PROJECT;
  const baseUrl = process.env.OPPER_BASE_URL || 'https://api.opper.ai';
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    die('needs ffmpeg on PATH');
  }
  const index = JSON.parse(readFileSync(join(values.demo, 'index.json'), 'utf8')) as { replays: { file: string }[] };
  const names = index.replays.map((r) => r.file.replace(/\.json\.gz$/, ''));
  for (const o of values.only) if (!names.includes(o)) die(`unknown replay: ${o} (one of ${names.join(', ')})`);
  const deps = { apiKey, baseUrl, ...(project ? { project } : {}), fetch, now: () => performance.now(), callName: 'decision-benchmarks-holdem-voices' };
  const tmp = join(tmpdir(), `holdem-voices-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  let cost = 0;
  let spoken = 0;
  let bytes = 0;
  let files = 0;
  let unspoken = 0;
  for (const name of values.only.length ? values.only : names) {
    const rec = JSON.parse(gunzipSync(readFileSync(join(values.demo, `${name}.json.gz`))).toString('utf8')) as Recording;
    const lines: Line[] = [];
    rec.hands.forEach((h, i) =>
      h.actions.forEach((x, a) => {
        const p = rec.players[x.seat];
        const voice = x.say && p?.kind === 'model' ? voiceFor(p.id) : null;
        if (x.say && voice) lines.push({ key: `${i + 1}-${a}`, say: x.say, voice });
      }),
    );
    if (!lines.length) {
      console.log(`${name}: no talk`);
      continue;
    }
    const dir = join(values.out, name);
    mkdirSync(dir, { recursive: true });
    const indexPath = join(dir, 'index.json');
    const previous = existsSync(indexPath) ? (JSON.parse(readFileSync(indexPath, 'utf8')) as { model?: string; lines: Record<string, { file: string; say: string; voice?: string }> }) : null;
    const before = previous?.model === TTS_MODEL ? previous.lines : {};
    const out: Record<string, { file: string; say: string; voice: string }> = {};
    let next = 0;
    const work = async () => {
      while (next < lines.length) {
        const l = lines[next++]!;
        const file = `${l.key}.mp3`;
        const path = join(dir, file);
        const had = before[l.key];
        if (!values.force && had && had.say === l.say && had.voice === l.voice && existsSync(path)) {
          out[l.key] = { file, say: l.say, voice: l.voice };
          continue;
        }
        // The provider is sometimes briefly unavailable (5xx): three tries, then the line is left unspoken.
        let r = await speak(l.say, l.voice, deps);
        for (let t = 1; r.status !== 200 && r.status >= 500 && t < 3; t++) {
          await new Promise((done) => setTimeout(done, 1000 * 2 ** t));
          r = await speak(l.say, l.voice, deps);
        }
        if (r.status !== 200 && r.status < 500) die(`${name} ${l.key}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        if (r.status !== 200) {
          console.log(`  ${name} ${l.key} left unspoken: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 120)}: ${l.say}`);
          unspoken++;
          continue;
        }
        const ok = r as Extract<typeof r, { status: 200 }>;
        cost += ok.costUsd ?? 0;
        spoken++;
        const raw = join(tmp, `${name}-${file}`);
        writeFileSync(raw, Buffer.from(ok.body.audio, 'base64'));
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-ac', '1', '-ar', '22050', '-b:a', `${values.bitrate}k`, '-map_metadata', '-1', path]);
        rmSync(raw);
        out[l.key] = { file, say: l.say, voice: l.voice };
        if (spoken % 25 === 0) console.log(`  ${spoken} lines spoken, $${cost.toFixed(4)}`);
      }
    };
    await Promise.all(Array.from({ length: Number(values.concurrency) }, work));
    const kept = lines.filter((l) => out[l.key]);
    const sorted = Object.fromEntries(kept.map((l) => [l.key, out[l.key]!]));
    writeFileSync(indexPath, `${JSON.stringify({ format: 1, model: TTS_MODEL, lines: sorted }, null, 1)}\n`);
    const size = kept.reduce((n, l) => n + statSync(join(dir, `${l.key}.mp3`)).size, 0) + statSync(indexPath).size;
    bytes += size;
    files += kept.length;
    console.log(`${name}: ${kept.length} of ${lines.length} lines, ${(size / 1e6).toFixed(2)} MB`);
  }
  rmSync(tmp, { recursive: true, force: true });
  console.log(`${files} lines in all, ${(bytes / 1e6).toFixed(2)} MB; ${spoken} spoken now for $${cost.toFixed(4)}${unspoken ? `; ${unspoken} the provider would not speak` : ''}`);
}

await main();
