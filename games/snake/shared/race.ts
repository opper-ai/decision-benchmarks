// The page's race (you against an AI) in real time: both boards step together on one clock, at the speed the visitor
// picks. The AI's side is the benchmark's own real-time player (RealtimeSnake, play.ts): it is asked about its board
// as soon as its last step is applied, one request at a time, and an answer that isn't in by the tick is too late, so
// the game's fallback moves the snake instead. Normal is the benchmark's clock (250 ms a step), the speed every model
// is ranked at. Isomorphic, so it can be tested without a page.
import { PLAYER_STEP_MS } from './player-check.ts';
import { STEP_MS } from './play.ts';

export { RealtimeSnake, startClock, type RealtimeSnakeOptions } from './play.ts';

export type RaceSpeed = 'relaxed' | 'normal' | 'fast';
export const RACE_SPEEDS: readonly RaceSpeed[] = ['relaxed', 'normal', 'fast'];
export const DEFAULT_SPEED: RaceSpeed = 'normal';
/** Milliseconds between steps. Normal is the benchmark's clock; Fast is the fastest the high-score check allows for. */
export const SPEED_STEP_MS: Record<RaceSpeed, number> = { relaxed: 400, normal: STEP_MS, fast: PLAYER_STEP_MS };
export const SPEED_NAMES: Record<RaceSpeed, string> = { relaxed: 'Relaxed', normal: 'Normal', fast: 'Fast' };
export const isRaceSpeed = (v: unknown): v is RaceSpeed => RACE_SPEEDS.includes(v as RaceSpeed);
