// Spoken table talk on the page: the Voice switch (off by default, remembered per browser, independent of Sound), and
// the table's speaker (speaker.ts). A line comes from the table's speak route (POST api/table/speak, server/table.ts:
// the server reads the line from the table's sealed token) or, in a curated replay, from the mp3s scripts/voices.ts
// rendered once into public/voices/<replay>/. It plays through one audio element from a blob URL of the bytes fetched
// (the CSP allows connect-src 'self' and media-src blob:; never a data: URI), revoked once the line ends: an element,
// not Web Audio, because it speeds a voice up without raising its pitch (preservesPitch). The element is unlocked by
// the first click or key with Voice on; a line the browser still refuses to play is dropped quietly.
import { appPath } from '../../../packages/kit/client/paths.ts';
import { audio } from './audio.ts';
import { h } from './dom.ts';
import { Speaker, type Playing } from './speaker.ts';

const STORE = 'ai-holdem.voice';
/** The voices a little under the effects' loudest, so a win's fanfare doesn't drown a line. */
const VOICE_GAIN = 0.9;

class VoiceSwitch {
  on = VoiceSwitch.load();
  private listeners: (() => void)[] = [];

  private static load(): boolean {
    try {
      return localStorage.getItem(STORE) === 'on';
    } catch {
      return false;
    }
  }

  set(on: boolean): void {
    this.on = on;
    try {
      localStorage.setItem(STORE, on ? 'on' : 'off');
    } catch {
      // storage blocked: for this visit only
    }
    // Switching on is a click: the voice's element may start now.
    if (on) unlock();
    for (const f of this.listeners) f();
  }

  /** Calls `f` when Voice is switched; returns a function that stops it. */
  onChange(f: () => void): () => void {
    this.listeners.push(f);
    return () => {
      this.listeners = this.listeners.filter((g) => g !== f);
    };
  }
}

export const voice = new VoiceSwitch();

/** The one element every line plays through, made on first use (a browser that let it play once lets it play again). */
let element: HTMLAudioElement | null = null;
const player = (): HTMLAudioElement => (element ??= new Audio());

