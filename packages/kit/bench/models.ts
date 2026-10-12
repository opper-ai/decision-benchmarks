import { DECISION_MODELS } from '../shared/models.ts';

/**
 * The live list of decision models: GET https://api.opper.ai/v3/models?type=evaluation. The checked-in list
 * (packages/kit/shared/models.ts) is what runs; `npm run bench -- --list-models` compares the two so a new route
 * lands by pull request. Tests pass their own fetch: nothing here runs without being asked.
 */
export const MODELS_URL = 'https://api.opper.ai/v3/models?type=evaluation';

export interface LiveModel {
  id: string;
  name?: string;
}

/** The ids (and names) the models API lists, from its { data: [...] } or bare list answer. */
export async function fetchEvaluationModels(f: typeof fetch = fetch, url = MODELS_URL): Promise<LiveModel[]> {
  const res = await f(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  const list = Array.isArray(body) ? body : Array.isArray((body as { data?: unknown })?.data) ? (body as { data: unknown[] }).data : Array.isArray((body as { models?: unknown })?.models) ? (body as { models: unknown[] }).models : [];
  return list
    .map((m) => (m && typeof m === 'object' ? (m as Record<string, unknown>) : {}))
    .filter((m) => typeof m.id === 'string')
    .map((m) => ({ id: m.id as string, ...(typeof m.name === 'string' ? { name: m.name } : typeof m.display_name === 'string' ? { name: m.display_name } : {}) }));
}

/** What the live list adds to and drops from the checked-in one. */
export function diffModels(live: readonly LiveModel[], known: readonly { id: string }[] = DECISION_MODELS): { added: LiveModel[]; gone: string[] } {
  const liveIds = new Set(live.map((m) => m.id));
  const knownIds = new Set(known.map((m) => m.id));
  return { added: live.filter((m) => !knownIds.has(m.id)), gone: known.map((m) => m.id).filter((id) => !liveIds.has(id)) };
}
