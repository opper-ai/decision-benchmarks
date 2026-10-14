// Renders the highlight of every game Watch plays (src/recordings.ts), for people to download and share, as jevman
// does with its games: the 18 seconds in which the model ate the most apples as an MP4, and the best 10 seconds of
// those as a GIF, drawn by the page's own board renderer in the arcade cabinet, at Watch's pace. No model is called:
// it is a replay.
// Writes public/clips/<name>.mp4 and .gif (<name> as the recording's file, without .json.gz) and their sizes to
// src/clips.ts, which the page reads to offer them.
// Run: npm i --no-save @napi-rs/canvas && node games/snake/scripts/clips.ts [<model id> ...]
// Needs ffmpeg.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { SIZE, type GameState } from '../shared/engine.ts';
import { bestWindow, framesOf, GIF_S, HIGHLIGHT_S } from '../src/highlight.ts';
import { demoFrom, RECORDINGS } from '../src/recordings.ts';
import { AI, canvasPainter, paintBoard } from '../src/render.ts';

const GAME = fileURLToPath(new URL('..', import.meta.url));
const W = 1080, H = 1240, FPS = 30;
/** Pixels per cell: the board (the wall takes a cell on each side) fills the cabinet's width. */
const CELL = 55;
const BOARD = (SIZE + 2) * CELL;
const BOARD_X = (W - BOARD) / 2, BOARD_Y = 140;
const PIXEL = '"Press Start 2P"';
const OUT = join(GAME, 'public/clips');
const MANIFEST = join(GAME, 'src/clips.ts');

type Canvas = any; // @napi-rs/canvas is installed for this script only (see Run above)
const canvasModule = '@napi-rs/canvas';
const { createCanvas, GlobalFonts } = (await import(canvasModule).catch(() => {
  console.error('This script needs @napi-rs/canvas: npm i --no-save @napi-rs/canvas');
  process.exit(1);
})) as { createCanvas: (w: number, h: number) => Canvas; GlobalFonts: { registerFromPath: (path: string, name: string) => void } };
GlobalFonts.registerFromPath(join(GAME, 'public/fonts/press-start-2p-latin.woff2'), 'Press Start 2P');
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

/** The best single game any ranked model played: the cabinet's HIGH SCORE in every clip, as on the page. */
const board = JSON.parse(readFileSync(join(GAME, 'public/leaderboard.json'), 'utf8')) as { entries: { metric: { best: number } }[] };
const HIGH = String(Math.max(0, ...board.entries.map((e) => e.metric.best)));

/** Pixel lettering, letter-spaced by hand. */
function text(s: string, x: number, y: number, size: number, color: string, align: 'left' | 'center' | 'right', spacing = 0): void {
  ctx.font = `${size}px ${PIXEL}`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const chars = [...s];
  const adv = chars.map((c) => ctx.measureText(c).width + spacing);
  const total = adv.reduce((a, b) => a + b, 0) - spacing;
  let cx = align === 'left' ? x : align === 'center' ? x - total / 2 : x - total;
  chars.forEach((c, i) => {
    ctx.fillText(c, cx, y);
    cx += adv[i]!;
  });
}

/** One frame: the cabinet's top strip (who plays and the apples, HIGH SCORE, the steps), the board, then the address. */
function drawCard(plate: string, s: GameState): void {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#2121de';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(10, 11, W - 20, H - 22, 22);
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(21.5, 21.5, W - 43, H - 43, 13);
  ctx.stroke();
  // A long name shrinks to fit its third of the strip, where the page's ellipsis would cut it.
  const plateSize = Math.min(22, 330 / (plate.length * 1.04));
  text(plate, 46, 45 + (22 - plateSize) * 0.875, plateSize, '#00e5ff', 'left', plateSize * 0.04);
  text(String(s.apples), 46, 83, 35, '#ffffff', 'left', 0.7);
  text('HIGH SCORE', W / 2, 45, 22, '#8f97ff', 'center', 0.9);
  text(HIGH, W / 2, 83, 35, '#ffffff', 'center', 0.7);
  text('STEPS', W - 46, 45, 22, '#8f97ff', 'right', 0.9);
  text(String(s.steps), W - 46, 83, 35, '#ffffff', 'right', 0.7);
  paintBoard(canvasPainter(ctx), s, AI, CELL, BOARD_X, BOARD_Y);
  if (s.over) {
    // GAME OVER over the board, as the page's banner says it.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(BOARD_X, BOARD_Y, BOARD, BOARD);
    text(`GAME OVER: ${s.apples} APPLES`, W / 2, BOARD_Y + BOARD / 2 - 18, 36, '#ff3b3b', 'center', 1);
  }
  text('opper.ai/decision-benchmarks/snake', W / 2, BOARD_Y + BOARD + 34, 20, '#ffd800', 'center', 0);
}

