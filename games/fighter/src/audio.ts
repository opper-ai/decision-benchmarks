import { appPath } from '../../../packages/kit/client/paths.ts';
import type { GameEvent, GameState } from '../shared/engine/engine.ts';
import type { MoveId } from '../shared/engine/moves.ts';

/** Sound files in public/audio, generated through Opper (`npm run gen-audio`). */
export const SOUNDS = [
  'punch1',
  'punch2',
  'heavy',
  'kick1',
  'kick2',
  'block',
  'whoosh',
  'whoosh_big',
  'grab',
  'fall',
  'ko',
  'bell',
  'jump',
  'land',
  'armor',
  'special',
] as const;
export type SoundName = (typeof SOUNDS)[number];
export const MUSIC = 'theme';

export interface Cue {
  name: SoundName;
  /** Seconds after the event. */
  delay: number;
  rate: number;
  gain: number;
  pan: number;
}

const LIGHT_SWING = new Set<MoveId>(['jab', 'jab_straight', 'straight', 'low_kick', 'low_kick_sweep']);
const BIG_SWING = new Set<MoveId>(['high_kick', 'sweep', 'uppercut', 'jump_kick']);
const KICKS = new Set<MoveId>(['low_kick', 'low_kick_sweep', 'high_kick', 'sweep', 'jump_kick']);

/** Deterministic 0..1 from a number, for pitch variety that is the same on every playback. */
const vary = (n: number) => {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * The sounds a tick produces. Pure, so live play, replays and the offline export mix all agree.
 * `prev` is the state one tick earlier (for landings).
 */
export function cuesFor(events: GameEvent[], prev: GameState | null, curr: GameState): Cue[] {
  const out: Cue[] = [];
  const pan = (side: 0 | 1) => Math.max(-0.7, Math.min(0.7, (curr.fighters[side].x / 1000 - 5) / 5));
  const cue = (name: SoundName, side: 0 | 1 | null, gain: number, seed: number, delay = 0): void => {
    out.push({ name, delay, gain, rate: 0.94 + vary(seed) * 0.12, pan: side === null ? 0 : pan(side) });
  };
  for (const e of events) {
    switch (e.kind) {
      case 'start':
        if (LIGHT_SWING.has(e.move)) cue('whoosh', e.f, 0.35, e.tick + e.f);
        else if (BIG_SWING.has(e.move)) cue('whoosh_big', e.f, 0.45, e.tick + e.f);
        else if (e.move === 'special') cue('special', e.f, 0.8, e.tick);
        else if (e.move === 'jump') cue('jump', e.f, 0.4, e.tick);
        else if (e.move === 'backdash' || e.move === 'dash_forward') cue('whoosh', e.f, 0.25, e.tick);
        break;
      case 'hit': {
        const def = (1 - e.f) as 0 | 1;
        const g = Math.min(1, 0.6 + e.dmg / 30);
        if (e.move === 'throw') {
          cue('grab', def, 0.8, e.tick);
          cue('fall', def, 0.9, e.tick, 0.28);
        } else if (e.move === 'uppercut' || e.move === 'special') {
          cue('heavy', def, g, e.tick);
        } else if (KICKS.has(e.move)) {
          cue(e.tick % 2 ? 'kick1' : 'kick2', def, g, e.tick);
        } else {
          cue(e.tick % 2 ? 'punch1' : 'punch2', def, g, e.tick);
        }
        if (e.knockdown && e.move !== 'throw') cue('fall', def, 0.8, e.tick + 1, 0.3);
        break;
      }
      case 'block':
        cue('block', (1 - e.f) as 0 | 1, 0.7, e.tick);
        break;
      case 'armor':
        cue('armor', (1 - e.f) as 0 | 1, 0.8, e.tick);
        break;
      case 'ko':
        cue('ko', e.f, 1, e.tick);
        break;
      case 'round_start':
        cue('bell', null, 0.7, e.tick);
        break;
      case 'match_end':
        cue('bell', null, 0.7, e.tick);
        cue('bell', null, 0.7, e.tick + 1, 0.35);
        break;
      default:
        break;
    }
  }
  if (prev) {
    for (const i of [0, 1] as const) {
      const a = prev.fighters[i];
      const b = curr.fighters[i];
      if (a.y > 0 && b.y === 0 && b.phase !== 'knockdown' && b.phase !== 'ko') cue('land', i, 0.35, curr.tick + i);
    }
  }
  return out;
}

const STORE = 'jev-fighter.audio';

export interface AudioSettings {
  sound: boolean;
  music: boolean;
}

function loadSettings(): AudioSettings {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) ?? 'null') as AudioSettings | null;
    if (s && typeof s.sound === 'boolean' && typeof s.music === 'boolean') return s;
  } catch {
    // storage blocked
  }
  return { sound: true, music: true };
}

