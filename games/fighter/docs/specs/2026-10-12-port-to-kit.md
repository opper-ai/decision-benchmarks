# Fighter: porting jev-fighter onto the kit (games/fighter)

jev-fighter (MIT, Jose Sabater) was subtree-added at games/fighter with its own harness, server, client and docs.
Port it onto the kit, keep what makes it good (the deterministic engine, the question design from
docs/specs/2026-10-06-v2-harness.md, baselines, replays, the stage renderer and sound), drop what conflicts with the
brief's rules for opper.ai.

## Keep
- shared/engine, shared/question.ts, shared/view.ts, shared/fallback.ts, shared/baselines.ts, shared/match.ts,
  shared/replay.ts (format may gain fields), the renderer, audio, input, the fight and replay views, stats views.
- Its tests (moved under the root vitest config).

## Change
- Model calls in the browser go through the kit's transport to `/api/decide` (pool, Login with Opper, signed
  answers). No API keys in the browser on opper.ai, no custom endpoints from the browser, no "Connect" panel with keys:
  everything on opper.ai shares an origin with the website and jevman. Custom endpoints and chat LLMs stay available
  in the bench (`--endpoint --format systemone|chat`).
- `game.server.ts` with a strict `decideRequest`: rebuild or validate the fighter question (the instructions are
  generated from the game state; options must be move ids; text sizes capped; at most 2 questions a call).
- Its own server (server/app.ts, store.ts, fighters.ts, session.ts) goes; the kit's service mounts the game.
  Replays are no longer stored on the server: Watch plays committed recordings in public/demo/ only. A finished
  live match can still be downloaded by the player (client-side), not uploaded.
- Model list from the kit (Opper route ids). Default opponent for Play: Clef (Kev is being sunset).
- `game.ts` (GameDefinition) for the bench and CI:
  - one "game" = one match of the model under test against one gauntlet baseline (greedy, payoff, maximin),
    paused mode, assisted track; `seedFor(i)` cycles opponent and side (i % 3 picks the baseline,
    floor(i / 3) % 2 the side) with a derived engine seed, so 102 official games = 17 seeds x 3 baselines x 2 sides
    (use officialGames 102, minGames 24 rounded to the cycle: 24 is fine as it is a multiple of 6).
  - score = round-win share in that match (draw = 0.5), so the entry's mean is the model's share of rounds won.
    metric: { name: 'Round-win share vs baselines', unit: '%', higherIsBetter: true } (store the score as a
    percentage 0..100 so the hub can print it with its unit).
  - verify: rebuild the match from seed, side and opponent; recompute every baseline move with our code (never read
    it from the recording); check every model move is legal and applied when the fighter became actionable (paused
    mode), that fallback moves equal the fallback rule, and the checkpoint hashes; recompute the score.
  - benchVersion 1 covers engine version, track, mode, gauntlet and question format.
- Bradley-Terry between models (shared/stats.ts) stays for the game's own page, from official model-vs-model
  matches only if we run them; not part of the contract.
- Human play: you vs a model at the keyboard (pool pays the model), as today. No high-score board in v1.

