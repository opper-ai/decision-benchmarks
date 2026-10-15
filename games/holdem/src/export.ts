// One hand as a short square MP4 for social posts, made in the browser: deal, every action with its table talk, the
// showdown and the chips to the winner, drawn frame by frame on a canvas from the hand's events (no screen capture)
// and encoded with WebCodecs through mediabunny, as Jev Fighter's clips are. Loaded only when a clip is asked for, so
// the page's own script stays small.
//
// Three steps, the first two pure so tests can check them: when each moment happens (clipTimeline), what a frame shows
// at a time (frameAt, clipFrameItems), then drawing and encoding (exportHandClip).
import type { HandEvent } from '../shared/engine.ts';
import type { Player } from '../shared/recording.ts';
import type { Sound } from './audio.ts';
import type { ReviewHand } from './driver.ts';
import { describeHighlight, highlightsOf, titleOf } from './highlights.ts';
import { C, drawItems, loadFaces, loadFonts, wrap, estimate, type Item, type Measure } from './share-image.ts';
import { applyEvent, emptyModel, type TableModel } from './table-model.ts';
import { actionText, aHand, chips, personOf, slotsFor, type Slot } from './view-model.ts';

export const CLIP_SIZE = 1080;
export const CLIP_FPS = 30;
export const CLIP_MAX_SECONDS = 20;

/** One moment of the clip: the events it brings in (up to `upTo`, inclusive), when, for how long, and its sound. */
export interface Beat {
  at: number;
  dur: number;
  upTo: number;
  kind: 'deal' | 'action' | 'street' | 'showdown' | 'award' | 'end';
  sound?: Sound;
  /** An action's table talk, shown for a moment over the seat. */
  say?: { seat: number; text: string };
}

export interface Timeline {
  beats: Beat[];
  duration: number;
}

const BASE: Record<Beat['kind'], number> = { deal: 1.2, action: 0.85, street: 1, showdown: 1.8, award: 1.6, end: 2 };
const SAY_EXTRA = 0.9;

/** The hand's moments in order, squeezed to fit `max` seconds (actions and streets give way first). */
export function clipTimeline(hand: ReviewHand, max = CLIP_MAX_SECONDS): Timeline {
  const beats: Omit<Beat, 'at'>[] = [];
  const events = hand.events;
  let action = 0;
  const lastHole = events.reduce((k, e, i) => (e.type === 'hole' || e.type === 'post' || e.type === 'start' ? i : k), 0);
  beats.push({ kind: 'deal', upTo: lastHole, dur: BASE.deal, sound: 'deal' });
  for (let i = lastHole + 1; i < events.length; i++) {
    const e = events[i]!;
    if (e.type === 'action') {
      const meta = hand.actions[action++];
      const say = meta?.say ? { seat: e.seat, text: meta.say } : undefined;
      beats.push({ kind: 'action', upTo: i, dur: BASE.action + (say ? SAY_EXTRA : 0), sound: e.kind === 'fold' ? 'fold' : e.kind === 'check' ? 'check' : e.allIn ? 'allin' : 'chip', ...(say ? { say } : {}) });
    } else if (e.type === 'street') beats.push({ kind: 'street', upTo: i, dur: BASE.street, sound: 'flip' });
    else if (e.type === 'showdown') beats.push({ kind: 'showdown', upTo: i, dur: BASE.showdown, sound: 'flip' });
    else if (e.type === 'award') {
      const prev = beats.at(-1);
      // Every pot in one moment.
      if (prev?.kind === 'award') prev.upTo = i;
      else beats.push({ kind: 'award', upTo: i, dur: BASE.award, sound: 'win' });
    } else if (beats.length) beats.at(-1)!.upTo = i; // return, end: with the moment before
  }
  beats.push({ kind: 'end', upTo: events.length - 1, dur: BASE.end });
  // Too long: shorten the actions and streets, down to a third of a second each.
  const fixed = beats.filter((b) => b.kind !== 'action' && b.kind !== 'street').reduce((a, b) => a + b.dur, 0);
  const flexible = beats.filter((b) => b.kind === 'action' || b.kind === 'street');
  const room = max - fixed;
  const want = flexible.reduce((a, b) => a + b.dur, 0);
  if (want > room) {
    const scale = Math.max(0, room) / want;
    for (const b of flexible) b.dur = Math.max(0.33, b.dur * scale);
  }
  let at = 0;
  const out = beats.map((b) => {
    const beat = { ...b, at };
    at += b.dur;
    return beat;
  });
  return { beats: out, duration: Math.min(at, max) };
}

