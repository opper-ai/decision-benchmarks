import type { Adapter, Answer } from './adapter.ts';
import { gap, rand, type GameState } from './engine/engine.ts';
import { MOVE_IDS, MOVES, type MoveId } from './engine/moves.ts';
import { buildQuestion, habit, simulateExchange, type Column, type Question } from './question.ts';

/**
 * Reference players that need no model. They appear on the leaderboard so a model's result can be
 * read against them: a model that cannot beat `random` is not deciding anything. The reading
 * baselines use only what the assisted question shows (on the raw track they work it out from the state).
 */
export const BASELINES = ['baseline/random', 'baseline/guard', 'baseline/greedy', 'baseline/payoff', 'baseline/maximin'] as const;
export type BaselineId = (typeof BASELINES)[number];
export const isBaseline = (id: string): id is BaselineId => (BASELINES as readonly string[]).includes(id);

/** E.g. "Greedy baseline". */
export const baselineName = (id: BaselineId): string => `${id[9]!.toUpperCase()}${id.slice(10)} baseline`;

export const BASELINE_INFO: Record<BaselineId, string> = {
  'baseline/random': 'Picks uniformly among the offered moves.',
  'baseline/guard': 'Always blocks high.',
  'baseline/greedy': 'Best HP swing if the opponent stands or repeats its usual attack; ignores risk.',
  'baseline/payoff': "Best typical outcome: the payoff row's avg column.",
  'baseline/maximin': 'Best worst case: the move whose worst outcome is least bad.',
};

/**
 * How long a baseline thinks in a real-time match: about a fast classifier's answer. The page's baselines wait this
 * long; the benchmark's answer this many milliseconds' worth of frames after they are asked (shared/gauntlet.ts).
 */
export const BASELINE_THINK_MS = 250;

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

/**
 * A baseline's move for a question: what `id` picks, with its probabilities. Synchronous and deterministic: the bench
 * plays the gauntlet with it and the verifier recomputes every baseline move with it. `view` is the state the
 * question describes.
 */
export function baselineAnswer(id: BaselineId, asked: Question, view?: GameState): { move: MoveId; probabilities: Partial<Record<MoveId, number>> } {
  // A baseline reads the payoff rows whatever the track: on the raw track it works out the assisted question (the same
  // options, with their payoffs) from the state, so it plays the same on both. It is an opponent, not the test.
  const reads = id !== 'baseline/random' && id !== 'baseline/guard';
  const q = reads && asked.track === 'raw' && view ? buildQuestion(view, asked.fighter, { track: 'assisted' }) : asked;
  const ids = q.options.map((o) => o.id);
  if (id === 'baseline/random') {
    const [r] = rand(((view?.seed ?? 1) ^ Math.imul(q.tick + 7, 2246822519) ^ (q.fighter ? 0x51ed : 0)) >>> 0);
    return { move: ids[Math.floor(r * ids.length)], probabilities: Object.fromEntries(ids.map((m) => [m, 1 / ids.length])) };
  }
  if (id === 'baseline/guard') {
    const move = ids.includes('block_high') ? 'block_high' : ids[0];
    return { move, probabilities: oneHot(q, move) };
  }
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
  const move = [...ids].sort().reduce((a, b) => (score(b) > score(a) ? b : a));
  return { move, probabilities: oneHot(q, move) };
}

/** A baseline player. `latencyMs` simulates thinking time (use 0 in paused mode). */
export function baselineAdapter(id: BaselineId, latencyMs = 0): Adapter {
  return {
    id,
    kind: 'baseline',
    async warmUp() {},
    async decide(q: Question, signal: AbortSignal, view?: GameState): Promise<Answer> {
      await sleep(latencyMs, signal);
      return { ...baselineAnswer(id, q, view), latencyMs, costUsd: 0 };
    },
  };
}
