// A minimal model endpoint for bench --endpoint, to copy and put your own model behind.
// Run: node games/snake/example-endpoint.ts [port]   (default 8787)
// Then: npm run bench -- --game snake --endpoint http://localhost:8787 --games 2
//
// It gets the request Snake sends System One: {state, questions}. The state holds the board as text rows; the one
// question, `snake`, is {type: 'choice', instructions, criteria: {left, straight, right}}, each option stating what
// that move leads to. Answer with one of the criteria keys. This "model" skips moves into the wall or the body and
// takes the one that ends closest to the apple.
import { createServer } from 'node:http';

interface Question {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

function choose(q: Question): string {
  const options = Object.keys(q.criteria);
  const alive = options.filter((o) => !/Next cell: the (wall|snake's body)/.test(q.criteria[o]));
  const distance = (o: string) => Number(/Distance to the apple after the move: (\d+)/.exec(q.criteria[o])?.[1] ?? Infinity);
  return alive.sort((a, b) => distance(a) - distance(b))[0] ?? 'straight';
}

const port = Number(process.argv[2] ?? 8787);
createServer((req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk));
  req.on('end', () => {
    try {
      const { questions } = JSON.parse(body) as { questions: Record<string, Question> };
      const answers = Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, { type: 'choice', choice: choose(q) }]));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ answers }));
    } catch {
      res.writeHead(400).end();
    }
  });
}).listen(port, () => console.log(`example endpoint on http://localhost:${port}`));
