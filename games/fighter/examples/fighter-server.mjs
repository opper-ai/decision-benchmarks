// A fighter you can run and change: a tiny server that speaks the System One format.
//
//   node examples/fighter-server.mjs          # listens on http://localhost:8000
//
// Then add it as a fighter: in the app, Connect > Add an endpoint (base URL http://localhost:8000,
// format System One, any model id), or in fighters.json (see fighters.example.json, "my-bot").
//
// Every decision is one POST to /v1/systemone:
//
//   { "model": "...", "state": { "you": "...", "opponent": "...", "distance": "...", ... },
//     "questions": { "move": { "type": "choice", "instructions": "...",
//                              "criteria": { "jab": "avg +4, worst -12 (if uppercut); adv -3f", ... } } } }
//
// and the answer names one of the criteria keys, optionally with a probability for each:
//
//   { "answers": { "move": { "choice": "jab", "probabilities": { "jab": 0.6, ... } } } }
//
// This one reads the assisted track's payoff numbers and weighs the average against the worst case.
// On the raw track there are no payoffs, so it picks the option with the most damage. No dependencies.
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8000);
/** How much the worst case counts against the average: 0 is greedy, 1 is cautious. */
const CAUTION = 0.5;

const num = (text, label) => {
  const m = new RegExp(`${label} ([+-]?\\d+(?:\\.\\d+)?)`).exec(text);
  return m ? Number(m[1]) : null;
};

function score(facts) {
  const avg = num(facts, 'avg');
  const worst = num(facts, 'worst');
  if (avg !== null) return avg + CAUTION * (worst ?? avg);
  // Raw track: "high, 9 dmg, startup 6f, ..." Prefer damage, then speed.
  const dmg = Number(/(\d+) dmg/.exec(facts)?.[1] ?? 0);
  const startup = Number(/startup (\d+)f/.exec(facts)?.[1] ?? 20);
  return dmg - startup / 10;
}

function answer(question) {
  const options = Object.entries(question.criteria ?? {});
  const scored = options.map(([id, facts]) => [id, score(String(facts))]);
  // Softmax, so the probabilities say how sure it is.
  const max = Math.max(...scored.map(([, s]) => s));
  const weights = scored.map(([id, s]) => [id, Math.exp((s - max) / 3)]);
  const total = weights.reduce((a, [, w]) => a + w, 0);
  const probabilities = Object.fromEntries(weights.map(([id, w]) => [id, Math.round((w / total) * 1000) / 1000]));
  const choice = scored.reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0];
  return { type: 'choice', choice, probabilities };
}

createServer(async (req, res) => {
  // Browsers call endpoints straight from the page, so allow it (CORS).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Opper-Name');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  if (req.method !== 'POST' || !req.url?.endsWith('/v1/systemone')) return res.writeHead(404).end();
  let body = '';
  for await (const chunk of req) body += chunk;
  const { questions = {} } = JSON.parse(body || '{}');
  // Answer every question asked (a decision asks "move"; the warm-up asks "warmup").
  const answers = Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, answer(q)]));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ answers }));
}).listen(PORT, () => console.log(`fighter on http://localhost:${PORT}/v1/systemone`));
