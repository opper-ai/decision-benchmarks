// What the page reads and calls, all on the game's own path: the account (/api/me), model answers through the kit's
// transport (/api/decide and /api/warm: the free credits, your Opper sign-in, or a local key, never a key in the
// browser), the recorded matches for Watch (demo/) and the result files (leaderboard.json, community.json,
// baselines.json). Matches played here are never uploaded: the player can download theirs.
import { fetchMe, type Me } from '../../../packages/kit/client/auth.ts';
import { appPath } from '../../../packages/kit/client/paths.ts';
import { createHttpTransport, warmUp, type TransportHooks } from '../../../packages/kit/client/transport.ts';
import type { Community, Leaderboard } from '../../../packages/kit/shared/contract.ts';
import type { Adapter } from '../shared/adapter.ts';
import { decodeReplay, encodeReplay, type Replay } from '../shared/replay.ts';
import { transportAdapter } from '../shared/transport-adapter.ts';

export type { Me };
export const getMe = fetchMe;

/** A model fighter: every question goes through /api/decide, and the warm-up through /api/warm. */
export function modelAdapter(model: string, hooks: TransportHooks): Adapter {
  return transportAdapter(model, createHttpTransport(hooks), {
    async warmUp() {
      const r = await warmUp(model, hooks);
      if (!r.ok) throw new Error(r.error);
    },
  });
}

/** A recorded match for Watch, listed in public/demo/index.json. */
export interface Demo {
  file: string;
  title: string;
  note?: string;
}

const DEMO_FILE = /^[a-z0-9][a-z0-9-]*\.fight\.json\.gz$/;

async function getJson<T>(path: string): Promise<T | null> {
  const res = await fetch(appPath(path), { headers: { Accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function getDemos(): Promise<Demo[]> {
  const list = (await getJson<{ demos?: unknown }>('demo/index.json'))?.demos;
  if (!Array.isArray(list)) return [];
  return list.filter((d): d is Demo => typeof d?.file === 'string' && DEMO_FILE.test(d.file) && typeof d.title === 'string');
}

export async function getDemo(file: string): Promise<Replay> {
  if (!DEMO_FILE.test(file)) throw new Error('No such recording');
  const res = await fetch(appPath(`demo/${file}`));
  if (!res.ok) throw new Error(res.status === 404 ? 'No such recording' : `HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // A server may already have unpacked it (Content-Encoding); a gzip file starts 1f 8b.
  return bytes[0] === 0x1f && bytes[1] === 0x8b ? decodeReplay(bytes) : (JSON.parse(new TextDecoder().decode(bytes)) as Replay);
}

/** The official runs, the self-reported runs (built by CI from submissions) and the baselines' own results. */
export async function getBoards(): Promise<{ official: Leaderboard | null; community: Community | null; baselines: Leaderboard | null }> {
  const [official, community, baselines] = await Promise.all([
    getJson<Leaderboard>('leaderboard.json').catch(() => null),
    getJson<Community>('community.json').catch(() => null),
    getJson<Leaderboard>('baselines.json').catch(() => null),
  ]);
  return { official, community, baselines };
}

/** Saves a match to the player's computer (gzipped JSON, as the bench writes them). Nothing is uploaded. */
export async function downloadReplay(r: Replay): Promise<void> {
  const blob = new Blob([(await encodeReplay(r)) as BlobPart], { type: 'application/gzip' });
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fighter-${slug(r.fighters[0].label)}-vs-${slug(r.fighters[1].label)}.fight.json.gz`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
