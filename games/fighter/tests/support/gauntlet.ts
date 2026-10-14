import type { DecideResponse, SystemOneRequest, Transport } from '../../../../packages/kit/shared/systemone.ts';
import game from '../../game.ts';
import { isBaseline } from '../../shared/baselines.ts';
import { matchSpec, playGauntlet, resultOf, type GauntletRecording } from '../../shared/gauntlet.ts';
import { checkRequest } from '../../shared/request.ts';
import { transportAdapter } from '../../shared/transport-adapter.ts';
import { FakeClock } from './fake.ts';

/** Reads a raw option's damage (0 for a move that deals none). */
const damage = (facts: string): number => Number(/(\d+) dmg/.exec(facts)?.[1] ?? 0);

/**
 * A fake decision model behind the kit's Transport, as the bench or the page would reach it, on a virtual clock: it
 * picks the hardest-hitting attack offered (else walks in), takes `latency(n)` ms for its n-th call, answers every fifth
 * question with a move that was not offered and fails every seventh call, so a match has invalid answers and errors
 * (fallbacks) too, and timeouts when a latency is over the deadline. Every request it gets is also put through the
 * service's check; `refused` lists any the check turned down.
 */
export function fakeModel(clock: FakeClock, latency: (n: number) => number = (n) => 150 + ((n * 37) % 400)): { transport: Transport; refused: string[]; calls: () => number } {
  let n = 0;
  const refused: string[] = [];
  const transport: Transport = async (body: SystemOneRequest, opts): Promise<DecideResponse> => {
    n++;
    const checked = checkRequest(body);
    if (!checked.ok) refused.push(checked.error);
    await clock.delay(latency(n), opts?.signal);
    if (n % 7 === 0) throw new Error('model down');
    const criteria = body.questions.move!.criteria;
    const ids = Object.keys(criteria);
    const best = ids.reduce((a, b) => (damage(criteria[b]!) > damage(criteria[a]!) ? b : a));
    const pick = damage(criteria[best]!) > 0 ? best : ids.includes('walk_forward') ? 'walk_forward' : ids[0]!;
    const choice = n % 5 === 0 ? 'moonwalk' : pick;
    return { model: body.model, answers: { move: { type: 'choice', choice, probabilities: { [choice]: 0.9 } } }, usage: { input_tokens: 600, output_tokens: 1 }, latencyMs: latency(n), costUsd: 0.0001, traceId: null };
  };
  return { transport, refused, calls: () => n };
}

/** A transport for the game's own players: never called. */
export const unused: Transport = async () => {
  throw new Error('a baseline is played by the game, not through a model');
};

/**
 * Plays game `i` (seed seedFor(i)) with `model`: a baseline as the bench plays it (game.play), a model through
 * `transport` on the virtual `clock` (a real match runs on the wall clock for minutes).
 */
export async function playGame(i: number, model: string, transport: Transport = unused, clock = new FakeClock()): Promise<{ recording: GauntletRecording; score: number }> {
  const seed = game.rules.seedFor(i);
  if (isBaseline(model)) {
    const { result, recording } = await game.play({ transport, seed, signal: new AbortController().signal, model });
    return { recording, score: result.score };
  }
  const recording = await playGauntlet({ seed, model, adapter: transportAdapter(model, transport, { now: clock.now }), clock });
  return { recording, score: resultOf(matchSpec(seed), recording.decisions, recording.result).score };
}
