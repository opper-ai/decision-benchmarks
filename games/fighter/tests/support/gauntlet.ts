import type { DecideResponse, SystemOneRequest, Transport } from '../../../../packages/kit/shared/systemone.ts';
import game from '../../game.ts';
import type { GauntletRecording } from '../../shared/gauntlet.ts';
import { checkRequest } from '../../shared/request.ts';

/** Reads an assisted option's numbers: the average swing, with the worst case counting half. */
const value = (facts: string): number => {
  const num = (label: string) => Number(new RegExp(`${label} ([+-]?\\d+(?:\\.\\d+)?)`).exec(facts)?.[1] ?? 0);
  return num('avg') + 0.5 * num('worst');
};

/**
 * A fake decision model behind the kit's Transport, as the bench or the page would reach it: it reads the payoff rows,
 * answers every fifth question with a move that was not offered and fails every seventh call, so a match has invalid
 * answers and errors (fallbacks) too. Every request it gets is also put through the service's check; `refused` lists
 * any the check turned down.
 */
export function fakeModel(): { transport: Transport; refused: string[]; calls: () => number } {
  let n = 0;
  const refused: string[] = [];
  const transport: Transport = async (body: SystemOneRequest): Promise<DecideResponse> => {
    n++;
    const checked = checkRequest(body);
    if (!checked.ok) refused.push(checked.error);
    if (n % 7 === 0) throw new Error('model down');
    const criteria = body.questions.move!.criteria;
    const best = Object.keys(criteria).reduce((a, b) => (value(criteria[b]!) > value(criteria[a]!) ? b : a));
    const choice = n % 5 === 0 ? 'moonwalk' : best;
    return { model: body.model, answers: { move: { type: 'choice', choice, probabilities: { [choice]: 0.9 } } }, usage: { input_tokens: 600, output_tokens: 1 }, latencyMs: 40, costUsd: 0.0001, traceId: null };
  };
  return { transport, refused, calls: () => n };
}

/** A transport for the game's own players: never called. */
export const unused: Transport = async () => {
  throw new Error('a baseline is played by the game, not through a model');
};

/** Plays game `i` (seed seedFor(i)) with `model`, through `transport`. */
export async function playGame(i: number, model: string, transport: Transport = unused): Promise<{ recording: GauntletRecording; score: number }> {
  const { result, recording } = await game.play({ transport, seed: game.rules.seedFor(i), signal: new AbortController().signal, model });
  return { recording, score: result.score };
}
