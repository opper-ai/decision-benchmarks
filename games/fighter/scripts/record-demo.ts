// Records a match for Watch (public/demo/), gzipped. Two kinds:
//
//   node games/fighter/scripts/record-demo.ts --model <id> --bench-seed <n> --out <file>
//       one benchmark game, exactly as `npm run bench -- --game fighter --seed <n>` plays it (the model against the
//       baseline that seed picks, from the side it picks), so it passes the submissions check
//   node games/fighter/scripts/record-demo.ts --left <id> --right <id> --fight <k> --out <file>
//       two decision models against each other, on the benchmark's settings (real time, raw track, 2 s deadline,
//       fight k's start), which the bench does not play
//
// Both play live, on the wall clock: a match takes as long as it lasts (a minute or several).
//
// --label <id>=<name> (repeatable) names a fighter on the stage and the Watch chip. Models go through Opper with
// OPPER_API_KEY (or TYPESAFE_API_KEY for Jev). Costs what the calls cost; the total is printed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { systemOneTransport } from '../../../packages/kit/bench/transports.ts';
import { warmUp } from '../../../packages/kit/bench/warm.ts';
import { devTargetFromEnv } from '../../../packages/kit/server/systemone.ts';
import { isModelId } from '../../../packages/kit/shared/models.ts';
import type { Adapter } from '../shared/adapter.ts';
import type { Side } from '../shared/engine/engine.ts';
import { benchMatch, DEADLINE_MS, engineSeedFor, matchSpec, playGauntlet, SIDE_COLORS } from '../shared/gauntlet.ts';
import { modelInfo } from '../shared/models.ts';
import type { FighterMeta, Replay } from '../shared/replay.ts';
import { transportAdapter } from '../shared/transport-adapter.ts';

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    'bench-seed': { type: 'string' },
    left: { type: 'string' },
    right: { type: 'string' },
    fight: { type: 'string' },
    label: { type: 'string', multiple: true, default: [] },
    out: { type: 'string' },
  },
});
const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
if (!values.out) die('--out <file> is required');
const target = devTargetFromEnv(process.env) ?? die('set OPPER_API_KEY (or TYPESAFE_API_KEY for Jev)');
const labels = new Map(values.label.map((l) => l.split('=', 2) as [string, string]));

async function adapterFor(model: string) {
  if (!isModelId(model)) die(`not a listed decision model: ${model}`);
  const transport = systemOneTransport(model, target, DEADLINE_MS, 'decision-benchmarks-demo-fighter');
  const problem = await warmUp(transport, { fastMs: DEADLINE_MS * 0.9, log: (l) => console.log(`${model}${l}`) });
  if (problem) die(`${model}: ${problem}`);
  return transportAdapter(model, transport);
}

let rec: Replay;
if (values.model !== undefined) {
  const seed = Number(values['bench-seed']);
  if (!Number.isSafeInteger(seed) || seed < 0) die('--bench-seed must be a whole number of at least 0');
  const spec = matchSpec(seed);
  console.log(`bench seed ${seed}: ${values.model} on side ${spec.side} against ${spec.opponent}`);
  rec = await playGauntlet({ seed, model: values.model, adapter: await adapterFor(values.model) });
} else {
  const ids = [values.left ?? die('--left <id> or --model <id>'), values.right ?? die('--right <id>')] as const;
  const fight = Number(values.fight);
  if (!Number.isSafeInteger(fight) || fight < 0) die('--fight must be a whole number of at least 0');
  const adapters = await Promise.all(ids.map(adapterFor));
  const fighters = ids.map((model, i): FighterMeta => ({ model, label: modelInfo(model).label, kind: 'systemone', color: SIDE_COLORS[i]! })) as [FighterMeta, FighterMeta];
  rec = await benchMatch({ seed: engineSeedFor(fight), adapters: adapters as [Adapter, Adapter], fighters }).run();
}

for (const f of rec.fighters) f.label = labels.get(f.model) ?? f.label;
mkdirSync(dirname(values.out!), { recursive: true });
const bytes = gzipSync(JSON.stringify(rec), { level: 9 });
writeFileSync(values.out!, bytes);

const won = (s: Side) => rec.result.rounds.filter((r) => r.winner === s).length;
console.log(`${rec.fighters[0].label} vs ${rec.fighters[1].label}: ${rec.result.winner === null ? 'draw' : `${rec.fighters[rec.result.winner].label} wins`}, ${won(0)}-${won(1)} in ${rec.result.rounds.length} rounds, ${(rec.ticks / 60).toFixed(1)} s`);
for (const r of rec.result.rounds) console.log(`  round: ${JSON.stringify(r)}`);
for (const s of [0, 1] as const) {
  const mine = rec.decisions.filter((d) => d.fighter === s);
  const lat = mine.filter((d) => d.answer).map((d) => d.latencyMs).sort((a, b) => a - b);
  const p = (q: number) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] ?? 0;
  console.log(`  ${rec.fighters[s].label}: ${mine.length} decisions, ${mine.filter((d) => d.fallback).length} fallbacks, latency p50 ${p(0.5)} ms, p90 ${p(0.9)} ms`);
}
console.log(`cost $${rec.costUsd.toFixed(4)}; wrote ${values.out} (${bytes.length} bytes)`);
