// Helpers for Snake's tests: baseline games played through the real play loop, as the bench plays them, on a 1 ms
// clock (a baseline answers at once, so the clock's speed changes nothing but how long the test takes).
import { baselineTransport, type BaselineName } from '../shared/baselines';
import { playSnake } from '../shared/play';

export const playBaseline = (name: BaselineName, seed: number) => playSnake({ transport: baselineTransport(name), seed, model: `baseline/${name}`, timeoutMs: 2000, stepMs: 1 });
