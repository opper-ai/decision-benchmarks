import { InvalidAnswer, type Adapter, type Answer } from '../shared/adapter.ts';
import type { ModelInfo } from '../shared/models.ts';
import type { Endpoint } from '../shared/endpoints.ts';
import type { Question } from '../shared/question.ts';
import { decodeReplay, encodeReplay, type Replay } from '../shared/replay.ts';
import type { Leaderboard, MatchSummary, Source } from '../shared/stats.ts';

export interface Me {
  mode: 'player' | 'dev' | 'none';
  user: { name?: string; email?: string } | null;
  loginAvailable: boolean;
  models: ModelInfo[];
  /** Endpoints from the server's fighters.json (no keys). */
  endpoints?: Endpoint[];
  /** May delete replays (an admin email, or localhost). */
  admin?: boolean;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const getMe = () => getJson<Me>('/api/me');
export const getReplays = (source: Source | 'all' = 'all') =>
  getJson<{ replays: (MatchSummary & { source: Source })[]; counts: Record<Source, number> }>(`/api/replays?source=${source}`);
export const getLeaderboard = (mode: 'realtime' | 'paused', track: 'assisted' | 'raw' = 'assisted', community = false) =>
  getJson<Leaderboard>(`/api/leaderboard?mode=${mode}&track=${track}${community ? '&community=1' : ''}`);

export async function getReplay(id: string): Promise<{ replay: Replay; source: Source }> {
  const res = await fetch(`/api/replays/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(res.status === 404 ? 'No such replay' : `HTTP ${res.status}`);
  const source: Source = res.headers.get('X-Replay-Source') === 'official' ? 'official' : 'community';
  return { replay: await decodeReplay(new Uint8Array(await res.arrayBuffer())), source };
}

/** Sent gzipped, as it is stored: a few MB of JSON becomes 15-150 KB. */
export async function saveReplay(r: Replay): Promise<{ id: string; source: Source }> {
  const res = await fetch('/api/replays', { method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body: (await encodeReplay(r)) as BodyInit });
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string; source?: Source };
  if (!res.ok || !body.id) throw new Error(body.error ?? `HTTP ${res.status}`);
  return { id: body.id, source: body.source ?? 'community' };
}

export async function deleteReplay(id: string): Promise<void> {
  const res = await fetch(`/api/replays/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
}

export async function logout(): Promise<void> {
  const res = await fetch('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
}

/** A model played through this site's server, which holds the key. */
export function remoteAdapter(model: string): Adapter {
  const post = async (path: string, body: unknown, signal: AbortSignal) => {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const msg = typeof json.error === 'string' ? json.error : `HTTP ${res.status}`;
      if (json.reason === 'invalid') throw new InvalidAnswer(msg);
      const e = new Error(msg);
      if (json.reason === 'timeout') e.name = 'TimeoutError';
      throw e;
    }
    return json;
  };
  return {
    id: model,
    kind: 'remote',
    async warmUp() {
      await post('/api/warm', { model }, AbortSignal.timeout(60_000));
    },
    /** The server streams two JSON lines: the move as soon as it is known, then the completed answer. */
    async decide(question: Question, signal: AbortSignal): Promise<Answer> {
      const started = performance.now();
      const res = await fetch('/api/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, question }), signal });
      if (!res.ok || !res.body) {
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const msg = typeof json.error === 'string' ? json.error : `HTTP ${res.status}`;
        if (json.reason === 'invalid') throw new InvalidAnswer(msg);
        const e = new Error(msg);
        if (json.reason === 'timeout') e.name = 'TimeoutError';
        throw e;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const nextLine = async (): Promise<string | null> => {
        for (;;) {
          const nl = buffer.indexOf('\n');
          if (nl >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            return line;
          }
          const { done, value } = await reader.read();
          if (done) return buffer || null;
          buffer += decoder.decode(value, { stream: true });
        }
      };
      const first = await nextLine();
      if (!first) throw new Error('empty answer');
      // Latency as the player experiences it: includes this site's hop.
      const answer = { ...(JSON.parse(first) as Answer), latencyMs: Math.round(performance.now() - started) };
      void nextLine()
        .then((line) => {
          if (!line) return;
          const full = JSON.parse(line) as Answer;
          answer.probabilities = full.probabilities;
          answer.costUsd = full.costUsd;
          if (full.inputTokens !== undefined) answer.inputTokens = full.inputTokens;
        })
        .catch(() => {});
      return answer;
    },
  };
}
