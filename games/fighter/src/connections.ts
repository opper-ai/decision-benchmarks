import { chatAdapter } from '../adapters/chat.ts';
import { systemOneAdapter, type HttpDeps } from '../adapters/systemone.ts';
import type { Adapter } from '../shared/adapter.ts';
import { baselineAdapter, isBaseline } from '../shared/baselines.ts';
import { endpointAdapter, endpointModelId, endpointProblem, hostOf, isOpperUrl, type Endpoint } from '../shared/endpoints.ts';
import { modelInfo } from '../shared/models.ts';
import type { FighterMeta } from '../shared/replay.ts';
import { remoteAdapter, type Me } from './api.ts';
import { humanAdapter } from './input.ts';

/**
 * Connections: what lets fighters play. Signing in with Opper lives on the server; an Opper API key and
 * your endpoints live only in this browser and are sent straight to the model's endpoint, never to this
 * site's server and never into replays.
 */

export interface MyEndpoint extends Endpoint {
  /** '' = none (a local server), or for an Opper URL, the Opper key. */
  key: string;
}

export interface Connections {
  /** Kept across visits (localStorage) rather than until the tab closes (sessionStorage). */
  remember: boolean;
  opperKey: string;
  endpoints: MyEndpoint[];
  /** Rare: a key for one side only, overriding the rest. */
  fighterKeys: [string, string];
}

/** Picker values besides listed model ids. */
export const HUMAN = 'human';
export const MINE = 'mine:';
export const FILE = 'endpoint:';

const STORE = 'jev-fighter.connections';
export const blank = (): Connections => ({ remember: false, opperKey: '', endpoints: [], fighterKeys: ['', ''] });

function storages(): { local: Storage | null; session: Storage | null } {
  const get = (name: 'localStorage' | 'sessionStorage') => {
    try {
      return window[name];
    } catch {
      return null;
    }
  };
  return { local: get('localStorage'), session: get('sessionStorage') };
}

function load(): Connections {
  const { local, session } = storages();
  for (const st of [session, local]) {
    try {
      const c = JSON.parse(st?.getItem(STORE) ?? 'null') as Partial<Connections> | null;
      if (c && typeof c === 'object') {
        return {
          remember: Boolean(c.remember),
          opperKey: String(c.opperKey ?? ''),
          endpoints: Array.isArray(c.endpoints) ? c.endpoints.filter((e) => e && typeof e.id === 'string').map((e) => ({ ...e, key: String(e.key ?? '') })) : [],
          fighterKeys: [String(c.fighterKeys?.[0] ?? ''), String(c.fighterKeys?.[1] ?? '')],
        };
      }
    } catch {
      // storage blocked or corrupt
    }
  }
  return blank();
}

let state: Connections | null = null;
const listeners = new Set<() => void>();

export function connections(): Connections {
  state ??= load();
  return state;
}

/** Change the connections, save them where `remember` says, and tell every view. */
export function update(change: (c: Connections) => void): void {
  const c = connections();
  change(c);
  const { local, session } = storages();
  const [keep, drop] = c.remember ? [local, session] : [session, local];
  try {
    drop?.removeItem(STORE);
    keep?.setItem(STORE, JSON.stringify(c));
  } catch {
    // storage blocked: they last until the page closes
  }
  for (const l of listeners) l();
}

