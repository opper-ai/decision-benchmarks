# Contributing

Issues and pull requests are welcome. Before opening a pull request, run `npm run typecheck` and `npm test`.

Want a game hosted here? Open a [Suggest a game](https://github.com/opper-ai/decision-benchmarks/issues/new?template=suggest-a-game.yml)
issue. We port and review every game ourselves: only our own code runs on opper.ai. Building one? The
[decision-models guide](https://github.com/opper-ai/opper-skills/tree/main/guides/decision-models) is what we learned
making these games, written for coding agents: what makes a game measurable (seeds, a score, a weak fallback,
baselines) and how to write questions models play well.

## Benchmark your own model

Every game here has a leaderboard with two parts:

- **Our runs.** We play every decision model Opper serves ourselves. If your model is on Opper, it gets run when it
  lands in [`packages/kit/shared/models.ts`](packages/kit/shared/models.ts).
- **Self-reported.** Any other model, private or local included: you run the bench yourself and send the games in a
  pull request. CI replays every game with our code and recomputes its score, and the leaderboard lists your model as
  **self-reported**.

### 1. Put your model behind an HTTP endpoint

At every decision the bench POSTs the game's question, the same JSON the game sends Opper's System One API:

```json
{
  "state": { "…": "…" },
  "questions": {
    "<name>": { "type": "choice", "instructions": "…", "criteria": { "<option>": "what choosing it means", "…": "…" } }
  }
}
```

Answer each question with one of its `criteria` keys:

```json
{ "answers": { "<name>": { "type": "choice", "choice": "<option>", "probabilities": { "<option>": 0.7 } } } }
```

`probabilities` and `confidence` are optional, and so are `usage` (`{ "input_tokens": 812, "output_tokens": 4 }`)
and `costUsd` (what the call cost; the leaderboard shows it per game). Each game has an example endpoint to copy, e.g.
[`games/snake/example-endpoint.ts`](games/snake/example-endpoint.ts). If yours needs a key, set
`BENCH_ENDPOINT_TOKEN`: the bench sends it as a bearer token.

A chat model works too: `--format chat --endpoint <chat completions URL> --chat-model <name>` asks it each question
through a JSON schema that forces a choice and probabilities (its rows say "chat model via adapter").

An answer that comes later than the game allows is replaced by the game's own simple rule (a fallback).

### 2. Try it

```bash
npm ci --ignore-scripts
node games/snake/example-endpoint.ts    # or start your own endpoint; leave it running
```

Then, in a second terminal:

```bash
npm run bench -- --game snake --endpoint http://localhost:8787 --games 2
```

The bench prints each model's mean with a margin of two standard errors (`±`): about the range the mean would land
in on another run. The leaderboard files store one standard error, and the pages show the same two-error margin.

### 3. Record the submission

```bash
npm run bench -- --game <slug> --endpoint http://localhost:8787 --submit games/<slug>/submissions/my-model \
  --name "My Model" --by your-github-handle --url https://example.com/my-model
```

This plays the game's minimum number of games for a submission (24 for snake and fighter; 100 to match our runs: add
`--games 100`), on the
game's fixed seeds, so every model faces the same games. It writes `games/<slug>/submissions/my-model/`, holding
`submission.json` and one `game-NN.json.gz` per game. The folder name is your model's id: lowercase letters, digits
and dashes.

Check it the way CI will:

```bash
npm run submissions -- --game <slug>
```

### 4. Open a pull request

Commit the folder and open a pull request. CI replays every game and refuses the submission if any game breaks a
rule or doesn't replay to its recorded result. Once it's merged, your model shows up on the game's leaderboard.

### What "self-reported" means

Every game here is deterministic, so CI replays your recorded moves with our code and recomputes every score itself.
A submission can't claim more than its moves earned, play other seeds than the fixed ones, send the same game
twice (in one submission or across submissions), or take the name of a model on the official leaderboard.

What a replay can't check: that your model made those moves, how fast it really answered, how often it fell back,
what it cost, and that you didn't play more runs and keep the best one. Those are as you report them, which is why
the leaderboard marks these entries. Please submit every game of the run.

In a real-time game (JevMan, Snake, Jev Fighter) timing is part of the score: a step the model is too late for is
played by the game's fallback, and in Jev Fighter an answer plays on the frame it arrived (the fighter stands still
until then). A replay checks that every step marked as the fallback's is the fallback's move, and every move is legal
where it was played, but not that the model really was late (or in time) on it, so a real-time submission's timing
is as reported too. Play a real-time game one game at a time (`--parallel 1`) so its calls don't slow each other.

When a game's rules or questions change, its `benchVersion` (in `games/<slug>/game.ts`) goes up. Older submissions
then drop off its leaderboard until they're re-run.
