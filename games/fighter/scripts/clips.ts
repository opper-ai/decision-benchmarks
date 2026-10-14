// Renders the highlight of every match Watch plays (public/demo/index.json), for people to download and share, as
// jevman does with its games: the 18 seconds with the most damage dealt as an MP4, and the best 10 seconds of those as
// a GIF, drawn by the game's own renderer (the stage, the HUD, the thought bubbles) at 1280x720, about 2 MB and
// 1.5 MB. No model is called: it is a replay.
// Writes public/clips/<name>.mp4 and .gif (<name> as the recording's file, without .fight.json.gz) and their sizes to
// src/clips.ts, which the page reads to offer them.
// Run: npm i --no-save @napi-rs/canvas && node games/fighter/scripts/clips.ts [<recording file> ...]
// Needs ffmpeg.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { TICK_HZ, clone, type GameState } from '../shared/engine/engine.ts';
import { ReplayPlayer, type Replay } from '../shared/replay.ts';
import { bestWindow, damagePerFrame, GIF_S, HIGHLIGHT_S } from '../src/highlight.ts';

const GAME = fileURLToPath(new URL('..', import.meta.url));
const W = 1280, H = 720, FPS = 30;
const OUT = join(GAME, 'public/clips');
const MANIFEST = join(GAME, 'src/clips.ts');

type Canvas = any; // @napi-rs/canvas is installed for this script only (see Run above)
const canvasModule = '@napi-rs/canvas';
const { createCanvas, GlobalFonts } = (await import(canvasModule).catch(() => {
  console.error('This script needs @napi-rs/canvas: npm i --no-save @napi-rs/canvas');
  process.exit(1);
})) as { createCanvas: (w: number, h: number) => Canvas; GlobalFonts: { registerFromPath: (path: string, name: string) => void } };
for (const [file, name] of [
  ['caveat-latin.woff2', 'Caveat'],
  ['wix-madefor-display-latin.woff2', 'Wix Madefor Display'],
  ['wix-madefor-text-latin.woff2', 'Wix Madefor Text'],
  ['jetbrains-mono-latin.woff2', 'JetBrains Mono'],
] as const) {
  GlobalFonts.registerFromPath(join(GAME, 'public/fonts', file), name);
}
// The renderer draws its paper once on a canvas of its own: give it one.
(globalThis as { document?: unknown }).document = {
  createElement: (tag: string) => {
    if (tag !== 'canvas') throw new Error(`clips: no <${tag}> outside a browser`);
    return createCanvas(1, 1);
  },
};
const { FightRenderer } = await import('../src/render/renderer.ts');
const { DISPLAY_FONT } = await import('../src/theme.ts');
const { bubblesAt, decisionsBySide } = await import('../src/views/bubbles.ts');

function ffmpeg(args: string[], input?: 'pipe') {
  return spawn('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: [input ?? 'ignore', 'inherit', 'inherit'] });
}
const done = (p: ReturnType<typeof spawn>) => new Promise<void>((res, rej) => p.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited with ${code}`)))));

/** Draws `n` frames of the match from frame `start` into ffmpeg, as the page's clip export draws them (src/export.ts). */
async function render(r: Replay, player: ReplayPlayer, start: number, n: number, mp4: string): Promise<void> {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const renderer = new FightRenderer(canvas, r.fighters, { width: W, height: H });
  let virtualMs = 0;
  renderer.now = () => virtualMs;
  const bySide = decisionsBySide(r);
  const ticksPerFrame = TICK_HZ / FPS;
  let state: GameState = player.stateAt(Math.min(player.endTick, start * ticksPerFrame));
  let prev = clone(state);
  renderer.setState(prev, state);
  renderer.reset();
  const title = `${r.fighters[0].label} vs ${r.fighters[1].label}`;
  const enc = ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '26', '-preset', 'slow', '-tune', 'animation', '-movflags', '+faststart', mp4], 'pipe');
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < ticksPerFrame && state.round.phase !== 'over'; t++) {
      prev = clone(state);
      const events = player.advance(state);
      renderer.setState(prev, state);
      if (events.length) renderer.onEvents(events);
    }
    virtualMs = (k / FPS) * 1000;
    const b = bubblesAt(bySide, state.tick, virtualMs);
    renderer.bubbles[0] = b[0];
    renderer.bubbles[1] = b[1];
    renderer.frame(1, 1 / FPS);
    // The caption a shared clip carries, as the page's export draws it.
    ctx.save();
    ctx.font = `700 ${Math.round(H / 26)}px ${DISPLAY_FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(27,46,64,0.55)';
    ctx.fillText(`${title} · jev fighter`, W - 18, H - 12);
    ctx.restore();
    const px = ctx.getImageData(0, 0, W, H).data as Uint8ClampedArray;
    if (!enc.stdin!.write(Buffer.from(px.buffer, px.byteOffset, px.byteLength))) await new Promise((res) => enc.stdin!.once('drain', res));
  }
  enc.stdin!.end();
  await done(enc);
}

const index = JSON.parse(readFileSync(join(GAME, 'public/demo/index.json'), 'utf8')) as { demos: { file: string; title: string }[] };
const only = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
type Clip = { file: string; mp4: number; gif: number };
/** The clips already made (a run for some recordings keeps the others'): the object after `= ` in src/clips.ts. */
const written = existsSync(MANIFEST) ? readFileSync(MANIFEST, 'utf8') : '';
const manifest: Record<string, Clip> = written ? (JSON.parse(written.slice(written.indexOf('= {') + 2).replace(/;\s*$/, '')) as Record<string, Clip>) : {};
for (const d of index.demos) {
  if (only.length && !only.includes(d.file)) continue;
  const r = JSON.parse(gunzipSync(readFileSync(join(GAME, 'public/demo', d.file))).toString('utf8')) as Replay;
  const player = new ReplayPlayer(r);
  const dmg = damagePerFrame(player, FPS);
  const n = Math.min(HIGHLIGHT_S * FPS, dmg.length);
  const start = bestWindow(dmg, n);
  const gifAt = bestWindow(dmg, Math.min(GIF_S * FPS, n), start, start + n) - start;
  const name = d.file.replace(/\.fight\.json\.gz$/, '');
  const mp4 = join(OUT, `${name}.mp4`);
  const gif = join(OUT, `${name}.gif`);
  await render(r, player, start, n, mp4);
  // The GIF: smaller and slower than the video (480 px, 12 a second, 64 colours of its own), looping, about 1.5 MB.
  const palette = 'fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle';
  await done(ffmpeg(['-ss', (gifAt / FPS).toFixed(2), '-t', String(GIF_S), '-i', mp4, '-vf', palette, '-loop', '0', gif]));
  manifest[d.file] = { file: name, mp4: statSync(mp4).size, gif: statSync(gif).size };
  const hit = dmg.slice(start, start + n).reduce((a, b) => a + b, 0);
  console.log(`${d.file}: ${name}.mp4 from ${(start / FPS).toFixed(1)} s (${hit} damage), ${name}.gif from +${(gifAt / FPS).toFixed(1)} s`);
}
const header = '// Written by scripts/clips.ts: the highlight of each Watch recording in public/clips (an MP4 and a GIF), and their\n// sizes in bytes, by recording file.\n';
writeFileSync(MANIFEST, `${header}export const CLIPS: Record<string, { file: string; mp4: number; gif: number }> = ${JSON.stringify(manifest, null, 2)};\n`);
