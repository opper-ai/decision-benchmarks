import { questionName } from '../../src/brain';
import { greedyChoice, optionFeatures } from '../../src/features';
import { Recorder, roundDt, type Recording } from '../../src/replay';
import { createGame, step, type Controls } from '../../src/sim';
import type { Dir } from '../../src/types';
import { answerMessage, signAnswer } from '../../server/answers';
import { MIXED_LINEUP } from '../../shared/lineups';

export const TEST_SECRET = 's'.repeat(64);
const STEP = roundDt(1 / 60);

/**
 * A player's game the way the page records it: fixed 60 Hz steps, steering read before each step, and the ghosts'
 * answers through Controls, each signed as the server signs a model's answer (the ghosts here answer greedily).
 */
export function playAndRecord(seed: number, maxSteps = 6000, lineup: Record<string, string> = MIXED_LINEUP, secret = TEST_SECRET) {
  const state = createGame({ pacmanControl: 'keyboard', ghostsByAI: true });
  const rec = new Recorder();
  let frame = 0;
  const ghosts: Controls = {
    decide: (point, s) => {
      const dir = greedyChoice(s, point, optionFeatures(s, point));
      if (dir === null) return null;
      const model = lineup[point.actor]!;
      rec.decisions.push([frame, point.key, dir, `${model}~${signAnswer(secret, answerMessage(point.key, questionName(point), dir, model))}`]);
      return dir;
    },
  };
  const dirs: Dir[] = ['up', 'left', 'down', 'right'];
  let r = seed;
  const rand = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
  let steps = 0;
  for (; steps < maxSteps && state.status !== 'gameover'; steps++) {
    if (steps % 23 === 0) state.keyDir = dirs[Math.floor(rand() * 4)]!; // the player presses a key now and then
    frame = steps;
    rec.key(frame, state.keyDir);
    step(state, STEP, ghosts);
    rec.settle(state.keyDir);
  }
  const recording: Recording = {
    ...rec.finish(state, 'player', { pacmanControl: 'keyboard', ghostsByAI: true, lineup }),
    fixedStep: STEP,
    steps,
    final: { score: state.score, lives: state.lives, level: state.level, frames: steps },
  };
  return { state, recording };
}