export interface Frame {
  model: TableModel;
  beat: Beat;
  /** 0 to 1 through the beat. */
  progress: number;
  /** Table talk on screen: said in the last two seconds. */
  talk: { seat: number; text: string }[];
  /** Each seat's face: its last mood so far. */
  moods: (string | undefined)[];
  /** The last action, for the line under the board. */
  last: Extract<HandEvent, { type: 'action' }> | null;
}

/** What the clip shows at `t` seconds. */
export function frameAt(hand: ReviewHand, tl: Timeline, t: number): Frame {
  const seats = (hand.events[0] as Extract<HandEvent, { type: 'start' }>).stacks.length;
  let k = tl.beats.findIndex((b) => b.at + b.dur > t);
  if (k < 0) k = tl.beats.length - 1;
  const beat = tl.beats[k]!;
  let model = emptyModel(seats);
  const moods: (string | undefined)[] = Array(seats).fill(undefined);
  let action = 0;
  let last: Frame['last'] = null;
  for (let i = 0; i <= beat.upTo; i++) {
    const e = hand.events[i]!;
    model = applyEvent(model, e);
    if (e.type === 'action') {
      const meta = hand.actions[action++];
      if (meta?.mood) moods[e.seat] = meta.mood;
      last = e;
    }
  }
  const talk = tl.beats.filter((b) => b.say && b.at <= t && t < b.at + Math.max(b.dur, 2)).map((b) => b.say!);
  return { model, beat, progress: Math.min(1, Math.max(0, (t - beat.at) / beat.dur)), talk, moods, last };
}

/** Where each slot sits on the square. */
const SEAT_AT: Record<Slot, { x: number; y: number }> = {
  bottom: { x: 540, y: 880 },
  top: { x: 540, y: 205 },
  left: { x: 150, y: 540 },
  right: { x: 930, y: 540 },
  'top-left': { x: 290, y: 225 },
  'top-right': { x: 790, y: 225 },
};
/** Five and six seats: the sides lower down, the top corners wider apart (as style.css lays the table out). */
const SEAT_AT_FULL: Partial<Record<Slot, { x: number; y: number }>> = {
  left: { x: 150, y: 620 },
  right: { x: 930, y: 620 },
  'top-left': { x: 250, y: 235 },
  'top-right': { x: 830, y: 235 },
};
const seatAt = (slot: Slot, seats: number) => (seats >= 5 ? (SEAT_AT_FULL[slot] ?? SEAT_AT[slot]) : SEAT_AT[slot]);

export interface ClipInfo {
  players: readonly Player[];
  /** The hand's best story, written out, for the last moment. */
  caption: string | null;
  title: string;
}

/** The clip's words: who sat where, and the hand's best story as the review says it. */
export function clipInfo(hand: ReviewHand, players: readonly Player[]): ClipInfo {
  const name = (s: number) => personOf(players[s]!).name;
  const best = highlightsOf(hand, players)[0];
  return { players, caption: best ? `${titleOf(best)}. ${describeHighlight(best, name)}` : null, title: `Hand ${hand.hand}` };
}