export function forgetAll(): void {
  update((c) => Object.assign(c, blank()));
  const { local, session } = storages();
  try {
    local?.removeItem(STORE);
    session?.removeItem(STORE);
  } catch {
    // storage blocked
  }
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** "····a3f9": enough to tell keys apart, never the key. */
export const mask = (key: string) => (key ? `····${key.slice(-4)}` : '');

export const newEndpointId = () => Math.random().toString(36).slice(2, 10);

/**
 * Clearer errors for calls made from the browser: a network failure there usually means the endpoint
 * refused a browser call (CORS) or is down. A key never appears in a message.
 */
export function guarded(a: Adapter, host: string, key: string): Adapter {
  const fix = (e: unknown): never => {
    const err = e as Error;
    if (err?.name === 'TypeError') throw new Error(`Could not reach ${host}: it is down, or it does not allow calls from a browser (CORS).`);
    if (key && err?.message?.includes(key)) err.message = err.message.split(key).join('[key]');
    throw err;
  };
  return { ...a, warmUp: () => a.warmUp().catch(fix), decide: (q, signal, view) => a.decide(q, signal, view).catch(fix) };
}

/** The key an endpoint uses: its own, else the Opper key when it is an Opper URL. */
export const endpointKey = (e: MyEndpoint, c = connections()) => e.key.trim() || (isOpperUrl(e.url) ? c.opperKey.trim() : '');

export function directEndpoint(e: MyEndpoint, key = endpointKey(e)): Adapter {
  return guarded(endpointAdapter(e, key), hostOf(e.url) || 'the endpoint', key);
}

/** Checks an Opper key without spending anything: /v3/me answers with the project and balance. */
export async function checkOpperKey(key: string): Promise<{ ok: true; project: string; balance: string } | { ok: false; error: string }> {
  try {
    const res = await fetch('https://api.opper.ai/v3/me', { headers: { Authorization: `Bearer ${key.trim()}` }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Opper did not accept this key.' };
    if (!res.ok) return { ok: false, error: `Opper answered HTTP ${res.status}.` };
    const me = (await res.json()) as { project?: { name?: string }; balance?: { balance_dollars?: number } };
    const dollars = me.balance?.balance_dollars;
    return { ok: true, project: me.project?.name ?? 'your project', balance: typeof dollars === 'number' ? `$${dollars.toFixed(2)}` : '' };
  } catch {
    return { ok: false, error: 'Could not reach api.opper.ai.' };
  }
}

/** One line for the header: what is connected. */
export function summary(me: Me, c = connections()): string {
  const parts: string[] = [];
  if (me.mode === 'player') parts.push(me.user?.email ?? 'Signed in');
  else if (me.mode === 'dev') parts.push('local key');
  if (c.opperKey) parts.push(`key ${mask(c.opperKey)}`);
  const n = c.endpoints.length + (me.endpoints?.length ?? 0);
  if (n) parts.push(`${n} endpoint${n === 1 ? '' : 's'}`);
  return parts.join(', ');
}

export type Source = 'human' | 'baseline' | 'fighter' | 'key' | 'endpoint' | 'login' | 'dev' | 'none';

export interface Plan {
  source: Source;
  /** What the fighter's card says about who pays. */
  note: string;
  /** Why it cannot play, if it cannot. */
  problem: string | null;
  meta: (color: string) => FighterMeta;
  adapter: (baselineLatencyMs: number) => Adapter;
}

/** How a fighter plays: its own key, then the Opper key, then the Opper sign-in, then the local dev key. */
export function planFighter(choice: string, side: 0 | 1, me: Me, c = connections()): Plan {
  const own = c.fighterKeys[side].trim();
  if (choice === HUMAN) {
    return {
      source: 'human',
      note: 'You, with the keyboard. No API.',
      problem: null,
      meta: (color) => ({ model: HUMAN, label: 'Human', kind: 'human', color, via: 'human' }),
      adapter: () => humanAdapter(),
    };
  }
  if (isBaseline(choice)) {
    const info = modelInfo(choice);
    return {
      source: 'baseline',
      note: 'Runs in your browser, no API.',
      problem: null,
      meta: (color) => ({ model: choice, label: info.label, kind: info.kind, color }),
      adapter: (ms) => baselineAdapter(choice, ms),
    };
  }
  const endpointMeta = (e: Endpoint) => (color: string): FighterMeta => ({
    model: endpointModelId(e),
    label: e.name.trim(),
    kind: e.format === 'chat' ? 'chat' : 'systemone',
    color,
    via: 'custom',
    host: hostOf(e.url),
  });
  if (choice.startsWith(MINE)) {
    const e = c.endpoints.find((x) => x.id === choice.slice(MINE.length));
    if (!e) return { source: 'none', note: 'This endpoint was removed.', problem: 'Pick another fighter: that endpoint was removed.', meta: () => ({ model: choice, label: choice, kind: 'chat', color: '' }), adapter: () => remoteAdapter(choice) };
    const key = own || endpointKey(e, c);
    return {
      source: 'endpoint',
      note: `${hostOf(e.url)}${key ? `, key ${mask(key)}` : ', no key'}`,
      problem: endpointProblem(e),
      meta: endpointMeta(e),
      adapter: () => directEndpoint(e, key),
    };
  }
  if (choice.startsWith(FILE)) {
    const e = me.endpoints?.find((x) => x.id === choice.slice(FILE.length));
    if (!e) return { source: 'none', note: 'Not in fighters.json any more.', problem: 'Pick another fighter.', meta: () => ({ model: choice, label: choice, kind: 'chat', color: '' }), adapter: () => remoteAdapter(choice) };
    return { source: 'endpoint', note: `${hostOf(e.url)}, from fighters.json`, problem: null, meta: endpointMeta(e), adapter: () => remoteAdapter(choice) };
  }
  const info = modelInfo(choice);
  const meta = (via: FighterMeta['via']) => (color: string) => ({ model: choice, label: info.label, kind: info.kind, color, via });
  const key = own || c.opperKey.trim();
  if (key) {
    const deps: HttpDeps = { apiKey: key };
    return {
      source: own ? 'fighter' : 'key',
      note: `${own ? 'This fighter\'s key' : 'Your Opper key'} ${mask(key)}`,
      problem: null,
      meta: meta('key'),
      adapter: () => guarded(info.kind === 'systemone' ? systemOneAdapter(choice, deps) : chatAdapter(choice, { ...deps, params: info.params }), 'api.opper.ai', key),
    };
  }
  const source: Source = me.mode === 'player' ? 'login' : me.mode === 'dev' ? 'dev' : 'none';
  return {
    source,
    note: source === 'login' ? `Your Opper sign-in${me.user?.email ? ` (${me.user.email})` : ''}` : source === 'dev' ? 'The local OPPER_API_KEY' : 'Not connected',
    problem: source === 'none' ? 'Connect first: sign in with Opper or add an Opper API key.' : null,
    meta: meta('server'),
    adapter: () => remoteAdapter(choice),
  };
}
