// Snake's free baselines (SPEC.md, "Baselines"): scripted players that read the same question a model gets and answer
// through the same transport, so the bench (`--model baseline/<name>`) and the page play them like models, without a
// key or a network call. For reference only: they never go on the official leaderboard. Isomorphic.
import type { Baseline } from '../../../packages/kit/shared/game.ts';
import type { DecideResponse, SystemOneRequest, Transport } from '../../../packages/kit/shared/systemone.ts';
import { mulberry32, type Move } from './engine.ts';
import { allFacts, parseState, QUESTION, type Facts, type View } from './questions.ts';

export type BaselineName = 'random' | 'greedy' | 'flood';
export const BASELINE_NAMES: readonly BaselineName[] = ['random', 'greedy', 'flood'];

/** A number from the board, so the random baseline plays the same game every time on the same seed. */
function boardHash(v: View): number {
  let h = 2166136261;
  for (const ch of `${v.rows.join('')}|${v.heading}|${v.step}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h | 0;
}

const closest = (fs: readonly Facts[]): Facts | undefined => fs.reduce<Facts | undefined>((best, f) => (best === undefined || (f.distance ?? Infinity) < (best.distance ?? Infinity) ? f : best), undefined);

/** Each baseline's pick from the facts of the three moves (all deadly: straight). */
export const PICK: Record<BaselineName, (facts: readonly Facts[], v: View) => Move> = {
  /** Uniform over the moves that are not deadly. */
  random(facts, v) {
    const ok = facts.filter((f) => !f.deadly);
    return ok.length ? ok[Math.floor(mulberry32(boardHash(v))[0] * ok.length)]!.move : 'straight';
  },
  /** The move that ends closest to the apple, among those that are not deadly. */
  greedy(facts) {
    return closest(facts.filter((f) => !f.deadly))?.move ?? 'straight';
  },
  /** Greedy, but never into a space smaller than the snake; with no such move, the one with the most room. */
  flood(facts, v) {
    const ok = facts.filter((f) => !f.deadly);
    const roomy = ok.filter((f) => f.reachable >= v.length + (f.next === 'apple' ? 1 : 0));
    if (roomy.length) return closest(roomy)!.move;
    return ok.reduce<Facts | undefined>((best, f) => (best === undefined || f.reachable > best.reachable ? f : best), undefined)?.move ?? 'straight';
  },
};

const NAMES: Record<BaselineName, string> = { random: 'Random', greedy: 'Greedy', flood: 'Flood fill' };

/** A baseline as a transport: it reads the request's board and answers the snake question. */
export function baselineTransport(name: BaselineName): Transport {
  return async (body: SystemOneRequest): Promise<DecideResponse> => {
    const v = parseState(body.state);
    if (!v || !body.questions?.[QUESTION]) throw new Error(`baseline/${name} only answers Snake's question`);
    // The baseline picks a move; the question asks for the direction it goes.
    const facts = allFacts(v);
    const move = PICK[name](facts, v);
    const choice = facts.find((f) => f.move === move)!.heading;
    return { model: `baseline/${name}`, answers: { [QUESTION]: { type: 'choice', choice } }, usage: { input_tokens: 0, output_tokens: 0 }, latencyMs: 0, costUsd: null, traceId: null };
  };
}

export const BASELINES: Record<BaselineName, Baseline> = Object.fromEntries(BASELINE_NAMES.map((n) => [n, { name: NAMES[n], transport: () => baselineTransport(n) }])) as Record<BaselineName, Baseline>;

export const isBaselineId = (id: string): id is `baseline/${BaselineName}` => BASELINE_NAMES.some((n) => id === `baseline/${n}`);
export const baselineName = (id: string): string => (isBaselineId(id) ? NAMES[id.slice('baseline/'.length) as BaselineName] : id);