/** Every shape on a frame, in drawing order (CLIP_SIZE square). */
export function clipFrameItems(f: Frame, info: ClipInfo, hand: ReviewHand, measure: Measure = estimate): Item[] {
  const S = CLIP_SIZE;
  const items: Item[] = [];
  const text = (x: number, y: number, t: string, size: number, o: { font?: string; weight?: number; color?: string; align?: 'left' | 'center' | 'right' } = {}) =>
    items.push({ kind: 'text', x, y, text: t, font: o.font ?? 'Wix Madefor Text', size, weight: o.weight ?? 600, color: o.color ?? C.text, align: o.align ?? 'center' });
  const n = f.model.seats.length;
  const slots = slotsFor(n, null);
  const people = info.players.map((p) => personOf(p));
  const done = f.beat.kind === 'award' || f.beat.kind === 'end';

  items.push({ kind: 'rect', x: 0, y: 0, w: S, h: S, r: 0, fill: '#1c100a' });
  items.push({ kind: 'ellipse', cx: S / 2, cy: 560, rx: 470, ry: 330, fill: C.rail });
  items.push({ kind: 'ellipse', cx: S / 2, cy: 560, rx: 448, ry: 308, fill: C.felt });
  items.push({ kind: 'ellipse', cx: S / 2, cy: 560, rx: 410, ry: 272, fill: 'transparent', stroke: 'rgba(215, 170, 82, 0.45)', line: 2 });
  text(60, 78, "AI Hold'em", 44, { font: 'Fraunces', weight: 800, color: C.brass, align: 'left' });
  text(S - 60, 78, `${info.title}, blinds ${chips(f.model.sb)}/${chips(f.model.bb)}`, 26, { color: 'rgba(243, 232, 205, 0.7)', align: 'right' });

  // The board and the pot.
  const cw = 92;
  const gap = 12;
  const boardX = S / 2 - (5 * cw + 4 * gap) / 2;
  for (let i = 0; i < 5; i++) {
    const c = f.model.board[i];
    if (c) items.push({ kind: 'card', x: boardX + i * (cw + gap), y: 470, w: cw, card: c });
    else items.push({ kind: 'rect', x: boardX + i * (cw + gap), y: 470, w: cw, h: cw * 1.4, r: 9, fill: 'transparent', stroke: 'rgba(215, 170, 82, 0.3)', line: 2 });
  }
  const pot = f.model.middle + f.model.seats.reduce((a, p) => a + p.bet, 0);
  if (pot > 0 && !done) text(S / 2, 450, `Pot ${chips(pot)}`, 30, { font: 'Fraunces', weight: 800, color: C.ivory });

  // The seats.
  f.model.seats.forEach((p, seat) => {
    const at = seatAt(slots[seat]!, n);
    const person = people[seat]!;
    const out = !p.dealt && p.stack === 0;
    items.push({ kind: 'avatar', cx: at.x, cy: at.y - 30, r: 62, slug: person.slug, label: person.name, mood: f.moods[seat], dim: p.folded || out, ...(p.won > 0 && done ? { ring: '#ffc56b' } : {}) });
    text(at.x, at.y + 62, person.name, 26, { weight: 700, color: C.ivory });
    text(at.x, at.y + 94, p.won > 0 && done ? `Won ${chips(p.won)}` : chips(p.stack), 26, { font: 'Fraunces', weight: 800, color: p.won > 0 && done ? '#ffc56b' : C.brass });
    if (p.cards?.length) {
      const hw = 58;
      // At the sides (and the head of a table of six, between two neighbours), the cards go under the stack.
      const side = slots[seat] === 'left' || slots[seat] === 'right' || (slots[seat] === 'top' && n >= 6);
      // Beside the face; at the sides of the table, under the stack, clear of the board.
      const right = at.x <= S / 2 ? 1 : -1;
      const x0 = side ? at.x - hw - 3 : at.x + right * 74 - (right < 0 ? 2 * hw + 6 : 0);
      const y0 = side ? at.y + 112 : at.y - 92;
      p.cards.forEach((c, i) => items.push({ kind: 'card', x: x0 + i * (hw + 6), y: y0, w: hw, card: c, dim: p.folded }));
    }
    if (p.bet > 0 && !done) {
      const bx = at.x + (S / 2 - at.x) * 0.42;
      const by = at.y + (560 - at.y) * 0.42;
      items.push({ kind: 'ellipse', cx: bx - 34, cy: by - 8, rx: 14, ry: 14, fill: '#b5342b', stroke: '#f4ead2', line: 3 });
      text(bx + 6, by, chips(p.bet), 26, { weight: 700, color: C.ivory });
    }
    if (p.shown && done) text(at.x, at.y - 108, aHand(p.shown), 24, { weight: 700, color: '#ffc56b' });
  });

  // What was just done, and the table talk over the seats.
  if (f.last && !done) {
    const who = people[f.last.seat]!.name;
    text(S / 2, 680, `${who} ${actionText(f.last, who === 'You')}`, 28, { weight: 600, color: 'rgba(243, 232, 205, 0.85)' });
  }
  for (const t of f.talk) {
    const at = SEAT_AT[slots[t.seat]!];
    items.push({ kind: 'bubble', x: at.x, y: at.y - 104, text: t.text, size: 34, maxWidth: 360 });
  }
  // The end: the hand's story.
  // The end: the hand's story, on the felt under the board (the bets are gone by then).
  if (f.beat.kind === 'end' && info.caption) {
    const w = 640;
    const lines = wrap(info.caption, w - 60, 3, (t) => measure(t, 'Wix Madefor Text', 26, 600) <= w - 60);
    items.push({ kind: 'rect', x: S / 2 - w / 2, y: 606, w, h: lines.length * 33 + 30, r: 18, fill: 'rgba(16, 9, 5, 0.88)', stroke: C.brass, line: 2 });
    lines.forEach((l, i) => text(S / 2, 642 + i * 33, l, 26, { color: C.ivory }));
  }
  return items;
}

