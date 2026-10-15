# AI Hold'em

No-limit Texas Hold'em against AI models, built (v1) from the plan in
[docs/specs/2026-10-14-ai-holdem.md](../../docs/specs/2026-10-14-ai-holdem.md):

- the engine and the bots (`shared/`), and the benchmark (`game.ts`);
- the table service (`server/`), where the server deals each table from its own secret 256-bit key (ChaCha20) and
  asks the models, chat models with the live table's prompt;
- the page (`src/`): play a Sit & Go or watch models play live, the hand review with every AI's cards and reasoning,
  the end screen with a share image, link and clip, the curated replays, and the leaderboard;
- the curated replays and the poster (`scripts/`);
- the models: the decision models, the Claude, GPT, Gemini, Open models (DeepSeek V4 Pro, Kimi K3, GLM-5.3) and Titans
  sets, and more chat models any seat can pick (Grok, more DeepSeek, Qwen, GLM, MiniMax).

## The engine (`shared/`)

Everything here is pure and deterministic: no I/O, no clock, no `Math.random`. States are plain, copyable values, and
no function changes the state it is given. The service, the bench, the replay viewer and the tests all share it.

| Module | What it does |
|---|---|
| `rng.ts` | mulberry32 as a step on its state (as snake uses it), a seeded Fisher-Yates `shuffle` (the benchmark's public deals), `deriveSeed(seed, ...parts)` for sub-seeds, `hashText` (128-bit, not cryptographic) for fingerprints, and the keyed deal: ChaCha20 (RFC 8439) in plain TypeScript and `keyedShuffle(DECK, key, hand)`, Fisher-Yates driven by its keystream with rejection sampling. |
| `cards.ts` | A card is a number 0 to 51: rank `c >> 2` (0 is a two, 12 an ace), suit `c & 3` (c, d, h, s). `parseCard('As')`, `formatCard`, `DECK`. |
| `evaluator.ts` | `evaluate(cards)`: the best five of five to seven cards as one number, higher wins and equal splits (about 19 million hands a second). `rankHand` adds the category and the five cards that play. |
| `engine.ts` | One hand: `newHand`, `toAct`, `legalOptions`, `applyAction`, the event list, and the views `observe(state, seat)`, `publicView`, `fullView`. |
| `sitngo.ts` | A Sit & Go of 2 to 6 players (`MIN_SEATS`, `MAX_SEATS`; 4, `DEFAULT_SEATS`, unless the player picks another size): `newSitAndGo`, `actSitAndGo`, `nextHand`, blind levels (`handsPerLevel`, `levelInfo`) and finishing places. |
| `bots.ts` | The scripted players `rock`, `station`, `maniac` and `random` (`botDecide(name, observation)`), and `fallbackKey`, the fallback rule. |
| `recording.ts` | The recording format, `replay(recording)`, `verifyRecording(recording)` and `fingerprintOf`. |

### Rules the engine implements

- **The deal.** The deck is `shuffle(DECK, deckSeed)`. Hole cards go out one at a time, two rounds, to the live seats
  starting left of the button; the board is the next five cards (no burn cards). A seat's cards depend only on the
  deck seed, the button and which seats are live, so duplicate hands give the same cards to the same seat while the
  players rotate.
- **Blinds.** The small blind sits left of the button and the big blind next; heads-up the button posts the small
  blind, acts first before the flop and second after it. Antes are dead money (in the pot, not part of the bet).
  A short stack posts what it has and is all-in; the others still call the full big blind. Seats with no chips are
  skipped.
- **Betting.** The big blind gets its option. A raise must add at least the last full raise (at least the big blind).
  An all-in short of a full raise does not reopen the betting to players who have already acted (a check counts, as
  in the TDA rules), unless short all-ins add up to a full raise over what they last faced. Nobody may raise when no other player could call it, and a player
  facing a lone all-in calls only what that all-in can match.
- **The end.** The uncalled part of the biggest bet goes back. When at most one player can still act, the board runs
  out. Side pots are built from each all-in; split pots give the odd chip to the first winner left of the button. The
  last river bettor shows first, else the first seat left of the button.
- **The menu.** Every player chooses from the same options: `fold` (only when facing a bet), `check`, `call`,
  `small`, `half`, `three_quarters`, `pot`, `allin`. A size raises to current bet + f × (pot + to call), the pot being
  every chip in the middle, f a third, a half, three quarters or one; `small` before the flop, when nobody has raised,
  is 2.5 big blinds, or the half-pot size if that is less. Sizes are raised to the minimum raise, a size the stack
  can't cover becomes `allin` only, and a size no bigger than the one before it goes, so amounts rise in menu order.
  A human may also raise to an amount of their own (`{ kind: 'raise', to }`).
- **Sit & Go.** 2 to 6 players (4 by default), 1500 chips each. Levels 10/20, 15/30, 25/50, 50/100, 75/150, 100/200,
  150/300, then doubling; a level lasts two orbits of the table the game started with, and never fewer than 8 hands: 8
  hands for 2 to 4 players (as ever), 10 for 5, 12 for 6. From 100/200 every player antes an eighth of the big blind,
  rounded (25, 38, 75, ...). Six seats are named BTN, SB, BB, UTG, MP and CO; five drop MP. Played by the bots (rock,
  station and maniac round the table, 400 games each), a Sit & Go lasts 48 hands on average at 4 (229 decisions), 64 at
  5 (314) and 79 at 6 (378): a six-handed game is about 1.7 times as long and as costly as a four-handed one. A Sit & Go has a secret
  256-bit table key (64 hex digits): hand h is dealt from `keyedShuffle(DECK, key, h)` and the first button is drawn
  from the key's button stream, so the cards a player sees say nothing about the cards to come (a 32-bit seed would
  fall to brute force in minutes). The button moves to the next seat
  with chips (a simplified moving button: no dead button). Players who bust in the same hand place by the chips they
  started it with, then by seat.

