/**
 * Generates the game's sound effects and music through Opper's audio endpoints and writes them to
 * public/audio/. Run once (or to refresh): `npm run gen-audio`. Needs OPPER_API_KEY.
 * Existing files are kept unless --force is passed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const KEY = process.env.OPPER_API_KEY;
if (!KEY) throw new Error('Set OPPER_API_KEY');
const BASE = process.env.OPPER_BASE_URL ?? 'https://api.opper.ai';
const RAW = join(process.cwd(), 'assets', 'audio-raw');
const OUT = join(process.cwd(), 'public', 'audio');
const force = process.argv.includes('--force');

const SFX_MODEL = 'elevenlabs/eleven_text_to_sound_v2';
const MUSIC_MODEL = 'elevenlabs/music_v2_5';

/** name -> [prompt, seconds] */
export const SFX: Record<string, [string, number]> = {
  punch1: ['a single quick punch landing on a body, fighting game hit, dry and snappy, no reverb', 0.5],
  punch2: ['loud close-up punch to the face, crisp smack, fighting game sound effect, single hit', 1.0],
  heavy: ['a single heavy punch impact with a deep thump, fighting game power hit, dry', 0.7],
  kick1: ['a single kick landing on a body, fighting game, meaty thud with a slap, dry', 0.6],
  kick2: ['loud martial arts kick hitting a body, sharp whip crack and thud, single hit, close-up', 1.0],
  block: ['loud punch blocked by forearms, solid knock with a leather clack, fighting game guard, single hit', 1.0],
  whoosh: ['loud fast punch swish through the air, sharp whoosh, close-up, no impact', 1.0],
  whoosh_big: ['a single big swoosh of a kick through the air, short, no impact', 0.6],
  grab: ['a quick cloth grab and shirt pull, short rustle, fighting game throw', 0.5],
  fall: ['a body falling and hitting a wooden floor, heavy thud, short', 0.8],
  ko: ['a huge final knockout punch impact with a deep boom and short reverb tail, fighting game', 1.5],
  bell: ['a single boxing ring bell ding, clean, short', 1.2],
  jump: ['a quick light jump, cloth swish and small grunt-less hop, short', 0.5],
  land: ['feet landing on a wooden floor after a small jump, soft thud, short', 0.5],
  armor: ['a punch hitting a metal shield, short metallic clang with a low thump', 0.6],
  special: ['an energy dash attack, rising whoosh with a punchy burst, fighting game special move, short', 1.0],
};

const MUSIC: Record<string, [string, number]> = {
  theme: [
    'Instrumental background music for a retro arcade fighting game: punchy breakbeat drums, funky slap bass, bright synth stabs and a catchy lead hook, energetic, 140 bpm, steady energy from start to end so it loops well, no vocals',
    96,
  ],
};

async function generate(path: string, body: Record<string, unknown>): Promise<Buffer> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Opper-Name': 'jev-fighter-audio' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  const json = (await res.json()) as { audio?: { b64_json?: string }; error?: { message?: string } };
  if (!res.ok || !json.audio?.b64_json) throw new Error(`HTTP ${res.status}: ${json.error?.message ?? JSON.stringify(json).slice(0, 200)}`);
  console.log(`  cost ${res.headers.get('x-opper-cost') ?? '?'} USD`);
  return Buffer.from(json.audio.b64_json, 'base64');
}

await mkdir(RAW, { recursive: true });
await mkdir(OUT, { recursive: true });
for (const [name, [prompt, seconds]] of Object.entries(SFX)) {
  const file = join(RAW, `${name}.mp3`);
  if (existsSync(file) && !force) continue;
  console.log(`sfx ${name}`);
  await writeFile(file, await generate('/v3/audio/generations', { model: SFX_MODEL, prompt, duration_seconds: seconds, format: 'mp3' }));
}
for (const [name, [prompt, seconds]] of Object.entries(MUSIC)) {
  const file = join(RAW, `${name}.mp3`);
  if (existsSync(file) && !force) continue;
  console.log(`music ${name}`);
  await writeFile(file, await generate('/v3/audio/music', { model: MUSIC_MODEL, prompt, duration_seconds: seconds, instrumental: true, format: 'mp3' }));
}
// Post-process with ffmpeg: effects lose leading silence (so they sound on the frame of impact), are
// normalized to -1 dB peak and fade out; music is loudness-normalized and quieter.
for (const name of [...Object.keys(SFX), ...Object.keys(MUSIC)]) {
  const src = join(RAW, `${name}.mp3`);
  const dst = join(OUT, `${name}.mp3`);
  const isMusic = name in MUSIC;
  const filter = isMusic
    ? 'loudnorm=I=-20:TP=-2:LRA=11'
    : 'silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.005,loudnorm=I=-14:TP=-1:LRA=7,areverse,afade=t=in:d=0.04,areverse';
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', src, '-af', filter, '-ar', '44100', '-b:a', isMusic ? '160k' : '128k', dst]);
  console.log(`processed ${name}`);
}
console.log('done');
