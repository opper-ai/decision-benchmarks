// The curated replays: recorded games between the models (public/demo/index.json, each game a recording in
// public/demo/), listed with their players' faces. Opening one plays it in the room
// (#/demo/<file>, replay-view.ts).
//
// index.json: { "format": 1, "replays": [{ "file": "titans.json.gz", "title": "Fable vs Astra", "blurb": "...",
//   "players": ["anthropic/claude-fable-5-1", "azure/gpt-6-astra-global"], "hands": 41, "recordedAt": "2026-10-20" }] }
// A file is a Recording (shared/recording.ts) as JSON, gzipped when it ends in .gz.
import type { Recording } from '../../shared/recording.ts';
import { MAX_SEATS, MIN_SEATS } from '../../shared/sitngo.ts';
import { h } from '../dom.ts';
import { personOf } from '../view-model.ts';
import { avatarEl } from './parts.ts';

export interface DemoEntry {
  file: string;
  title: string;
  blurb: string;
  /** Model ids (or bot names), seat order. */
  players: string[];
  hands: number;
  recordedAt: string;
}

/** A demo file's name: letters, digits and dashes, then .json or .json.gz. Nothing else is fetched. */
export const DEMO_FILE = /^[a-z0-9][a-z0-9-]{0,80}\.json(?:\.gz)?$/;

const isText = (v: unknown, max = 300): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** The entries of an index.json that are well formed (the rest are left out). */
export function parseDemoIndex(raw: unknown): DemoEntry[] {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { replays?: unknown }).replays)) return [];
  return ((raw as { replays: unknown[] }).replays).flatMap((e): DemoEntry[] => {
    if (typeof e !== 'object' || e === null) return [];
    const x = e as Record<string, unknown>;
    if (!isText(x.file, 90) || !DEMO_FILE.test(x.file) || !isText(x.title, 80) || !Array.isArray(x.players) || !x.players.every((p) => isText(p, 120)) || x.players.length < MIN_SEATS || x.players.length > MAX_SEATS) return [];
    return [{ file: x.file, title: x.title, blurb: isText(x.blurb) ? x.blurb : '', players: x.players as string[], hands: Number.isInteger(x.hands) ? (x.hands as number) : 0, recordedAt: isText(x.recordedAt, 40) ? x.recordedAt : '' }];
  });
}

/** A demo file's recording (JSON, or gzipped JSON). */
export async function loadDemo(url: string): Promise<Recording> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`this replay is missing (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // A server may already have unpacked it (Content-Encoding: gzip); a gzip file starts 1f 8b.
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()) : bytes;
  return JSON.parse(new TextDecoder().decode(raw)) as Recording;
}

const personFor = (id: string) => personOf(id.includes('/') ? { kind: 'model', id } : { kind: 'bot', id });

export interface WatchListOptions {
  entries: DemoEntry[];
  onOpen(entry: DemoEntry): void;
}

/** The replays as cards; an empty list says what is coming. */
export function watchList(o: WatchListOptions): HTMLElement {
  const list = h('div.replay-cards');
  for (const e of o.entries) {
    list.append(
      h(
        'button.replay-card',
        { type: 'button', onclick: () => o.onOpen(e) },
        h('span.faces', { 'aria-hidden': 'true' }, ...e.players.map((id) => avatarEl(personFor(id), 'relaxed', 'face'))),
        h('span.rc-title', null, e.title),
        e.blurb ? h('span.rc-blurb', null, e.blurb) : null,
        h('span.rc-meta', null, [e.hands ? `${e.hands} hands` : '', e.players.map((id) => personFor(id).name).join(', ')].filter(Boolean).join('. ')),
      ),
    );
  }
  if (!o.entries.length) list.append(h('p.rc-empty', null, 'Recorded games between the models will be here soon.'));
  return h('div.watch-list', null, list);
}