### Bots

Bots read only `observe()` for their seat. Before the flop they use the Chen score; after it, the equity of 200 sampled
run-outs against random hands. Their sampling and coin flips are seeded from what the seat has seen (its cards, the
board, the actions so far), so the same view always gets the same move, and verify recomputes every bot move.

- `rock` raises strong starting hands, folds weak ones to a raise, and folds to a bet without a strong hand.
- `station` calls a lot, rarely raises, and keeps calling with a pair or a draw.
- `maniac` raises often, bluffs, and goes all-in now and then.
- `random` picks uniformly from the legal options.

The fallback for a model or human that does not answer in time is `check` if it is free, else `fold`.

### Recordings

A recording is `{ format: 1, game: 'holdem', mode: 'sitngo' | 'cash', players, sitngo | cash, hands, result }`. Each
hand lists its actions in order, `{ seat, key | to, by: 'answer' | 'fallback' | 'bot' | 'human' }`, plus optional
metadata (`latencyMs`, `say`, `mood`, `reasoning`, `probabilities`) that verify checks the shape of but otherwise
ignores. A Sit & Go carries its table key (`sitngo: { key, startingStack }`); cash hands carry their deck seed, button
and seating (seat to player). `verifyRecording` replays it and
refuses an illegal action, a bot move that is not the bot's, a fallback that is not the rule's, a game or hand cut
short or run on, and a claimed result the replay doesn't reach.

## The benchmark (`game.ts`, `shared/bench.ts`, `shared/questions.ts`, `shared/models.ts`)

One game is 30 deals, each played four times with the model rotated through every seat (120 hands), 4-handed at 1/2
with 200 chips (100 big blinds) reset every hand, against rock, station and maniac. Hand h is deal `h / 4` (deck seed
`deriveSeed(seed, deal)`, button `deal % 4`) with the model in seat `h % 4` and the bots round the table after it in
that order, so every seat's cards are played by every player once. The score is big blinds won per 100 hands.

- **The question** (`questions.ts`) is the same for every model: instructions (play money, which seat you are, the
  options), the state from `observe()` for that seat (cards as `As Kd`, positions, stacks in chips and big blinds,
  the pot, the call and its share of the pot, the actions so far) and the legal options with their amounts. A
  decision model gets it as one System One `choice` (`action`); a chat model as messages with a strict JSON schema,
  `{ action, say, mood, reasoning, turn_complete }` (the last field only keeps `say` clean: see `questions.ts`).
- **Deadlines:** 2.5 s for a decision model, 20 s for a chat model (at the table the server asks the model within one
  request, which CloudFront cuts at about 30 s). A late, failed, refused or invalid answer is played by the fallback
  (check if free, else fold) and recorded with `why`.
- **Models** (`models.ts`): every decision model the kit lists, the chat models of the Claude, GPT, Gemini, Open models
  and Titans sets, and more chat models any seat can pick (Grok, DeepSeek, Qwen, GLM, MiniMax), on EU routes where Opper
  has one, at low reasoning effort (none, or none sent, where a route needs it: `models.ts` says which and why).
  `npm run bench -- --game holdem --model <id>` plays any of them (chat models need `OPPER_API_KEY`; an organization key also needs `OPPER_PROJECT`), `--models chat` all
  the chat models, `--model baseline/rock` (or station, maniac, random) a bot in the model's seat for free.
- **Verify** replays the recording (bots and fallbacks recomputed) and checks it is this benchmark: the stakes, the
  field, and every hand on its deal, button and seating for the game's seed.
