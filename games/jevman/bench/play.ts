// One benchmark game in real time: a model plays Pac-Man through `transport` against the scripted ghosts, until game
// over or the time cap, while every step, decision and scheduler event is recorded for the submissions check.
import type { Transport } from '../../../packages/kit/shared/systemone.ts';
import { Recorder, roundDt, type Recording } from '../src/replay.ts';
import { Scheduler } from '../src/scheduler.ts';
import { createGame, step, type Controls } from '../src/sim.ts';
import { GameStats } from '../src/stats.ts';
import { GHOST_IDS } from '../src/types.ts';
import { SUBMISSION_RULES, type GameResult } from '../shared/leaderboard.ts';
import { emptyResult, finishResult, scriptedControls } from './scripted.ts';

export interface PlayOptions {
  transport: Transport;
  /** The id the recording names the model by. */
  model: string;
  signal?: AbortSignal;
  maxSeconds?: number;
  timeoutMs?: number;
  maxInFlight?: number;
}

/**
 * Plays one game the way the leaderboard does: the frame loop sleeps about 16 ms between steps and steps by the real
 * time that passed (at most 50 ms), so a slow model costs game time, as it would on the page.
 */
export async function playGame(o: PlayOptions): Promise<{ result: GameResult; recording: Recording }> {
  const maxSeconds = o.maxSeconds ?? SUBMISSION_RULES.maxSeconds;
  const state = createGame();
  const r = emptyResult();
  const stats = new GameStats();
  const recorder = new Recorder();
  let frame = 0;
  const scheduler = new Scheduler({
    transport: o.transport,
    now: () => performance.now(),
    actors: ['pacman'],
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    ...(o.maxInFlight ? { maxInFlight: o.maxInFlight } : {}),
    onEvent: (e) => {
      recorder.record(frame, e);
      stats.onSchedulerEvent(e);
      if (e.type === 'call') {
        r.calls += 1;
        r.cost += e.costUsd ?? 0;
        if (Number.isFinite(e.latencyMs)) r.latencyMsSum += e.latencyMs;
      }
    },
  });
  const scripted = scriptedControls();
  const ctl: Controls = recorder.wrap({ decide: (point, s) => (point.actor === 'pacman' ? scheduler.decide(point, s) : scripted.decide(point, s)) }, () => frame);
  let last = performance.now();
  while (state.status !== 'gameover' && r.survived < maxSeconds) {
    if (o.signal?.aborted) throw new Error('the game was stopped');
    await new Promise((res) => setTimeout(res, 16));
    const now = performance.now();
    const dt = roundDt(Math.min(SUBMISSION_RULES.maxStep, (now - last) / 1000));
    last = now;
    recorder.frames.push(dt);
    scheduler.update(state);
    const fruitBefore = state.fruit;
    stats.beforeStep(state);
    step(state, dt, ctl);
    stats.afterStep(state, dt);
    if (!fruitBefore && state.fruit) r.fruitSpawned += 1;
    for (const a of [state.pacman, ...GHOST_IDS.map((id) => state.ghosts[id])]) {
      if (a.id !== 'pacman' && state.ghosts[a.id].state === 'house') continue;
      const into = state.maze.neighbor(a.tile, a.dir);
      if (!state.maze.isWalkable(a.tile) || (a.progress > 0 && !state.maze.isWalkable(into))) {
        throw new Error(`${a.id} left the maze at (${a.tile.x},${a.tile.y}) heading ${a.dir}, progress ${a.progress.toFixed(2)}`);
      }
    }
    if (state.status === 'playing') r.survived += dt;
    frame += 1;
  }
  finishResult(r, stats, state);
  return { result: r, recording: recorder.finish(state, o.model) };
}