## Dependencies
- Drop puppeteer-core and the scripts that need it, and gen-audio (keep the generated audio files).
- mediabunny (video export): keep only if the export view stays; pin the exact version and note the review in
  CREDITS.md, else drop the export. Prefer keeping it: Felix is adding video export to jevman (PR #19).

## Files
- LICENSE (MIT, kept), CREDITS.md (original repo https://github.com/Jose-Sabater/jev-fighter, author Jose Sabater,
  what changed in the port), public/game.json (slug fighter, name "Jev Fighter" or a name of our own, tagline,
  category Fighting, author { github: 'Jose-Sabater', originalRepo }, license MIT, metric as above),
  public/poster.png (16:9, at most 150 KB, a frame from a real match), public/leaderboard.json (no entries until the
  official run), public/baselines.json (the baselines' own results, page only), example-endpoint.ts.
- README in games/fighter trimmed to the game: what it measures, the rules, the question, how to bench.

## As built (2026-10-12): choices the code forced

- **Seeds.** `seedFor(i) = i`, and `matchSpec(seed)` decodes it: `seed % 3` the baseline, `floor(seed / 3) % 2` the side,
  `floor(seed / 6)` the fight, whose engine seed is `engineSeedFor(k)` (a multiplicative hash, so neighbouring fights
  start differently). `play` gets only the seed, so the seed has to carry the opponent and the side.
- **One stepper for play and verify.** The kit's `verify` is synchronous and the live `Match` waits on a wall clock, so
  `shared/gauntlet.ts` has `PausedRun`: paused mode with no clock, one decision at a time. The bench plays a match with it
  (answers from the model's transport, raced against the deadline) and the verifier replays the recording with it
  (answers from the recording, baseline moves recomputed). A test pins it to `Match` in paused mode (same decisions,
  checkpoints and result).
- **Timing.** Deadline 5 s (`decisionTimeoutMs` and `callTimeoutMs`), one call in flight. Paused mode measures decisions,
  so the deadline only catches hung calls. Live play on the page caps it at 2.5 s, since the kit's server gives a model 2 s.
- **Verify as built.** The match is rebuilt from the seed; every baseline move is recomputed; every model decision must
  be made on the tick its fighter could act (asked, question and applied tick all equal), its move must be legal and
  among the moves offered from what the fighter saw, its latency between 0 and the deadline, an `illegal` fallback must
  carry an answer that really was not legal, and every fallback move must equal the fallback rule's move there. Then the
  baseline's decisions, the length, the checkpoint hashes and the rounds must equal the recording's, and the score is
  recomputed. The model's questions are not rebuilt (only its moves are checked), which halves the cost of a replay.
- **Fingerprint**: the seed and the model's (tick, move) list, so timings do not change it.
- **Recording**: the fighter's `Replay` plus `bench: { version, seed, side, opponent, model }`. `maxRecordingBytes` is
  2 MB gzipped; a real match is 30 to 70 KB gzipped (0.5 to 2.7 MB unpacked).
- **Result**: score with two decimals; `extra` holds `vsGreedy`, `vsPayoff`, `vsMaximin` (mean score per baseline) and
  `matchWinShare` (matches won, a draw counting half, in percent).
- **Kit change**: the kit's `GameDefinition.baselines` (from snake) takes a baseline with no `transport`: the game
  plays it itself, getting `model: 'baseline/<name>'` and a transport that throws if called. The fighter's baselines are
  that kind (they read the full fight state). The bench takes them with no key and no warm-up, and refuses to write them
  into the official `leaderboard.json` (they need `--out`). That is how `npm run bench -- --game fighter --model
  baseline/greedy` and `public/baselines.json` work.
- **baselines.json**: all five baselines (random, guard, greedy, payoff, maximin) as the player under test, 102 games each,
  in the leaderboard's shape (five bench runs, merged with the kit's `boardFor`). Self-play of a mirror match is exactly
  50%, as it should be. Results: maximin 71.2, greedy 54.2, payoff 24.5, guard 6.7, random 0.3.
- **decideRequest** (`shared/request.ts`): the instructions only depend on the track, the compact flag and the passivity
  rule, so they must equal one of those eight texts; assisted option texts must match the game's format (a regular
  expression), raw ones must equal the move's own description; option keys must be moves; the state may only hold the
  game's six lines; texts are capped (240 characters a state line, 160 an option); one or two questions with short
  names; the model must be listed (Jev by default). The fighter has no high scores, so it signs no answers.
- **Model list**: the kit's `DECISION_MODELS`; Laya keeps its compact questions through an id-to-context map. Chat LLMs
  left the picker (the bench's `--format chat` covers them).
- **Page**: one page in the layout every game page shares (Snake's, after jevman's): opper.ai's chrome, the hero, the
  stage playing a recording from `public/demo/index.json` with a chip per recording, one "Fight an AI" button that opens
  the picker, then the Leaderboard (the kit's shared table), Benchmark your model and Method sections. The fonts are
  self-hosted in `public/fonts/`. `#/watch/<demo>` picks a recording, `#/leaderboard` scrolls to the table, and
  `#/still/<demo>?t=<tick>` draws one frame alone, used for the poster. A played match lives in memory and can be
  replayed here or downloaded, never uploaded.
- **Poster**: tick 997 of the payoff-vs-greedy demo (the greedy baseline's special), from the still route in headless
  Chrome at 1280x720, quantized to 256 colours (100 KB).
- **Build and types**: the fighter's `tsconfig` settings (ES2023, `verbatimModuleSyntax`) moved to the root config, which
  the whole repository passes; `erasableSyntaxOnly` covers all of the fighter, so its constructor parameter properties
  (match, replay player, renderer, spring, timeline) became fields. mediabunny 1.61.3 is a pinned root dependency; the
  export view stays.
- **Speed**: the engine's state copy is hand-written instead of `structuredClone` (the same states and hashes, about
  twice as fast): an assisted question copies the state hundreds of times. A baseline match takes about a second.
- **Tests**: the old match tests share their two played matches (the same checks on a third of the matches); the server,
  connections and chat-adapter tests went with their code.
- **Not done here**: the official runs (paid; `leaderboard.json` has no entries until then) and one demo per model for
  Watch from them. Bradley-Terry ratings stay in `shared/stats.ts` for official model-vs-model matches, if we run them.
