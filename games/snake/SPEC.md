# Snake: spec (games/snake)

Our own game (MIT, author opper-ai, category Arcade). The smallest game that proves every part of the kit: bench,
submissions, CI replay, play, watch, high scores, deploy.

## Rules (SNAKE_RULES, part of benchVersion 1)

- Board 16 x 16, walls around it (leaving the board = death), no inner walls in v1.
- Snake starts length 3 in the middle, heading right; one apple on the board at a time. Apple positions come from a
  seeded PRNG (mulberry32 or similar, documented), placed on a free cell; the sequence depends only on the seed and
  how many apples were eaten, so a replay with the same answers reproduces the game exactly.
- Each step the snake moves one cell: left / straight / right relative to its heading. Eating an apple grows it by 1.
- Death: wall, own body (moving into the cell the tail vacates this step is allowed), or starvation: 150 steps
  without an apple (so a looping model cannot stall forever).
- The game ends at death or after 1000 steps. Score = apples eaten.

## Questions (paused mode)

One System One `choice` question per step, named `snake`, options `left`, `straight`, `right`.
- `state`: the board as rows of text (`#` wall, `H` head, `o` body, `t` tail, `A` apple, `.` empty) with the
  heading, length, steps since the last apple, and the apple's position relative to the head.
- Option criteria state facts, never the answer: what is in the next cell (empty, apple, wall, body), the Manhattan
  distance to the apple after the move, and how many cells the snake could still reach from there (flood fill),
  WITHOUT labelling any option "safe" or "best". Instructions explain the rules once.
- Keep a question under about 600 tokens. Order of options fixed (left, straight, right).
- Fallback (timeout 2 s from send, error, invalid answer): `straight` if the next cell is not deadly, else the first
  non-deadly of left/right, else straight. It never steers toward the apple: the harness does not play well on the
  model's behalf.

## Baselines (free, `--model baseline/<name>`)

`baseline/random` (uniform over non-deadly moves), `baseline/greedy` (closest to the apple among non-deadly),
`baseline/flood` (greedy, but never into a region smaller than its length). Shown on the game page for reference, not
on the official leaderboard.

## Recording and verify

Recording: `{ format: 1, game: 'snake', benchVersion, seed, model, steps: [{ choice, source: 'model'|'fallback',
probabilities?, latencyMs?, sig? }], result }`. Verify replays the steps from the seed with our engine, checks each
step's choice is one of the three options and that a fallback step's choice equals what the fallback rule gives
(so a submitter cannot dress model moves up as fallbacks or vice versa), recomputes the score, and compares to the
claimed result. Fingerprint = hash of seed + choices. Official seeds: `seedFor(i)` fixed, 100 games.

## Page (games/snake/index.html, jevman-style: dark, arcade, Opper chrome from the kit)

- Hero: the board playing the top model's recorded game (Watch = recordings only), model chips to switch recordings.
- Play: you (arrow keys / swipe) on the left board, a model of your choice on the right board, same seed; both start
  together; the model board advances whenever its answer arrives (paused per step, a step at most every 120 ms so it
  is watchable). Your board ticks at 8 steps/s. When both are over, show both scores; enter initials for the board.
  The seed for a high-score game is issued by the server (/api/snake/seed, signed), not chosen by the client.
- High scores: one board `classic` (your apples). Server replays your inputs from the issued seed.
- Leaderboard section: official + community rows from leaderboard.json/community.json, Run by column, =1 ties,
  "Benchmark your model" link to CONTRIBUTING.md.
- Must work at 390 px wide without horizontal scroll.

## Official runs

`npm run bench -- --game snake --leaderboard` plays 100 games per model on the fixed seeds. Not run in this phase
(paid). Commit leaderboard.json with no entries (valid contract shape) and the baselines' results in a separate
public/baselines.json (same entry shape) that only the game page reads: the hub's model leaderboard must never show
a baseline as a model.

## As built (where the kit or the build changed this spec, and why)

- **Seed endpoint.** The seed comes from `GET <game>/api/seed` (`/decision-benchmarks/snake/api/seed`), not
  `/api/snake/seed`: every game is already mounted below its slug, so the kit gained one generic, opt-in route
  (`highScores.seeded: true`) instead of a route per game. It answers `{ seed, token }`; the token is
  `<seed>.<issued at>.<HMAC>` with a key per game (`HMAC(SESSION_SECRET, "decision-benchmarks:seeds:" + slug)`),
  stateless and good for an hour. The high-score check gets a verifier for it.
- **Player recording.** `{ format: 1, game: 'snake', seedToken, moves }`, `moves` one letter a step (`L`, `S`, `R`).
  The server replays them from the token's seed only; it also refuses a game sent sooner after the seed was issued
  than 80% of its steps take at 8 steps a second, so a game can't be computed and sent at once.
- **Benchmark recording.** As specified, plus `costUsd` per step (the leaderboard's cost column needs it) and
  `result: { score, steps, end }` (`end`: `wall`, `body`, `starved`, `steps` or `full`). A late answer's latency and
  cost are kept on its step, as the kit's scheduler reports them. The fingerprint is the SHA-256 of the seed and the
  moves.
- **Seeds and sizes.** `seedFor(i)` is `Math.imul(i + 1, 0x9e3779b1) >>> 1` (golden-ratio steps, 31 bits). A
  submission needs at least 24 games (100 to match ours), as on jevman.
- **Baselines.** The kit gained `GameDefinition.baselines`: the bench plays `--model baseline/<name>` without a key
  and refuses to put a baseline on the official leaderboard or in a submission. `public/baselines.json` is written
  with `npm run bench -- --game snake --models baseline/random,baseline/greedy,baseline/flood --leaderboard --out
  games/snake/public/baselines.json`. The random baseline draws from a hash of the board, so it replays too.
- **Request check.** The service reads the board back from the request's state, rebuilds the request with our own
  wording, and refuses any body that differs from it in any way (fields, questions, text, key).
- **Page.** The page follows opper.ai's theme (light or dark, as jevman does); the arcade cabinets are black in both.
  Until the official run, Watch plays the baselines' recordings (the top one first), and the leaderboard shows the
  baselines in a group of their own below an empty ranking. `community.json` is built from `submissions/` at build
  time, so the page copes with it missing. Play shows every decision model; signed out with no free credits, they are
  greyed out with a note to sign in, and the baselines (run in the browser, free) can still be raced.
