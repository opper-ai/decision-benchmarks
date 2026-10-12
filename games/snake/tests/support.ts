// Helpers for Snake's tests: baseline games played through the real play loop, as the bench plays them.
import { baselineTransport, type BaselineName } from '../shared/baselines';
import { playSnake } from '../shared/play';

export const playBaseline = (name: BaselineName, seed: number) => playSnake({ transport: baselineTransport(name), seed, model: `baseline/${name}`, timeoutMs: 2000 });
