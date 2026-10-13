# Snake

Which AI decision model plays Snake best? Every model plays 100 seeded games in real time, a step every 275 ms,
and the leaderboard ranks them by the apples they eat. Live at
[opper.ai/decision-benchmarks/snake](https://opper.ai/decision-benchmarks/snake/), where you can watch the recorded
games or race a model on the same board.

## What it measures

Steering a snake is a long chain of small decisions where a greedy move now can trap you later. A model has to read a
board, take the facts it is given about each move, and trade the short way to the apple against keeping room to move.
The score is the apples eaten, averaged over 100 fixed seeds; models within each other's margin of error (two standard
errors) are tied.

## Rules

- A 16 by 16 board with walls around it. The snake starts 3 long in the middle, heading right; one apple is on the
  board at a time.
- Apples come from mulberry32 seeded with the game's seed, each on a free cell (counted row by row from the top left).
  The sequence depends only on the seed and the apples eaten, so the same moves always replay the same game.
- Each step the snake turns left, goes straight or turns right, and moves one cell. An apple makes it one longer.
- The game ends when the head leaves the board or runs into the snake (the cell the tail leaves that step is free),
  after 150 steps without an apple, or after 1000 steps. Score = apples eaten.

Full rules, and the reasons behind them: [SPEC.md](SPEC.md).

## The question

Every step the game asks one System One `choice` question, named `snake`, whose options are the three directions the
head can move (`up`, `right`, `down`, `left`, without the reverse), in an order shuffled every step. Every one is
offered, a move into the wall or the body too: the model always has the full choice. The state is the board as text
rows (`#` wall, `H` head, `n` neck, the body cell joined to the head, `o` body, `t` tail, `A` apple, `.` empty), the
length, the steps since the last apple, the step number, and where the apple is from the head ("3 up and 2 left of the head"). Each option states facts
only: what is in the next cell, the distance to the apple after the move, and how many cells the snake could still
reach from there ("Go up: Next cell: empty. Distance to the apple after the move: 5. ..."); a deadly one says so
("Go left: Next cell: the wall. The game ends."). None is labelled safe or best. The answer's direction is played as
the turn it makes, so recordings keep left, straight and right.

The game runs in real time on a fixed clock: the snake steps every 275 ms (about 3.6 steps a second), the same speed
for every model. One request is in flight at a time, and the model is asked early: as soon as its answer for the
coming step is in, the board after that step is known, so the question for the next step goes out at once. Each step
gives the model 275 ms, plus any time left from the previous step. If the tick comes before the answer, the request is
cancelled and the step is late, and the next question goes out at that tick; an error or an answer that isn't an
option makes a late step too. On a late step the fallback moves straight unless that is deadly, else the first of left
and right that isn't, else straight. It never steers toward the apple. So the score reflects decision quality and
speed together; the leaderboard also shows each model's share of late steps and its mean latency.

## Benchmark your model

The full guide is [CONTRIBUTING.md](../../CONTRIBUTING.md). In short:

```bash
npm ci --ignore-scripts
node games/snake/example-endpoint.ts      # or your own model behind an HTTP endpoint
npm run bench -- --game snake --endpoint http://localhost:8787 --games 2
npm run bench -- --game snake --endpoint http://localhost:8787 --games 100 \
  --submit games/snake/submissions/my-model --name "My Model" --by your-github-handle
npm run submissions -- --game snake       # the check CI runs
```

Then open a pull request with the `games/snake/submissions/my-model/` folder. CI replays every game from its seed and
recomputes its score; a move marked as the fallback's must be the move the fallback makes there. CI can't prove the
timing of a game you played yourself (which steps your model answered in time), so these rows are marked
self-reported.

The free baselines play without a key: `npm run bench -- --game snake --model baseline/greedy` (also
`baseline/random` and `baseline/flood`). Their 100-game results are in `public/baselines.json`, shown on the page for
reference and never on the leaderboard.

## Files

- `game.ts`: the bench and replay side (`GameDefinition`); `game.server.ts`: the service side (request check, high
  scores on seeds the server issues)
- `shared/`: the engine, the question, the real-time play loop (`play.ts`, which the race on the page also uses), the
  baselines, the recording and the high-score check
- `bench/verify.ts`: the replay the submissions check runs
- `src/`, `index.html`: the page
- `public/`: `game.json`, `poster.png` (rendered by `node games/snake/scripts/poster.ts`), `leaderboard.json` (official
  runs), `baselines.json`, `demo/` (the recordings Watch plays)

## License

MIT (see [LICENSE](LICENSE)). Credits: [CREDITS.md](CREDITS.md).
