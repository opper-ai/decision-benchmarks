// Waking the decision models before a table starts, as the other games do (kit ModelWarming, /api/warm): Opper scales
// idle models down, and a cold one would miss its 2.5 s on the first actions and fold to the fallback. Chat models
// need no warming (their 20 s covers a cold start, and System One's warm-up can't reach them).
import type { ModelWarming } from '../../../packages/kit/client/warming.ts';
import { modelById } from './roster.ts';

/** How long the table waits quietly before it says it is waking the models. */
export const SLOW_WARM_MS = 1000;

/** The decision models among a table's seats, each once. */
export const decisionModels = (ids: readonly string[]): string[] => [...new Set(ids.filter((id) => modelById(id)?.style === 'decision'))];

/**
 * Warms the table's decision models; `onSlow` runs once if that takes longer than `slowMs`. Resolves with the models
 * that would not wake (the table starts anyway: their fallback plays until they do).
 */
export async function warmTable(ids: readonly string[], warming: Pick<ModelWarming, 'warmAll'>, o: { onSlow(): void; slowMs?: number }): Promise<string[]> {
  const models = decisionModels(ids);
  if (!models.length) return [];
  const timer = setTimeout(o.onSlow, o.slowMs ?? SLOW_WARM_MS);
  try {
    return await warming.warmAll(() => models, () => {});
  } finally {
    clearTimeout(timer);
  }
}
