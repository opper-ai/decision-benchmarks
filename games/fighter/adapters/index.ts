import type { Adapter } from '../shared/adapter.ts';
import { baselineAdapter, isBaseline } from '../shared/baselines.ts';
import { modelInfo } from '../shared/models.ts';
import { chatAdapter } from './chat.ts';
import { systemOneAdapter, type HttpDeps } from './systemone.ts';

/** The adapter for a model id: System One models by the known list, anything else as a chat model. */
export function adapterFor(id: string, deps: HttpDeps, kind = modelInfo(id).kind, baselineLatencyMs = 0): Adapter {
  if (isBaseline(id)) return baselineAdapter(id, baselineLatencyMs);
  return kind === 'systemone' ? systemOneAdapter(id, deps) : chatAdapter(id, { ...deps, params: modelInfo(id).params });
}
