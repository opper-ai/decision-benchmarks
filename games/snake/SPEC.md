# Snake: spec (games/snake)

Our own game (MIT, author opper-ai, category Arcade). The smallest game that proves every part of the kit: bench,
submissions, CI replay, play, watch, high scores, deploy.

## Rules (SNAKE_RULES, part of benchVersion 2)

- Board 16 x 16, walls around it (leaving the board = death), no inner walls in v1.
- Snake starts length 3 in the middle, heading right; one apple on the board at a time. Apple positions come from a
  seeded PRNG (mulberry32 or similar, documented), placed on a free cell; the sequence depends only on the seed and
  how many apples were eaten, so a replay with the same answers reproduces the game exactly.
- Each step the snake moves one cell: left / straight / right relative to its heading. Eating an apple grows it by 1.
- Death: wall, own body (moving into the cell the tail vacates this step is allowed), or starvation: 150 steps
  without an apple (so a looping model cannot stall forever).
- The game ends at death or after 1000 steps. Score = apples eaten.

## Questions (real-time mode, benchVersion 3)

One System One `choice` question per step, named `snake`. Its options are the directions the head can move, keyed by
absolute direction (`up`, `right`, `down`, `left`), without the reverse: always three.
- Full choice: every non-reverse direction is offered every step, including one into the wall or the body, and no
  move is ever played for the model. The answer's direction maps back to the engine's relative move with
  `moveToward(heading, direction)`, so recordings, verify, submissions and the player check keep `left`, `straight`,
  `right`.
- `state`: the board as rows of text (`#` wall, `H` head, `n` neck, the body cell joined to the head, `o` body, `t`
  tail, `A` apple, `.` empty) with the length, steps since the last apple, the step, and the apple's position in board
  directions ("3 up and 2 left of the head"). No heading field: with one in the state, models leaned on it and kept
  answering the current heading (straight on into the wall). The heading is the way from the neck to the head, which
  is how the service's request check reads it back.
- Instructions explain the rules once, with the board's legend, and say "Pick the direction the head moves next (it
  cannot reverse)." No relative wording (turn left, keep heading, ahead) anywhere.
- Option criteria state facts, never the answer, JevMan style: `Go up: Next cell: empty. Distance to the apple after
  the move: 5. Cells reachable from there: 40 (the snake is 4 long after the move).` A deadly move says plainly that it
  ends the game: `Go left: Next cell: the wall. The game ends.` No option is labelled "safe" or "best".
- The options' order is shuffled every step, deterministically from what the request shows (the step, the head and
  the apple, whose place comes from the seed), so the bench and the service's request check (`game.server.ts`, which
  rebuilds the request and compares it exactly) build the same question. The seed itself is
  not in the request, so the service could not use it.
- Keep a question under about 600 tokens.
- benchVersion 2 asked for `left`/`straight`/`right` in a fixed order with the apple placed relative to the heading;
  weaker models misread it (one answered `left` on almost every step, others walked straight into walls). Version 3
  changes only the wording and the clock.
- Clock: the game steps every 275 ms (`STEP_MS`, about 3.6 steps a second), the same speed for every model (and for
  you, when you play on the page). Each step gives the model 275 ms, plus any time left from the previous step: it is asked
  early, as soon as its answer for the coming step is in (the board after that step is then known), never more than
  one step ahead. An answer that is in by its step's tick moves the snake. If the tick comes first, the request is
  cancelled (AbortController), the fallback moves the snake, and the next question goes out at that tick. One request
  is in flight at a time (a cancelled one no longer counts), one question per step.
- Fallback (answer not in by the tick, error, invalid answer): `straight` if the next cell is not deadly, else the
  first non-deadly of left/right, else straight. It never steers toward the apple: the harness does not play well on
  the model's behalf. The score therefore reflects decision quality and speed together; the leaderboard shows the
  share of late steps and the mean latency next to it.
- Baselines answer at once, so they play on the same clock and never fall back.
- benchVersion 1 was paused (the game waited up to 2 s for each answer) and 2 stepped every 250 ms with the relative
  question; their results are not comparable and their submissions are refused.

## Baselines (free, `--model baseline/<name>`)

`baseline/random` (uniform over non-deadly moves), `baseline/greedy` (closest to the apple among non-deadly),
`baseline/flood` (greedy, but never into a region smaller than its length). Never on the official leaderboard, and not
shown on the game page (see "Official runs").

## Recording and verify

Recording: `{ format: 1, game: 'snake', benchVersion, seed, model, steps: [{ choice, source: 'model'|'fallback',
probabilities?, latencyMs?, sig? }], result }`. Verify replays the steps from the seed with our engine, checks each
step's choice is one of the three options and that a fallback step's choice equals what the fallback rule gives
(so a submitter cannot dress model moves up as fallbacks or vice versa), recomputes the score, and compares to the
claimed result. Fingerprint = hash of seed + choices. Official seeds: `seedFor(i)` fixed, 100 games.