/** WebCodecs is there: clips can be made. */
export const clipSupported = (): boolean => typeof VideoEncoder !== 'undefined' && typeof OfflineAudioContext !== 'undefined';

export interface ExportOptions {
  /** A path below the game, as a URL (appPath). */
  asset: (path: string) => string;
  sound?: boolean;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

const SAMPLE_RATE = 48_000;

/** The hand as an MP4 (CLIP_SIZE square, CLIP_FPS, at most CLIP_MAX_SECONDS). */
export async function exportHandClip(hand: ReviewHand, players: readonly Player[], o: ExportOptions): Promise<Blob> {
  if (!clipSupported()) throw new Error('This browser cannot make video (WebCodecs is missing). Try a recent Chrome, Edge or Safari.');
  const { AudioBufferSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, getFirstEncodableAudioCodec, getFirstEncodableVideoCodec } = await import('mediabunny');
  const tl = clipTimeline(hand);
  const info = clipInfo(hand, players);
  const frames = Math.max(1, Math.round(tl.duration * CLIP_FPS));
  const canvas = document.createElement('canvas');
  canvas.width = CLIP_SIZE;
  canvas.height = CLIP_SIZE;
  const ctx = canvas.getContext('2d')!;
  await loadFonts();
  const measure: Measure = (t, font, size, weight) => {
    ctx.font = `${weight} ${size}px "${font}", Georgia, sans-serif`;
    return ctx.measureText(t).width;
  };
  // Every face the clip can show: each player in each mood.
  const faces = await loadFaces(
    players.flatMap((p): Item[] => ['relaxed', 'confident', 'nervous', 'annoyed', 'smug'].map((mood) => ({ kind: 'avatar', cx: 0, cy: 0, r: 1, slug: personOf(p).slug, label: '', mood }))),
    o.asset,
  );

  const videoCodec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width: CLIP_SIZE, height: CLIP_SIZE });
  if (!videoCodec) throw new Error('This browser has no video codec for this size.');
  const audioCodec = o.sound === false ? null : await getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: SAMPLE_RATE });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const video = new CanvasSource(canvas, { codec: videoCodec, quality: QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(video, { frameRate: CLIP_FPS });
  const audio = audioCodec ? new AudioBufferSource({ codec: audioCodec, quality: QUALITY_HIGH }) : null;
  if (audio) output.addAudioTrack(audio);
  await output.start();

  for (let k = 0; k < frames; k++) {
    if (o.signal?.aborted) throw new DOMException('The clip was cancelled', 'AbortError');
    const t = k / CLIP_FPS;
    drawItems(ctx, clipFrameItems(frameAt(hand, tl, t), info, hand, measure), faces);
    await video.add(t, 1 / CLIP_FPS);
    if (k % 15 === 0) {
      o.onProgress?.(k / frames);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  video.close();

  if (audio) {
    const off = new OfflineAudioContext(2, Math.ceil(tl.duration * SAMPLE_RATE), SAMPLE_RATE);
    const wanted = [...new Set(tl.beats.flatMap((b) => (b.sound ? [b.sound] : [])))];
    const buffers = new Map<string, AudioBuffer>();
    await Promise.all(
      wanted.map(async (name) => {
        try {
          const res = await fetch(o.asset(`audio/${name}.mp3`));
          buffers.set(name, await off.decodeAudioData(await res.arrayBuffer()));
        } catch {
          // a missing sound stays silent
        }
      }),
    );
    for (const b of tl.beats) {
      const buf = b.sound && buffers.get(b.sound);
      if (!buf || b.at >= tl.duration) continue;
      const src = off.createBufferSource();
      src.buffer = buf;
      const g = off.createGain();
      g.gain.value = 0.6;
      src.connect(g).connect(off.destination);
      src.start(b.at);
    }
    await audio.add(await off.startRendering());
    audio.close();
  }
  o.onProgress?.(1);
  await output.finalize();
  return new Blob([(output.target as InstanceType<typeof BufferTarget>).buffer!], { type: 'video/mp4' });
}

/** ai-holdem-hand-12.mp4 */
export const clipName = (hand: ReviewHand): string => `ai-holdem-hand-${hand.hand}.mp4`;