/** A tenth of a second of silence (8 kHz, 8-bit WAV), to play in a gesture so later lines may play. */
function silence(): Blob {
  const n = 800;
  const b = new DataView(new ArrayBuffer(44 + n));
  const text = (at: number, s: string) => [...s].forEach((c, i) => b.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  b.setUint32(4, 36 + n, true);
  text(8, 'WAVEfmt ');
  b.setUint32(16, 16, true);
  b.setUint16(20, 1, true);
  b.setUint16(22, 1, true);
  b.setUint32(24, 8000, true);
  b.setUint32(28, 8000, true);
  b.setUint16(32, 1, true);
  b.setUint16(34, 8, true);
  text(36, 'data');
  b.setUint32(40, n, true);
  for (let i = 0; i < n; i++) b.setUint8(44 + i, 128);
  return new Blob([b.buffer], { type: 'audio/wav' });
}

let unlocked = false;
/** Plays the silence in a gesture (the Voice switch, or the first click or key with Voice on), once it works. */
function unlock(): void {
  if (unlocked || typeof Audio === 'undefined') return;
  const el = player();
  if (!el.paused) return;
  const url = URL.createObjectURL(silence());
  el.src = url;
  el.play().then(
    () => (unlocked = true),
    () => {},
  ).finally(() => URL.revokeObjectURL(url));
}
if (typeof window !== 'undefined') {
  const onGesture = () => {
    if (voice.on) unlock();
    if (unlocked) for (const g of ['pointerup', 'click', 'keydown']) window.removeEventListener(g, onGesture);
  };
  for (const g of ['pointerup', 'click', 'keydown']) window.addEventListener(g, onGesture);
}

/** Plays a line's mp3 at `rate`, its pitch kept; ends at once when the browser refuses to play it. */
function playLine(mp3: Blob, rate: number): Playing {
  const el = player();
  const url = URL.createObjectURL(mp3);
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  let over = false;
  const end = () => {
    if (over) return;
    over = true;
    el.removeEventListener('ended', end);
    el.removeEventListener('error', end);
    URL.revokeObjectURL(url);
    finish();
  };
  el.addEventListener('ended', end);
  el.addEventListener('error', end);
  el.src = url;
  el.preservesPitch = true;
  el.defaultPlaybackRate = rate;
  el.playbackRate = rate;
  el.volume = VOICE_GAIN;
  el.play().catch(end);
  return {
    done,
    stop: () => {
      el.pause();
      end();
    },
  };
}

const VOICE_ON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 5h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4 3v-3H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" fill="currentColor"/><path d="M19.5 7.5a4.5 4.5 0 0 1 0 5M21.8 5.5a7.5 7.5 0 0 1 0 9" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>';
const VOICE_OFF = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 5h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4 3v-3H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" fill="currentColor" opacity=".55"/><path d="M3 3l18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

/** The toolbar's Voice switch, kept in step with the setting until `signal` aborts. */
export function voiceButton(signal: AbortSignal): HTMLButtonElement {
  const btn = h('button.tbtn.icon', { type: 'button', 'aria-label': 'Voice', title: 'Spoken table talk on or off', onclick: () => voice.set(!voice.on) });
  const draw = () => {
    btn.innerHTML = voice.on ? VOICE_ON : VOICE_OFF;
    btn.setAttribute('aria-pressed', String(voice.on));
  };
  draw();
  signal.addEventListener('abort', voice.onChange(draw), { once: true });
  return btn;
}

/** A line to speak: fetches its mp3 (null when it can't be had). */
export type LineSource = (signal: AbortSignal) => Promise<ArrayBuffer | null>;

/**
 * The table's speaker for one game (or replay): silent while Voice is off, the page is hidden or the table is hushed (a
 * resume catching up), stopped when Voice goes off, the page is hidden, or `signal` aborts (leaving, a new table).
 */
export function tableSpeaker(o: { signal: AbortSignal; speed?: () => number }): Speaker<LineSource, Blob> {
  const speaker = new Speaker<LineSource, Blob>({
    now: () => performance.now(),
    enabled: () => voice.on && !audio.hushed && !o.signal.aborted && !document.hidden,
    ...(o.speed ? { speed: o.speed } : {}),
    load: async (line, signal) => {
      const data = await line(signal);
      return data && !signal.aborted ? new Blob([data], { type: 'audio/mpeg' }) : null;
    },
    play: playLine,
  });
  const offSwitch = voice.onChange(() => {
    if (!voice.on) speaker.clear();
  });
  const onVisible = () => {
    if (document.hidden) speaker.clear();
  };
  document.addEventListener('visibilitychange', onVisible);
  o.signal.addEventListener(
    'abort',
    () => {
      speaker.clear();
      offSwitch();
      document.removeEventListener('visibilitychange', onVisible);
    },
    { once: true },
  );
  return speaker;
}

function fromBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** A live table's line, by the token of its hand and its action's index: the server speaks it (and bills the table's payer). */
export function spokenLine(ref: { token: string; hand: number; action: number }): LineSource {
  return async (signal) => {
    try {
      const res = await fetch(appPath('/api/table/speak'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ref), signal });
      if (!res.ok) return null;
      const body = (await res.json()) as { audio?: unknown };
      return typeof body.audio === 'string' ? fromBase64(body.audio) : null;
    } catch {
      return null;
    }
  };
}

/** A curated replay's voices (scripts/voices.ts): each spoken line's file by "<hand>-<action>", with the line it says. */
export interface ReplayVoices {
  format: 1;
  lines: Record<string, { file: string; say: string }>;
}

/** The voices rendered for a curated replay (public/voices/<name>/index.json), or null when it has none. */
export async function replayVoices(name: string): Promise<{ line(hand: number, action: number, say: string): LineSource | null } | null> {
  try {
    const res = await fetch(appPath(`/voices/${encodeURIComponent(name)}/index.json`));
    if (!res.ok) return null;
    const index = (await res.json()) as ReplayVoices;
    if (index.format !== 1 || typeof index.lines !== 'object') return null;
    return {
      line: (hand, action, say) => {
        const l = index.lines[`${hand}-${action}`];
        // Only the line the recording says: a recording replaced since its voices were rendered stays silent.
        if (!l || l.say !== say || !/^[\w-]+\.mp3$/.test(l.file)) return null;
        return async (signal) => {
          try {
            const r = await fetch(appPath(`/voices/${encodeURIComponent(name)}/${l.file}`), { signal });
            return r.ok ? await r.arrayBuffer() : null;
          } catch {
            return null;
          }
        };
      },
    };
  } catch {
    return null;
  }
}