A replay proves the moves and the score, not the timing: whether a step was answered in time is as the bench
recorded it. For our official runs we run the bench; for a submission CI can't prove the timing, which is why
submissions are labelled self-reported (as on JevMan).

## Page (games/snake/index.html, JevMan-style: dark, arcade, Opper chrome from the kit)

- Hero: the board playing the top model's recorded game (Watch = recordings only), model chips to switch recordings.
- Play: your own game (arrow keys / swipe) on the board, at the models' clock. At game over, your apples and where
  they would rank among the models' means; enter initials for the board. The seed for a high-score game is issued by
  the server (/api/snake/seed, signed), not chosen by the client.
- High scores: one board `classic` (your apples). Server replays your inputs from the issued seed.
- Leaderboard section: official + community rows from leaderboard.json/community.json, Run by column, =1 ties,
  "Benchmark your model" link to CONTRIBUTING.md.
- Must work at 390 px wide without horizontal scroll.

## Official runs

`npm run bench -- --game snake --leaderboard` plays 100 games per model on the fixed seeds. Until official runs are
published, leaderboard.json has no entries (a valid contract shape). The baselines' results go in a separate
public/baselines.json (same entry shape), which neither the game page nor the hub shows: the hub's model leaderboard
must never show a baseline as a model.

## As built (where the kit or the build changed this spec, and why)

- **Seed endpoint.** The seed comes from `GET <game>/api/seed` (`/decision-benchmarks/snake/api/seed`), not
  `/api/snake/seed`: every game is already mounted below its slug, so the kit gained one generic, opt-in route
  (`highScores.seeded: true`) instead of a route per game. It answers `{ seed, token }`; the token is
  `<seed>.<issued at>.<HMAC>` with a key per game (`HMAC(SESSION_SECRET, "decision-benchmarks:seeds:" + slug)`),
  stateless and good for an hour. The high-score check gets a verifier for it.
- **Player recording.** `{ format: 1, game: 'snake', seedToken, moves }`, `moves` one letter a step (`L`, `S`, `R`).
  The server replays them from the token's seed only; it also refuses a game sent sooner after the seed was issued
  than 80% of its steps take at 8 steps a second, so a game can't be computed and sent at once.
- **Play.** Your own game, on one board, at the models' clock (`STEP_MS`). The page first raced you against a model
  on a second board, at a speed you picked; Snake has no play-against angle (the two games never meet), so it now
  plays you alone and compares your apples with the models' means at game over. No model plays for a visitor, so
  playing needs no sign-in or credits. A click on the board or P pauses (a pause only adds time, so the check above
  still passes); a hidden tab pauses it too.
- **Benchmark recording.** As specified, plus `costUsd` per step (the leaderboard's cost column needs it) and
  `result: { score, steps, end }` (`end`: `wall`, `body`, `starved`, `steps` or `full`). A cancelled call's step
  records the time it had (from sending to the tick: 275 ms, or more when it was asked early), so mean latency counts
  a late step at that time, a lower bound of the model's real time. A step's `latencyMs` is always from its question
  being sent to its answer. Its cost is unknown (no answer came back to report it, though the provider may
  still bill it), so the bench counts it at the mean cost of that game's answered calls. The fingerprint is the SHA-256 of the seed and the
  moves.
- **Seeds and sizes.** `seedFor(i)` is `Math.imul(i + 1, 0x9e3779b1) >>> 1` (golden-ratio steps, 31 bits). A
  submission needs at least 24 games (100 to match ours), as on JevMan.
- **Baselines.** The kit gained `GameDefinition.baselines`: the bench plays `--model baseline/<name>` without a key
  and refuses to put a baseline on the official leaderboard or in a submission. `public/baselines.json` is written
  with `npm run bench -- --game snake --models baseline/random,baseline/greedy,baseline/flood --leaderboard --out
  games/snake/public/baselines.json`. The random baseline draws from a hash of the board, so it replays too.
- **Request check.** The service reads the board back from the request's state, rebuilds the request with our own
  wording, and refuses any body that differs from it in any way (fields, questions, text, key).
- **Page.** The page follows opper.ai's theme (light or dark, as JevMan does); the arcade cabinets are black in both.
  Watch has a chip for every ranked model, in leaderboard order, the top one playing first; each plays that
  model's official game whose apples are closest to its mean (on a tie, the lowest seed), gzipped as the bench wrote
  it (public/demo/<model>.json.gz, listed in src/recordings.ts). A model the leaderboard skips gets no chip. Before
  the official run Watch played the baselines' recordings; the page no longer shows the baselines at all. `community.json` is built from `submissions/` at build
  time, so the page copes with it missing. The leaderboard, Watch chips and HIGH SCORE follow jevman's: makers' marks, the
  players' top ten behind HIGH SCORE, and each recording's highlight (MP4, GIF) to save.