export async function loadBuffers(ctx: BaseAudioContext, names: readonly string[]): Promise<Map<string, AudioBuffer>> {
  const out = new Map<string, AudioBuffer>();
  await Promise.all(
    names.map(async (n) => {
      try {
        const res = await fetch(appPath(`audio/${n}.mp3`));
        out.set(n, await ctx.decodeAudioData(await res.arrayBuffer()));
      } catch {
        // a missing sound just stays silent
      }
    }),
  );
  return out;
}

/** Schedule cues on any audio context (live or offline) at absolute time `t` (seconds). */
export function scheduleCues(ctx: BaseAudioContext, dest: AudioNode, buffers: Map<string, AudioBuffer>, cues: Cue[], t: number): void {
  for (const c of cues) {
    const buf = buffers.get(c.name);
    if (!buf) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = c.rate;
    const gain = ctx.createGain();
    gain.gain.value = c.gain;
    const panner = ctx.createStereoPanner();
    panner.pan.value = c.pan;
    src.connect(gain).connect(panner).connect(dest);
    src.start(t + c.delay);
  }
}

/** Live audio: effects and background music, each switchable, remembered per browser. */
class AudioEngine {
  settings = loadSettings();
  private ctx: AudioContext | null = null;
  private sfx: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private buffers: Map<string, AudioBuffer> | null = null;
  private musicSrc: AudioBufferSourceNode | null = null;
  private wantMusic = false;
  /** The playback is paused: the whole mix (music and effects) stands still, and carries on from there on play. */
  private held = false;
  private listeners: (() => void)[] = [];

  constructor() {
    // Browsers only allow audio after a user gesture.
    const unlock = () => {
      void this.ensure();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  private async ensure(): Promise<void> {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const master = this.ctx.createGain();
      master.gain.value = 0.9;
      master.connect(this.ctx.destination);
      this.sfx = this.ctx.createGain();
      this.sfx.connect(master);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.32;
      this.musicGain.connect(master);
      this.buffers = await loadBuffers(this.ctx, [...SOUNDS, MUSIC]);
    }
    if (this.ctx.state === 'suspended' && !this.held) await this.ctx.resume();
    this.syncMusic();
  }

  onChange(l: () => void): void {
    this.listeners.push(l);
  }

  set(patch: Partial<AudioSettings>): void {
    this.settings = { ...this.settings, ...patch };
    try {
      localStorage.setItem(STORE, JSON.stringify(this.settings));
    } catch {
      // storage blocked
    }
    void this.ensure();
    for (const l of this.listeners) l();
  }

  /** Whether the current page wants music (a fight or a replay is showing). */
  scene(fighting: boolean): void {
    this.wantMusic = fighting;
    this.syncMusic();
  }

  /** Pauses (true) or resumes (false) every sound with the fight on the stage. */
  hold(paused: boolean): void {
    if (this.held === paused) return;
    this.held = paused;
    if (!this.ctx) return;
    if (paused && this.ctx.state === 'running') void this.ctx.suspend();
    else if (!paused && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private syncMusic(): void {
    if (!this.ctx || !this.buffers || !this.musicGain) return;
    const on = this.settings.music && this.wantMusic;
    if (on && !this.musicSrc) {
      const buf = this.buffers.get(MUSIC);
      if (!buf) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(this.musicGain);
      this.musicGain.gain.setValueAtTime(0, this.ctx.currentTime);
      this.musicGain.gain.linearRampToValueAtTime(0.32, this.ctx.currentTime + 1.2);
      src.start();
      this.musicSrc = src;
    } else if (!on && this.musicSrc) {
      const src = this.musicSrc;
      this.musicSrc = null;
      this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, this.ctx.currentTime);
      this.musicGain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.4);
      src.stop(this.ctx.currentTime + 0.45);
    }
  }

  play(cues: Cue[]): void {
    if (!cues.length || !this.settings.sound || !this.ctx || !this.buffers || !this.sfx || this.ctx.state !== 'running') return;
    scheduleCues(this.ctx, this.sfx, this.buffers, cues, this.ctx.currentTime);
  }
}

export const audio = new AudioEngine();
