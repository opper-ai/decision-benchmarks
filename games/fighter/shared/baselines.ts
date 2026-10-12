import type { Adapter, Answer } from './adapter.ts';
import { gap, rand, type GameState } from './engine/engine.ts';
import { MOVE_IDS, MOVES, type MoveId } from './engine/moves.ts';
import { habit, simulateExchange, type Column, type Question } from './question.ts';

/**
 * Reference players that need no model. They appear on the leaderboard so a model's result can be
 * read against them: a model that cannot beat `random` is not deciding anything. The reading
 * baselines use only what the assisted question shows (or, on the raw track, the same simulation).
 */
export const BASELINES = ['baseline/random', 'baseline/guard', 'baseline/greedy', 'baseline/payoff', 'baseline/maximin'] as const;
export type BaselineId = (typeof BASELINES)[number];
export const isBaseline = (id: string): id is BaselineId => (BASELINES as readonly string[]).includes(id);

export const BASELINE_INFO: Record<BaselineId, string> = {
  'baseline/random': 'Picks uniformly among the offered moves.',
  'baseline/guard': 'Always blocks high.',
  'baseline/greedy': 'Best HP swing if the opponent stands or repeats its usual attack; ignores risk.',
  'baseline/payoff': "Best typical outcome: the payoff row's avg column.",
  'baseline/maximin': 'Best worst case: the move whose worst outcome is least bad.',
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (!ms) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });

const oneHot = (q: Question, move: MoveId) => Object.fromEntries(q.options.map((o) => [o.id, o.id === move ? 1 : 0])) as Partial<Record<MoveId, number>>;

/** The payoff row for every option: as shown in the question, else simulated the same way. */
function payoffRow(q: Question, view: GameState | undefined, id: MoveId): Partial<Record<Column, number>> {
  const o = q.options.find((x) => x.id === id)!;
  if (o.payoff) return o.payoff;
  if (!view) return {};
  const stand = simulateExchange(view, q.fighter, id, 'stand');
  let worst = stand?.swing ?? 0;
  for (const r of MOVE_IDS) {
    const x = simulateExchange(view, q.fighter, id, r);
    if (x && x.swing < worst) worst = x.swing;
  }
  let sum = stand?.swing ?? 0;
  let n = 1;
  for (const r of MOVE_IDS) {
    for (const after of [false, true]) {
      const x = simulateExchange(view, q.fighter, id, r, after);
      if (x) {
        sum += x.swing;
        n++;
      }
    }
  }
  const u = habit(view, q.fighter);
  return { stand: stand?.swing ?? 0, avg: sum / n, worst, ...(u ? { usual: simulateExchange(view, q.fighter, id, u)?.swing ?? 0 } : {}) };
}

/** Ties go toward fighting range: by shown distance for movement, current distance otherwise. */
function nearness(q: Question, view: GameState | undefined, id: MoveId): number {
  const o = q.options.find((x) => x.id === id)!;
  const g = MOVES[id].kind === 'movement' ? (o.endGap ?? (view ? gap(view) : 1000)) : view ? gap(view) : 1000;
  return -Math.abs(g - 1000) / 100000;
}

/** A baseline player. `latencyMs` simulates thinking time (use 0 in paused mode). */
export function baselineAdapter(id: BaselineId, latencyMs = 0): Adapter {
  return {
    id,
    kind: 'baseline',
    async warmUp() {},
    async decide(q: Question, signal: AbortSignal, view?: GameState): Promise<Answer> {
      await sleep(latencyMs, signal);
      const ids = q.options.map((o) => o.id);
      let move: MoveId;
      let probabilities: Partial<Record<MoveId, number>> | null;
      if (id === 'baseline/random') {
        const [r] = rand(((view?.seed ?? 1) ^ Math.imul(q.tick + 7, 2246822519) ^ (q.fighter ? 0x51ed : 0)) >>> 0);
        move = ids[Math.floor(r * ids.length)];
        probabilities = Object.fromEntries(ids.map((m) => [m, 1 / ids.length]));
      } else if (id === 'baseline/guard') {
        move = ids.includes('block_high') ? 'block_high' : ids[0];
        probabilities = oneHot(q, move);
      } else {
        const score = (m: MoveId) => {
          const p = payoffRow(q, view, m);
          const stand = p.stand ?? 0;
          const worst = p.worst ?? stand;
          const usual = p.usual;
          let v: number;
          if (id === 'baseline/greedy') v = Math.max(stand, usual ?? stand);
          else if (id === 'baseline/maximin') v = worst + stand / 100;
          else v = p.avg ?? (stand + worst) / 2;
          return v + nearness(q, view, m);
        };
        move = [...ids].sort().reduce((a, b) => (score(b) > score(a) ? b : a));
        probabilities = oneHot(q, move);
      }
      return { move, probabilities, latencyMs, costUsd: 0 };
    },
  };
}
