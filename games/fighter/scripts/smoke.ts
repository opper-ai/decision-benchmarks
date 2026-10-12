import { answerComplete } from '../adapters/chat.ts';
import { adapterFor } from '../adapters/index.ts';
import { newGame, predictActionable, step } from '../shared/engine/engine.ts';
import { buildQuestion } from '../shared/question.ts';

const apiKey = process.env.OPPER_API_KEY;
if (!apiKey) throw new Error('Set OPPER_API_KEY');
const models = process.argv.slice(2).length ? process.argv.slice(2) : ['typesafe/jev-1.13.0', 'sference/clef', 'gemini/gemini-3.5-flash-lite'];

const s = newGame(3);
while (s.round.phase !== 'fight') step(s);
s.fighters[0].x = 4300;
s.fighters[1].x = 5500;
step(s, [null, 'high_kick']);
for (let t = 0; t < 8; t++) step(s);
const q = buildQuestion(predictActionable(s, 0)!.state, 0);

for (const id of models) {
  const a = adapterFor(id, { apiKey, baseUrl: process.env.OPPER_BASE_URL });
  try {
    const w0 = performance.now();
    await a.warmUp();
    const warm = Math.round(performance.now() - w0);
    const lat: number[] = [];
    let last;
    for (let k = 0; k < 3; k++) {
      last = await a.decide(q, AbortSignal.timeout(10_000));
      lat.push(last.latencyMs);
      await answerComplete(last);
    }
    const top = Object.entries(last!.probabilities ?? {}).sort((x, y) => y[1]! - x[1]!).slice(0, 3).map(([m, p]) => `${m} ${p!.toFixed(2)}`);
    console.log(`${id}: warm ${warm}ms, latency ${lat.join('/')}ms, move ${last!.move}, top ${top.join(', ')}, cost ${last!.costUsd}, tokens ${last!.inputTokens}`);
  } catch (e) {
    console.log(`${id}: FAILED ${(e as Error).message}`);
  }
}
