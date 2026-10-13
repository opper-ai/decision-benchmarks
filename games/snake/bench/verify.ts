// Replays a recorded game of Snake with our engine and recomputes its result (SPEC.md, "Recording and verify"). Every
// move must be one of the three options; a move marked as the fallback's must be what the fallback rule gives there,
// so model moves can't pass as fallbacks or the other way round; the game must end exactly where the recording does,
// and the way it claims.
import { createHash } from 'node:crypto';
import type { Verdict } from '../../../packages/kit/shared/game.ts';
import { createGame, isMove, MAX_STEPS, MOVES, step, type Move } from '../shared/engine.ts';
import { resultOf } from '../shared/play.ts';
import { allFacts, fallbackMove, viewOf } from '../shared/questions.ts';
import { BENCH_VERSION, type Recording, type SnakeResult, type Step } from '../shared/recording.ts';

/** Far above any real call: one decision costs fractions of a cent and gives up after seconds. */
const MAX_CALL_USD = 1;
const MAX_CALL_MS = 60_000;
const MAX_SIG_CHARS = 64;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const within = (v: unknown, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;

/** Why a recorded step is malformed, or null. */
function stepProblem(s: unknown): string | null {
  if (!isObj(s)) return 'not an object';
  if (Object.keys(s).some((k) => !['choice', 'source', 'probabilities', 'latencyMs', 'costUsd', 'sig'].includes(k))) return 'unknown fields';
  if (!isMove(s.choice)) return `${String(s.choice).slice(0, 20)} is not one of ${MOVES.join(', ')}`;
  if (s.source !== 'model' && s.source !== 'fallback') return 'source must be model or fallback';
  if (s.probabilities !== undefined && !(isObj(s.probabilities) && Object.entries(s.probabilities).every(([k, p]) => isMove(k) && within(p, 1)))) return 'probabilities must map moves to 0 to 1';
  if (s.latencyMs !== undefined && !within(s.latencyMs, MAX_CALL_MS)) return 'a negative or impossible latency';
  if (s.costUsd !== undefined && !within(s.costUsd, MAX_CALL_USD)) return 'a negative or impossible cost';
  if (s.sig !== undefined && !(typeof s.sig === 'string' && s.sig.length <= MAX_SIG_CHARS)) return 'a malformed signature';
  return null;
}

export function verifyGame(raw: unknown, o: { seed: number }): Verdict<SnakeResult> {
  const fail = (error: string): Verdict<SnakeResult> => ({ ok: false, error });
  if (!isObj(raw) || raw.format !== 1 || raw.game !== 'snake') return fail('not a format 1 Snake recording');
  const rec = raw as unknown as Recording;
  if (rec.benchVersion !== BENCH_VERSION) return fail(`recorded on bench version ${String(rec.benchVersion)}, the current one is ${BENCH_VERSION}`);
  if (rec.seed !== o.seed) return fail(`played seed ${String(rec.seed)}, not ${o.seed}`);
  if (typeof rec.model !== 'string' || !rec.model || rec.model.length > 120) return fail('model must be text');
  if (!Array.isArray(rec.steps) || rec.steps.length < 1 || rec.steps.length > MAX_STEPS) return fail(`steps must list 1 to ${MAX_STEPS} moves`);
  for (let i = 0; i < rec.steps.length; i++) {
    const problem = stepProblem(rec.steps[i]);
    if (problem) return fail(`step ${i + 1}: ${problem}`);
  }

  let state = createGame(o.seed);
  const fingerprint = createHash('sha256').update(`${o.seed}|`);
  for (let i = 0; i < rec.steps.length; i++) {
    if (state.over) return fail(`step ${i + 1} comes after the game ended (${state.over})`);
    const s: Step = rec.steps[i]!;
    if (s.source === 'fallback') {
      const rule: Move = fallbackMove(allFacts(viewOf(state)));
      if (s.choice !== rule) return fail(`step ${i + 1} is marked as the fallback's, but the fallback moves ${rule} there, not ${s.choice}`);
    }
    fingerprint.update(s.choice[0]!);
    state = step(state, s.choice);
  }
  if (!state.over) return fail(`the game stops after ${state.steps} steps, before it ended`);
  const claimed = rec.result;
  if (!isObj(claimed) || claimed.score !== state.apples || claimed.steps !== state.steps || claimed.end !== state.over) {
    return fail(`the replay ends with ${state.apples} apples after ${state.steps} steps (${state.over}); the recording claims ${String((claimed as { score?: unknown })?.score)} apples after ${String((claimed as { steps?: unknown })?.steps)} steps (${String((claimed as { end?: unknown })?.end)})`);
  }
  return { ok: true, result: resultOf(state, rec.steps), fingerprint: fingerprint.digest('hex') };
}