function ffmpeg(args: string[], input?: 'pipe') {
  return spawn('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: [input ?? 'ignore', 'inherit', 'inherit'] });
}
const done = (p: ReturnType<typeof spawn>) => new Promise<void>((res, rej) => p.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited with ${code}`)))));

async function render(e: (typeof RECORDINGS)[number]): Promise<{ file: string; mp4: number; gif: number }> {
  const demo = demoFrom(JSON.parse(gunzipSync(readFileSync(join(GAME, 'public', e.path))).toString('utf8')));
  if (!demo) throw new Error(`${e.path} does not replay to the game it claims`);
  const file = e.path.replace(/^demo\//, '').replace(/\.json\.gz$/, '');
  const frames = framesOf(demo.seed, demo.moves, FPS);
  const n = Math.min(HIGHLIGHT_S * FPS, frames.length);
  const start = bestWindow(frames, n);
  const gifAt = bestWindow(frames, Math.min(GIF_S * FPS, n), start, start + n) - start;
  const mp4 = join(OUT, `${file}.mp4`);
  const gif = join(OUT, `${file}.gif`);
  const enc = ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'medium', '-tune', 'animation', '-movflags', '+faststart', mp4], 'pipe');
  const write = (buf: Buffer) => new Promise<void>((res) => (enc.stdin!.write(buf) ? res() : enc.stdin!.once('drain', () => res())));
  const plate = e.name.toUpperCase();
  for (let i = start; i < start + n; i++) {
    drawCard(plate, frames[i]!);
    const px = ctx.getImageData(0, 0, W, H).data as Uint8ClampedArray;
    await write(Buffer.from(px.buffer, px.byteOffset, px.byteLength));
  }
  enc.stdin!.end();
  await done(enc);
  // The GIF: smaller than the video (480 px wide, 15 a second, the board's few colours), looping.
  const palette = 'fps=15,scale=480:-1:flags=neighbor,split[a][b];[a]palettegen=max_colors=32:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle';
  await done(ffmpeg(['-ss', (gifAt / FPS).toFixed(2), '-t', String(Math.min(GIF_S, n / FPS)), '-i', mp4, '-vf', palette, '-loop', '0', gif]));
  const gained = frames[start + n - 1]!.apples - frames[start]!.apples;
  console.log(`${e.model}: ${file}.mp4 from ${(start / FPS).toFixed(1)} s (+${gained} apples), ${file}.gif from +${(gifAt / FPS).toFixed(1)} s`);
  return { file, mp4: statSync(mp4).size, gif: statSync(gif).size };
}

const only = process.argv.slice(2).filter((a) => a !== '--');
for (const m of only) if (!RECORDINGS.some((r) => r.model === m)) throw new Error(`${m} has no recording in src/recordings.ts`);
mkdirSync(OUT, { recursive: true });
type Clip = { file: string; mp4: number; gif: number };
/** The clips already made (a run for some models keeps the others'): the object after `= ` in src/clips.ts. */
const written = existsSync(MANIFEST) ? readFileSync(MANIFEST, 'utf8') : '';
const before: Record<string, Clip> = written ? (JSON.parse(written.slice(written.indexOf('= {') + 2).replace(/;\s*$/, '')) as Record<string, Clip>) : {};
const manifest: Record<string, Clip> = {};
// In the recordings' order, for a tidy diff.
for (const e of RECORDINGS) {
  if (only.length && !only.includes(e.model)) {
    if (before[e.model]) manifest[e.model] = before[e.model];
    continue;
  }
  manifest[e.model] = await render(e);
}
const header = '// Written by scripts/clips.ts: the highlight of each Watch recording in public/clips (an MP4 and a GIF), and their\n// sizes in bytes, by model.\n';
writeFileSync(MANIFEST, `${header}export const CLIPS: Record<string, { file: string; mp4: number; gif: number }> = ${JSON.stringify(manifest, null, 2)};\n`);
