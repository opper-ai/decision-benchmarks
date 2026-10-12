// A minimal fighter endpoint for bench --endpoint, to copy and put your own model behind. No dependencies.
// Run: node games/fighter/example-endpoint.ts [port]   (default 8787)
// Then: npm run bench -- --game fighter --endpoint http://localhost:8787 --games 6
//
// Every decision is one POST with the request the game sends System One:
//
//   { "state": { "you": "100 HP, meter 0, standing, free to act, 4.0 from your wall", "opponent": "...",
//                "distance": "1.1", "time": "round 1, 52 s left, rounds won 0-0", "recent": "..." },
//     "questions": { "move": { "type": "choice", "instructions": "You control one fighter in a 2D fighting game. ...",
//                              "criteria": { "jab": "avg +1.2, worst -12 (if uppercut); adv -3f", "block_low": "...", ... } } } }
//
// Answer with one of the criteria keys, and if you can, a probability for each:
//
//   { "answers": { "move": { "type": "choice", "choice": "jab", "probabilities": { "jab": 0.6, "block_low": 0.3, ... } } } }
//
// The benchmark plays the assisted track, so each option shows its payoffs: avg (the typical HP swing), worst (if the
// opponent makes its best answer, named) and sometimes usual (if it repeats its usual attack), plus adv (frames ahead or
// behind when the exchange ends). This "model" weighs the average against the worst case.
import { createServer } from 'node:http';

interface Question {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

/** How much the worst case counts against the average: 0 plays greedy, 1 plays it safe. */
const CAUTION = 0.5;

function score(facts: string): number {
  const num = (label: string) => Number(new RegExp(`${label} ([+-]?\\d+(?:\\.\\d+)?)`).exec(facts)?.[1] ?? 0);
  return num('avg') + CAUTION * num('worst');
}

function answer(q: Question) {
  const scored = Object.entries(q.criteria).map(([id, facts]) => [id, score(facts)] as const);
  // Softmax, so the probabilities say how sure it is.
  const best = Math.max(...scored.map(([, s]) => s));
  const weights = scored.map(([id, s]) => [id, Math.exp((s - best) / 3)] as const);
  const total = weights.reduce((a, [, w]) => a + w, 0);
  const probabilities = Object.fromEntries(weights.map(([id, w]) => [id, Math.round((w / total) * 1000) / 1000]));
  const choice = scored.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  return { type: 'choice', choice, probabilities };
}

const port = Number(process.argv[2] ?? 8787);
createServer((req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk));
  req.on('end', () => {
    try {
      const { questions } = JSON.parse(body) as { questions: Record<string, Question> };
      // Answer every question asked (a decision asks "move"; the bench's warm-up asks "warmup").
      const answers = Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, answer(q)]));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ answers }));
    } catch {
      res.writeHead(400).end();
    }
  });
}).listen(port, () => console.log(`example fighter endpoint on http://localhost:${port}`));
