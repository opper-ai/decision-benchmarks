import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
} from 'mediabunny';
import { TICK_HZ, clone, type GameState } from '../shared/engine/engine.ts';
import type { Replay, ReplayPlayer } from '../shared/replay.ts';
import { MUSIC, SOUNDS, cuesFor, loadBuffers, scheduleCues, type Cue } from './audio.ts';
import { FightRenderer } from './render/renderer.ts';
import { DISPLAY_FONT } from './theme.ts';
import { bubblesAt, decisionsBySide } from './views/bubbles.ts';

export interface ExportOptions {
  /** First and last tick of the clip. */
  from: number;
  to: number;
  width: number;
  height: number;
  fps: 30 | 60;
  sound: boolean;
  music: boolean;
  bubbles: boolean;
  onProgress?: (fraction: number, phase: 'video' | 'audio' | 'finishing') => void;
  signal?: AbortSignal;
}

export const exportSupported = (): boolean => typeof VideoEncoder !== 'undefined' && typeof OfflineAudioContext !== 'undefined';

const SAMPLE_RATE = 48_000;
const MUSIC_GAIN = 0.32;

/**
 * Render a stretch of a replay to an MP4, offline and frame-exact: every frame is drawn from the
 * deterministic re-simulation, so the clip is smooth at its full frame rate whatever the machine, and
 * usually renders faster than real time. Sound is mixed offline from the same cues the live game plays.
 */
export async function exportClip(r: Replay, player: ReplayPlayer, o: ExportOptions): Promise<Blob> {
  if (!exportSupported()) throw new Error('This browser cannot encode video (WebCodecs is missing). Try a recent Chrome, Edge or Safari.');
  const ticksPerFrame = TICK_HZ / o.fps;
  const frames = Math.max(1, Math.floor((o.to - o.from) / ticksPerFrame));
  const duration = frames / o.fps;

  const canvas = document.createElement('canvas');
  canvas.width = o.width;
  canvas.height = o.height;
  const renderer = new FightRenderer(canvas, r.fighters, { width: o.width, height: o.height });
  renderer.showBubbles = o.bubbles;
  let virtualMs = 0;
  renderer.now = () => virtualMs;
  const bySide = decisionsBySide(r);

  const videoCodec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width: o.width, height: o.height });
  if (!videoCodec) throw new Error('No video codec available for this size.');
  const withAudio = o.sound || o.music;
  const audioCodec = withAudio ? await getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: SAMPLE_RATE }) : null;

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const video = new CanvasSource(canvas, { codec: videoCodec, quality: QUALITY_HIGH, keyFrameInterval: 1 });
  output.addVideoTrack(video, { frameRate: o.fps });
  const audioSrc = audioCodec ? new AudioBufferSource({ codec: audioCodec, quality: QUALITY_HIGH }) : null;
  if (audioSrc) output.addAudioTrack(audioSrc);
  await output.start();

  // Video, collecting sound cues on the way.
  const cues: { t: number; cues: Cue[] }[] = [];
  let state: GameState = player.stateAt(o.from);
  let prev = clone(state);
  renderer.setState(prev, state);
  renderer.reset();
  const ctx = canvas.getContext('2d')!;
  const title = `${r.fighters[0].label} vs ${r.fighters[1].label}`;
  for (let k = 0; k < frames; k++) {
    if (o.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    for (let t = 0; t < ticksPerFrame && state.round.phase !== 'over'; t++) {
      prev = clone(state);
      const events = player.advance(state);
      renderer.setState(prev, state);
      if (events.length) {
        renderer.onEvents(events);
        const c = cuesFor(events, prev, state);
        if (c.length) cues.push({ t: (k * ticksPerFrame + t) / TICK_HZ, cues: c });
      }
    }
    virtualMs = (k / o.fps) * 1000;
    const b = bubblesAt(bySide, state.tick, virtualMs);
    renderer.bubbles[0] = b[0];
    renderer.bubbles[1] = b[1];
    renderer.frame(1, 1 / o.fps);
    // Small caption so a shared clip says what it is.
    ctx.save();
    ctx.font = `700 ${Math.round(o.height / 26)}px ${DISPLAY_FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(27,46,64,0.55)';
    ctx.fillText(`${title} · jev fighter`, o.width - 18, o.height - 12);
    ctx.restore();
    await video.add(k / o.fps, 1 / o.fps);
    if (k % 15 === 0) {
      o.onProgress?.(k / frames, 'video');
      // Let the page breathe (progress bar, cancel button).
      await new Promise((res) => setTimeout(res, 0));
    }
  }
  video.close();

  if (audioSrc) {
    o.onProgress?.(1, 'audio');
    const off = new OfflineAudioContext(2, Math.ceil(duration * SAMPLE_RATE), SAMPLE_RATE);
    const buffers = await loadBuffers(off, [...(o.sound ? SOUNDS : []), ...(o.music ? [MUSIC] : [])]);
    if (o.sound) {
      const sfx = off.createGain();
      sfx.gain.value = 0.9;
      sfx.connect(off.destination);
      for (const c of cues) scheduleCues(off, sfx, buffers, c.cues, c.t);
    }
    const music = buffers.get(MUSIC);
    if (o.music && music) {
      const src = off.createBufferSource();
      src.buffer = music;
      src.loop = true;
      const g = off.createGain();
      g.gain.setValueAtTime(0, 0);
      g.gain.linearRampToValueAtTime(MUSIC_GAIN, Math.min(0.6, duration / 4));
      g.gain.setValueAtTime(MUSIC_GAIN, Math.max(0, duration - 0.8));
      g.gain.linearRampToValueAtTime(0, duration);
      src.connect(g).connect(off.destination);
      // Start the music where it would be at this point of the match, so clips of one match agree.
      src.start(0, (o.from / TICK_HZ) % music.duration);
    }
    await audioSrc.add(await off.startRendering());
    audioSrc.close();
  }

  o.onProgress?.(1, 'finishing');
  await output.finalize();
  const buf = (output.target as BufferTarget).buffer!;
  return new Blob([buf], { type: 'video/mp4' });
}

/** A file name like jev-fighter-jev-1-13-vs-kev-4b-0m42s.mp4 */
export function clipName(r: Replay, from: number): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const s = Math.floor(from / TICK_HZ);
  return `jev-fighter-${slug(r.fighters[0].label)}-vs-${slug(r.fighters[1].label)}-${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s.mp4`;
}

