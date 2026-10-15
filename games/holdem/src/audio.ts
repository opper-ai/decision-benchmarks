// The table's sounds: short effects generated through Opper's audio API (elevenlabs text-to-sound) and committed in
// public/audio. One switch, remembered per browser. Audio starts after the first click or key, as browsers require.
import { appPath } from '../../../packages/kit/client/paths.ts';

export const SOUNDS = ['deal', 'flip', 'chip', 'chips', 'check', 'fold', 'shuffle', 'win', 'allin', 'bust', 'turn'] as const;
export type Sound = (typeof SOUNDS)[number];

const STORE = 'ai-holdem.sound';
const GAIN: Partial<Record<Sound, number>> = { deal: 0.45, flip: 0.5, fold: 0.45, shuffle: 0.5, check: 0.7, chip: 0.6, chips: 0.65, win: 0.7, allin: 0.6, bust: 0.55, turn: 0.45 };

function loadOn(): boolean {
  try {
    return localStorage.getItem(STORE) !== 'off';
  } catch {
    return true;
  }
}

class TableAudio {
  on = loadOn();
  /** Silent for a moment, whatever the switch says (a resumed table catching up on its hand). */
  hushed = false;
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private buffers = new Map<Sound, AudioBuffer>();
  private listeners: (() => void)[] = [];

  constructor() {
    if (typeof window === 'undefined') return;
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
      this.out = this.ctx.createGain();
      this.out.gain.value = 0.85;
      this.out.connect(this.ctx.destination);
      const ctx = this.ctx;
      await Promise.all(
        SOUNDS.map(async (name) => {
          try {
            const res = await fetch(appPath(`audio/${name}.mp3`));
            this.buffers.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
          } catch {
            // a missing sound stays silent
          }
        }),
      );
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /** Plays a sound now (or `delay` seconds from now), a little varied in pitch so repeats don't drone. */
  play(name: Sound, o: { delay?: number; rate?: number; gain?: number } = {}): void {
    if (!this.on || this.hushed || !this.ctx || !this.out) return;
    const buf = this.buffers.get(name);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = o.rate ?? 0.95 + Math.random() * 0.1;
    const g = this.ctx.createGain();
    g.gain.value = o.gain ?? GAIN[name] ?? 0.6;
    src.connect(g).connect(this.out);
    src.start(this.ctx.currentTime + (o.delay ?? 0));
  }

  set(on: boolean): void {
    this.on = on;
    try {
      localStorage.setItem(STORE, on ? 'on' : 'off');
    } catch {
      // storage blocked: on for this visit only
    }
    if (on) void this.ensure();
    for (const f of this.listeners) f();
  }

  /** Calls `f` when the sound is switched; returns a function that stops it. */
  onChange(f: () => void): () => void {
    this.listeners.push(f);
    return () => {
      this.listeners = this.listeners.filter((g) => g !== f);
    };
  }
}

export const audio = new TableAudio();