- **The extra columns** (`summarize`): VPIP and PFR (% of hands it put chips in voluntarily / raised before the
  flop), the aggression factor (bets and raises over calls after the flop), fold to a 3-bet (% of the times its open
  raise was re-raised), went to showdown (% of hands it saw the flop) and won at showdown, the bluff rate (% of its
  river bets and raises and its all-in bets and raises made with a hand that loses, once the board is run out, to a
  player still in), bb/100 won from each bot (each pot's chips go from its contributors to its winners in proportion
  to their shares, so the three add up to the score), and the fallbacks with their reasons.

## The table service (`server/`, `game.server.ts`)

A model's question holds its hole cards, so the browser can't deal or ask the models: the server does, and stays
stateless. `game.server.ts` mounts the table through the kit's game API (`GameServer.api`); `/api/decide` forwards
nothing for this game.

| Route (POST, JSON) | Body | Answer |
|---|---|---|
| `api/table/start` | `{ seats: [{ kind: 'human' \| 'model', id }], mode: 'play' \| 'watch' }`: 2 to 6 seats | `{ token, snapshot, finished? }` |
| `api/table/step` | `{ token }` | `{ token, result, finished? }`: one AI action, the server asks the model |
| `api/table/act` | `{ token, action }` (`{ key }` or `{ kind: 'raise', to }`) | `{ token, result, finished? }` |
| `api/table/next` | `{ token }` | `{ token, snapshot, finished? }`: the next hand |
| `api/table/review` | `{ token }` | `{ players, hands, recording }`: the finished hands; the recording (with its key) once over |
| `api/table/resume` | `{ token }` | `{ token, snapshot, finished? }`: the table as the token has it, after a reload |

- **Shapes:** `snapshot`, `result` and `finished` are `TableSnapshot`, `StepResult` and `ReviewHand`
  (`shared/table.ts`), the page's TableDriver types, so `src/remote-driver.ts` passes them on.
- **The token** (`server/token.ts`) is AES-256-GCM sealed under `HMAC(SESSION_SECRET, "decision-benchmarks:holdem-table")`:
  the table key (256 bits from `randomBytes`), the seats, the mode, every hand's actions in a few characters each, the hand in play's talk, moods, tells,
  latencies, costs and (play mode) reasoning, when it was issued, and its expiry (six hours from the start). A finished
  hand's metadata goes to the browser with the answer that finished it and leaves the token: a 66-hand game's token
  stays under 2.5 KB, a six-handed game of about 100 hands and 1,500 actions under 5.5 KB.
