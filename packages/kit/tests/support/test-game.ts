import { answerMessage } from '../../shared/answers';
import type { GameDefinition, GameResult, GameServer } from '../../shared/game';
import { isModelId } from '../../shared/models';
import type { SystemOneRequest } from '../../shared/systemone';

/**
 * A tiny game for the kit's tests: call a coin flip. Its request check rebuilds the one question it asks, so anything
 * else is refused, and its high-score check takes a list of signed calls and scores the right ones.
 */
export const COIN_QUESTION = { type: 'choice' as const, instructions: 'Call the coin.', criteria: { heads: 'Heads', tails: 'Tails' } };
export const coinBody = (model?: string) => ({ ...(model ? { model } : {}), state: { flips: 3 }, questions: { coin: COIN_QUESTION }, keys: { coin: 'flip-1' } });

export function coinServer(slug = 'coin'): GameServer {
  return {
    slug,
    decideRequest(body) {
      const b = body as Partial<SystemOneRequest> | null;
      if (!b || typeof b !== 'object' || Object.keys(b).some((k) => !['model', 'state', 'questions', 'keys'].includes(k))) return { ok: false, error: 'not a coin request' };
      const flips = (b.state as { flips?: unknown } | undefined)?.flips;
      if (!Number.isInteger(flips) || JSON.stringify(b.questions) !== JSON.stringify({ coin: COIN_QUESTION })) return { ok: false, error: 'not a coin request' };
      if (b.model !== undefined && !isModelId(b.model)) return { ok: false, error: 'unknown model' };
      const key = (b.keys as Record<string, unknown> | undefined)?.coin;
      return { ok: true, request: { ...(b.model ? { model: b.model } : {}), state: { flips: flips as number }, questions: { coin: COIN_QUESTION } }, ...(typeof key === 'string' ? { keys: { coin: key } } : {}) };
    },
    highScores: {
      boards: [
        { id: 'all', label: 'All' },
        { id: 'jev', label: 'Jev' },
      ],
      check(rec, verify) {
        const r = rec as { board?: unknown; calls?: unknown } | null;
        if (!r || !Array.isArray(r.calls) || (r.board !== 'all' && r.board !== 'jev')) return { ok: false, error: 'not a recording' };
        let score = 0;
        for (const c of r.calls as [string, string, string, string][]) {
          const [key, choice, model, sig] = c;
          if (!verify(answerMessage(key, 'coin', choice, model), sig)) return { ok: false, error: 'an answer no model gave' };
          if (choice === 'heads') score += 1;
        }
        return { ok: true, score, board: r.board };
      },
    },
  };
}

export interface CoinResult extends GameResult {
  heads: number;
}

/** The coin game for the bench and the submissions check: a recording is the seed and the calls made. */
export function coinDefinition(over: Partial<GameDefinition<{ seed: number; calls: string[] }, CoinResult>> = {}): GameDefinition<{ seed: number; calls: string[] }, CoinResult> {
  return {
    slug: 'coin',
    benchVersion: 2,
    mode: 'paused',
    timing: { decisionTimeoutMs: 1000, callTimeoutMs: 1000, maxInFlight: 1 },
    rules: { minGames: 2, officialGames: 3, seedFor: (i) => 1000 + i, maxRecordingBytes: 64 * 1024 },
    metric: { name: 'Heads', unit: 'heads', higherIsBetter: true },
    async play({ transport, seed }) {
      const res = await transport({ state: { flips: seed }, questions: { coin: COIN_QUESTION } });
      const choice = (res.answers.coin as { choice?: string } | undefined)?.choice ?? 'tails';
      const heads = choice === 'heads' ? 1 : 0;
      return { result: { score: heads, heads, calls: 1, decisions: 1, fallbacks: 0, latencyMsSum: res.latencyMs, cost: res.costUsd ?? 0 }, recording: { seed, calls: [choice] } };
    },
    verify(rec, { seed }) {
      const r = rec as { seed?: unknown; calls?: unknown };
      if (r?.seed !== seed) return { ok: false, error: `played seed ${String(r?.seed)}, not ${seed}` };
      if (!Array.isArray(r.calls)) return { ok: false, error: 'no calls' };
      const heads = r.calls.filter((c) => c === 'heads').length;
      return { ok: true, result: { score: heads, heads, calls: r.calls.length, decisions: r.calls.length, fallbacks: 0, latencyMsSum: 0, cost: 0 }, fingerprint: JSON.stringify(r) };
    },
    summarize: (results) => ({ meanHeads: results.reduce((a, r) => a + r.heads, 0) / Math.max(1, results.length) }),
    ...over,
  };
}
