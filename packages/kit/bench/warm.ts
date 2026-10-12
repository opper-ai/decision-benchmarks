import { WARM_UP_REQUEST, type Transport } from '../shared/systemone.ts';

/**
 * Opper-hosted models scale down when idle, and the first calls can take many seconds; a game would turn them into
 * fallbacks. Calls the model with a tiny fixed question until one answer comes back fast enough for the game (under
 * `fastMs`), within `budgetMs`. Null once warm, else why not.
 */
export async function warmUp(transport: Transport, o: { fastMs: number; budgetMs?: number; now?: () => number; log?: (line: string) => void }): Promise<string | null> {
  const now = o.now ?? (() => performance.now());
  const budget = o.budgetMs ?? 300_000;
  const started = now();
  let last = 'no answer';
  for (let attempt = 1; now() - started < budget; attempt++) {
    const t0 = now();
    try {
      await transport(WARM_UP_REQUEST);
      const ms = Math.round(now() - t0);
      if (ms < o.fastMs) {
        o.log?.(`  warm: answered in ${ms} ms (attempt ${attempt})`);
        return null;
      }
      last = `answered in ${ms} ms, slower than ${o.fastMs} ms`;
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      // A timeout is a sleepy model: try again. Anything else (a key, a model not enabled) will not fix itself.
      if (!/timed out|timeout/i.test(message)) return message;
      last = message;
    }
  }
  return `not warm after ${Math.round(budget / 1000)} s of trying (${last})`;
}