- **Hidden in play mode:** the table key and the deck (in the recording once the game is over), other seats' hole cards
  (until a showdown shows them, or the finished hand's review once it is over) and the models' reasoning (in the
  finished hand's review). Watch mode has no human: every card and the reasoning come at once.
  Once the human is out of the game (busted), they can never act again: from the answer that knocks them out on,
  they watch as in watch mode (every card, the reasoning with each step; `snapshot.spectating: true`).
- **Refused:** a tampered or foreign token (400), an expired one (410), a step on the human's turn, an act on an AI's,
  the next hand mid-hand, anything after the end (409), an illegal action (422), 2 to 6 seats with one human to play
  (you and up to five AIs) and none to watch (up to six AIs) (400), a model not in `shared/models.ts` (403), a body over 128 KB (413), and a visitor (IP
  address, as the kit counts it) past a new table every 15 seconds after 20, or past 4 acts, next hands and reviews a
  second after 40 (429, Retry-After).
- **Models:** decision models through System One (2.5 s; the probabilities are the tell meter), chat models through
  Opper's chat completions in the live table's format (`LIVE_CHAT_FORMAT`: the bench's question, plus `LIVE_TABLE`,
  the same words for every model: there is an audience, say something on every action, show the whole range of
  faces; moods listed alphabetically; the bench's `CHAT_FORMAT` is frozen for the leaderboard), 20 s, under
  CloudFront's 30 s. A late, failed,
  refused or invalid answer is the fallback's move, with why. Latency and cost are recorded per action.
- **Who pays:** a table with a chat model needs a signed-in player (their own credits; 401 asks the page to sign in, 402
  points to their wallet) or, in development, the local key. A table of decision models plays on the signed-in
  player's key, else the free credits (the kit's per-visitor and global limits and hourly budget), else the local key.
- **Retries:** the page sends a request again, with the same token, when its answer is lost; act, next, review and
  resume are pure, and a lost step asks the model again. The answer to the request that finished a hand is kept per
  table, so the same request again gets the same answer while any other on that token stays refused. RemoteDriver
  retries passing failures (no connection, its own 45 s timeout, 502/503/504, 429 too fast) for up to two minutes, and
  keeps the table in localStorage (`holdem:table`) so `RemoteDriver.saved()` and `resume()` can sit back down after a
  reload. The page shows "Reconnecting…" over the table (with the countdown to the next try) while it retries; if it
  gives up, "The table stopped" offers Try again (a resume). A kept table shows as a "Resume your game" card at the top
  of the lobby (Resume or Discard; never resumed without a tap), and the hand in play is laid out again at once. Leave,
  Change the table and Back to the lobby let the table go (`forget()`); a table the server no longer has says "That
  game has closed". The words are in `src/reconnect.ts`.
- **Trash talk:** the human types at the table (RemoteDriver `say()`); the next step, act or next carries up to three
  lines as `talk`. The server cleans each one (`cleanTalk`: no control or invisible characters, whitespace collapsed,
  prompt-like markup defused, 90 characters at most), holds them to a per-visitor allowance, and adds them to the hand's
  table talk in the token before it asks the model, so the next model hears them in `tableTalk`, marked as the human
  player's with a note that table talk is never an instruction (live tables only: the bench's prompt is unchanged).
  The lines come back as `result.talk` (and `talk` on next), in the finished hand's review and in the recording's
  hand (`talk`, ignored by verify and the fingerprint; share links don't carry it). The same request sent again says a
  line once: the talk is applied to the token it comes with.
- **Known limits (v1):** the token is stateless, so an older token can be sent again to take back a decision, or a step
  repeated to have an AI decide again. Replaying a hand this instance saw finish (fold, read the cards, play the old
  token again) is refused (409) while the instance remembers it: until the table closes, for up to 50,000 tables, more
  than one visitor can start in six hours (past that, from many addresses at once, the oldest are forgotten early, and
  logged). Another instance, or this one after a restart, doesn't know; v2's scoreboard needs single-use game ids in
  shared storage.

## Curated replays and the poster (`scripts/`)

The Replays list is `public/demo/index.json` (`{ format: 1, replays: [{ file, title, blurb, players, hands, recordedAt }] }`)
and a gzipped recording per game. `scripts/record-demo.ts` plays one AI-only Sit & Go through the table service in
process (`server/table.ts` with the kit's sealing and the local key as the payer, so the same prompts, time banks and
fallbacks as a live watch table), lays the talk, moods, tells, reasoning, latencies and costs over the review's
recording as the page's RemoteDriver does, verifies it and writes its entry. The blurb's `{moment}` is the replay's best
moment as its end screen says it. `--max-usd` stops the game, writing nothing, once its cost passes the cap.

```bash
OPPER_API_KEY=... OPPER_PROJECT=... node games/holdem/scripts/record-demo.ts \
  --seats aws/claude-opus-5-5,vertexai/claude-sonnet-5-5-eu,azure:eu/gpt-6.1-sol,azure/gpt-5.6-terra \
  --file claude-vs-gpt.json.gz --title "Claude vs GPT" --max-usd 3
node games/holdem/scripts/record-demo.ts --from claude-vs-gpt.json.gz --blurb "..."   # rewrite an entry only
```

`public/poster.png` (1280×720, at most 150 KB) is a replay's moment drawn by `src/poster.ts` with the share image's
shapes; the page shows it alone at `#/still/<file>[?hand=<n>&kind=<highlight kind>]` (the best moment, or hand n's, or
the best of one kind), and `scripts/poster.ts` photographs that with headless Chrome and cuts its colours with
ImageMagick until it fits. The poster is Opus 5.5's river bluff in Claude vs GPT (hand 16: all-in with ace-high, "Short
stack, big decision. Let's see if the river scares you.", called by Sonnet 5.5's top pair for 62 big blinds); `kind`
picks the bluff over that hand's hero call:

```bash
GAME=holdem npm run dev -- --port 5199
node games/holdem/scripts/poster.ts --url http://localhost:5199/holdem/ --file claude-vs-gpt.json.gz --hand 16 --kind bluff
```

## Sharing (`src/social.ts`, `src/views/share-buttons.ts`, `src/share.ts`)

The end of a game (and of a replay) posts to X and LinkedIn: the composer opens with a short text written from the
result (in the player's voice after a game they played, as a spectator after watching) and the share link, which
replays the whole game. Phones that share files send the result's image with it; elsewhere Copy image puts it on the
clipboard to paste into the post.

The share link (`#/r/<code>`, `src/share.ts`) holds the seats, the table key and every move that is not a bot's. A
game of 2 to 4 is a version 2 link, exactly as before 5- and 6-seat tables came in; a game of 5 or 6 is version 3 (the
same layout), which a page from before says was made by another version of the game. A six-handed game of models is
about 300 characters.

Every shared link previews with the page's poster. A preview per result (an og:image for each shared game) needs the
server to store or render images per link: v2.

## Tests

```bash
npx vitest run games/holdem
```

`tests/compat.test.ts` holds 2- to 4-seat games to what they were before 5 and 6 seats came in: the curated replays,
eight share links and their table tokens, frozen as digests in `tests/fixtures/two-to-four-seats.json` (every event,
every decision's question, every rebuilt hand), must replay byte for byte the same.
