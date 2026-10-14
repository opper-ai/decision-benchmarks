// The recorded games Watch plays (public/demo/), one per ranked model, in leaderboard order: the first plays when the
// page opens. Each is that model's game from the official run whose apples are closest to its mean (on a tie, the
// lowest seed), copied as the bench wrote it (gzipped). Watch plays recordings only: no live model game ever runs for a
// visitor who did not ask to play. A model the leaderboard skips gets no chip.
import { modelName } from '../../../packages/kit/shared/models.ts';
import { isMove, replay, type GameState, type Move } from '../shared/engine.ts';

export interface DemoEntry {
  model: string;
  name: string;
  path: string;
  /** The official game it is (game-NNN, from 1) and its seed, for the record. */
  game: number;
  seed: number;
}

const entry = (model: string, file: string, game: number, seed: number): DemoEntry => ({ model, name: modelName(model), path: `demo/${file}.json.gz`, game, seed });

/** Chip order under the board, the leaderboard's: the first plays when the page opens. */
export const RECORDINGS: readonly DemoEntry[] = [
  entry('openai/gpt-6-luna-decisions', 'gpt-6-luna-decisions', 27, 1475144405), // 49 apples, mean 48.8
  entry('typesafe/jev-1.13.0', 'jev-1.13.0', 91, 517742837), // 38, mean 37.94
  entry('empiriolabs/aplomb-1', 'aplomb-1', 18, 267601721), // 25, mean 25.05
  entry('azure:global/microsoft-decision-1', 'microsoft-decision-1', 99, 398067641), // 20, mean 20.06
  entry('cloudflare:global/clef-flash', 'clef-flash', 65, 369816312), // 10, mean 9.87
  entry('sference/clef', 'clef', 49, 609166704), // 7, mean 6.97
  entry('opper/kev-4b', 'kev-4b', 68, 56502658), // 7, mean 6.71
  entry('berget/convaiinnovations/laya', 'laya', 89, 10790724), // 0, mean 0.34
];

export interface Demo {
  seed: number;
  moves: Move[];
  /** The game's final state (its apples, for the chip). */
  final: GameState;
}

/** A recording's seed and moves, if it replays to the game it claims; anything else is not shown. */
export function demoFrom(raw: unknown): Demo | null {
  const r = raw as { game?: unknown; seed?: unknown; steps?: unknown; result?: { score?: unknown } } | null;
  if (!r || r.game !== 'snake' || !Number.isInteger(r.seed) || !Array.isArray(r.steps)) return null;
  const moves = r.steps.map((s) => (s as { choice?: unknown })?.choice);
  if (!moves.every(isMove)) return null;
  const final = replay(r.seed as number, moves as Move[]);
  return final.over && final.apples === r.result?.score ? { seed: r.seed as number, moves: moves as Move[], final } : null;
}

/** A recording's JSON from its bytes: gzipped as the bench writes it, or already unpacked by a server on the way. */
async function jsonOf(bytes: Uint8Array): Promise<unknown> {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function loadDemo(url: string): Promise<Demo | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return res.ok ? demoFrom(await jsonOf(new Uint8Array(await res.arrayBuffer()))) : null;
  } catch {
    return null;
  }
}
