# decision-benchmarks: design

Date: 2026-10-12. Implements the dev side of Felix's brief "Decision Benchmarks: how it works" (2026-10-11).
This repo started from opper-ai/jevman-benchmark's history (the kit is extracted from it); jev-fighter's history
was added under `games/fighter` with `git subtree`. Reviewed once by a fresh reader before building; the decisions
below include that review.

## Layout

```
packages/kit/
  shared/      isomorphic: System One types and answer parsing, the model list (from Opper's models API, with a
               checked-in snapshot), stats (mean, std error, tooCloseToCall, ranks with ties), the hub contract
               types (contract.ts), the answer-signature message, the GameDefinition / GameServer types
  client/      browser: transport to /api/decide, warm-up, Login with Opper client, high-score client, base paths,
               the generic scheduler (real time with ask-ahead, or paused), shared page chrome
  server/      node: one HTTP service that mounts every game at <APP_BASE_PATH>/<slug>/
               (static files, /api/decide, /api/warm, /api/me, /auth/*, /api/highscores; /health at the root),
               the free-credit pool and ONE visitor limiter shared by every game, sessions, S3 high scores
  bench/       node: the bench CLI (--game --model(s) --endpoint --format systemone|chat --games --seed --submit
               --name --by), official runs -> leaderboard.json, submissions -> community.json
games/
  registry.ts           the games the service, bench and build serve: jevman, snake, fighter
  <slug>/
    game.ts             GameDefinition: bench and verify side
    game.server.ts      GameServer: what the service needs (Node-safe imports only)
    src/  index.html  tests/  LICENSE  CREDITS.md
    public/             game.json, poster.png, demo/, leaderboard.json, community.json
    submissions/<id>/   submission.json + game-NN.json.gz
  jevman/               jevman's game (Pac-Man) ported onto the kit, served at <APP_BASE_PATH>/jevman/
server/main.ts          the service with every registry game
scripts/                bench.ts, submissions.ts, build.ts, check-contract.ts (thin entry points)
```

One root `package.json` (no workspaces), relative imports with `.ts` extensions. Everything the server or the
scripts reach is erasable TypeScript only (`erasableSyntaxOnly`: no parameter properties, enums, namespaces), so
Node runs it as is; a test imports every registry game's server module under plain Node. One Vite config run per
game (`GAME=<slug>`): `root: games/<slug>`, `publicDir: games/<slug>/public`, `outDir: dist/<slug>`,
`base: <APP_BASE_PATH>/<slug>/`. One root vitest config over `packages/**/tests` and `games/*/tests`.

## What a game gives the kit

```ts
// packages/kit/shared/game.ts
interface GameResult { score: number; calls: number; decisions: number; fallbacks: number; latencyMsSum: number; cost: number }
type Verdict<R> = { ok: true; result: R; fingerprint: string } | { ok: false; error: string };

interface GameDefinition<Rec extends { format: number }, R extends GameResult = GameResult> {
  slug: string;
  benchVersion: number;                       // bump when rules or questions change; older submissions are refused
  mode: 'realtime' | 'paused';
  timing: { decisionTimeoutMs: number; callTimeoutMs: number; maxInFlight: number };
  rules: { minGames: number; officialGames: number; seedFor(i: number): number; maxRecordingBytes: number };
  metric: { name: string; unit: string; higherIsBetter: boolean };
  play(o: { transport: Transport; seed: number; signal: AbortSignal }): Promise<{ result: R; recording: Rec }>;
  verify(rec: unknown, o: { seed: number }): Verdict<R>;   // recomputes the score with our code
  summarize?(results: R[]): Record<string, number | string>; // -> entry.extra
}

// games/<slug>/game.server.ts
interface GameServer {
  slug: string;
  /** Required: the pool only pays for requests this game sends. Rebuild or strictly validate the request. */
  decideRequest(body: unknown): { ok: true; request: SystemOneRequest; keys?: Record<string, string> } | { ok: false; error: string };
  highScores?: {
    boards: readonly { id: string; label: string }[];        // order matters: the hub shows the first board's top
    check(rec: unknown, verify: AnswerVerifier): { ok: true; score: number; board: string } | { ok: false; error: string };
  };
}
```

Answer signatures use a key per game: `HMAC(SESSION_SECRET, "decision-benchmarks:answers:" + slug)`, so an answer
signed for one game never verifies in another. Warm-up lives in the kit (bench and client), not in games.

## The contract with the hub (opper-website)

Below `https://opper.ai/decision-benchmarks/<slug>/`:

| File | Shape |
|---|---|
| `game.json` | `{ slug, name, tagline, category: 'Arcade'\|'Puzzle'\|'Fighting'\|'Strategy', author: { github, originalRepo? }, license, metric: { name, unit, higherIsBetter }, updatedAt }`. Our own games have `author.github: "opper-ai"` and no `originalRepo`. `updatedAt` is set at build time from the newest results file. |
| `leaderboard.json` | `{ generatedAt, game, benchVersion, metric, entries: Entry[], skipped }`. `Entry = { model, name, games, metric: { mean, stdError, best }, meanLatencyMs: number\|null, fallbackRate, costPerGame: number\|null, via: 'systemone'\|'chat-adapter', extra? }`, best first. |
| `community.json` | the same, entries plus `by, url?, selfReported: true` |
| `api/highscores` | `{ order: string[], boards: { <board>: [{ initials, score, at }] } }`; 404 for a game without high scores |
| `poster.png` | 16:9, at most 150 KB |

The top-level `metric` defines the measure; an entry's `metric` holds its values. `model` is the Opper id the run
called, as the brief says for jevman's `opper` field (`typesafe/jev-1.13.0`, `sference/clef`,
`azure:global/microsoft-decision-1`): one route per model for official runs. To confirm with Felix: the hub matches it
against the catalogue. Types: `packages/kit/shared/contract.ts`; `npm run check-contract` validates every game's
files and runs in CI.

## Service

One Node process, one image, one ECS service. Mounted in two levels (`APP_BASE_PATH`, then the slug): the bare
`/<slug>` redirects to `/<slug>/`, unknown slugs are 404, static files never cross between games. Shared: the pool
key (`OPPER_POOL_API_KEY`) and one visitor limiter, one OAuth app (`OPPER_CLIENT_ID/SECRET`; a redirect URI per
game: `<origin>/decision-benchmarks/<slug>/auth/callback`, each added to the OAuth app), one `SESSION_SECRET`.
Cookies HttpOnly, `Path=/decision-benchmarks/<slug>/`: players sign in per game. Settings drop jevman's
`JEV`/`JEVMAN` prefixes (`TRUSTED_PROXIES`, `HIGHSCORES_BUCKET`, `ALLOW_DEV_KEY`, ...). The image installs with
`npm ci --ignore-scripts`.

## Games

**jevman** (Pac-Man, AGPL, Arcade), the game the kit comes from, is served here too (see "jevman, served here"
below). The games ported onto the kit:

1. **snake** (ours, MIT, Arcade): a decision model steers a snake on a seeded board, one `choice` per step (left,
   straight, right), paused: the game waits for the answer (2 s, then a fallback that never plays well on the
   model's behalf). Score = apples eaten, ended by death or a step cap. Play = you and a model on the same seeded
   board side by side; your game is replayed on the server, from a server-issued seed, for the high-score board.
2. **fighter** (jev-fighter, MIT, Fighting): metric = round-win share (draw = 0.5) against the strong baselines
   (greedy, payoff, maximin), paused mode, assisted track, fixed seeds played from both sides; track, mode and
   gauntlet are part of its benchVersion. The verifier recomputes the baselines' moves with our code and checks every
   model move's legality, timing and the checkpoint hashes. Bradley-Terry between models stays on the game's own page.
   Hosted calls go through the kit's /api/decide; no keys in the browser on opper.ai, no server-stored replays.
3. Tetris-style: blocked on outreach (the author's OK and a license).

## License

jevman's code is AGPL-3.0-or-later (authors: Johnny Chadda, Felix Wunderlich, Jose Sabater). The root LICENSE and the
kit stay AGPL until all three agree to MIT; then the kit is relicensed in one commit. `games/fighter` keeps its MIT
LICENSE; `games/snake` is MIT.

## Implementation notes (phase 1, the kit and Pac-Man on it)

Where building the kit changed or filled in the design above, and why:

- **GameDefinition.** `Rec` has no `{ format }` constraint: Pac-Man's recordings (submitted ones included) carry
  `version`, and the kit never reads a recording itself. `play` also gets `model`, the id the recording names. A
  game's `rules.maxRecordingBytes` caps the gzipped file; unpacked it may be eight times that.
- **decideRequest.** The game's check runs for every key (player, pool, dev), not only the pool's: the service never
  forwards anything its games would not send. The kit also caps every request at five questions. A verdict may carry
  `as`, the game's own name for the model: the response names the model that way and answers are signed as it, so a
  game can keep the ids its recordings use (Pac-Man keeps jevman's `opper/clef` while the request carries
  `sference/clef`).
- **Review fixes.** `GameServer.models` (optional) lists the Opper ids a game plays: /api/warm and /api/decide refuse
  any other with 400 before calling upstream. `GameDefinition.baselines` (optional) names non-model players. A
  submission may not take a name or id on the game's own leaderboard.json, the kit's models or the baselines; a game
  already in an earlier submission (by folder name) is refused; `recordedAt` must be a past ISO date, and game.json's
  `updatedAt` reads only accepted submissions. Hidden paths are 404. The image's code is root-owned.
- **Seeds.** A submission's games must be `game-01` to `game-N`, each once; game n is replayed on `seedFor(n - 1)`,
  which the game's `verify` checks against the recording. Pac-Man has no randomness, so its `seedFor` is constant.
- **Settings.** One redirect URI per game comes from `PUBLIC_BASE_URL` + `APP_BASE_PATH` + slug, so jevman's
  `OPPER_REDIRECT_URI` and `OPPER_OAUTH_REDIRECT_URI` are gone, as is `JEV_MODEL` (a request without a model plays
  Jev). High scores: `HIGHSCORES_BUCKET` (each game at `[HIGHSCORES_PREFIX/]<slug>/highscores.json`) or
  `HIGHSCORES_DIR`. `ALLOW_HTTP=1` replaces `JEVMAN_ALLOW_HTTP`. `GAMES=<slug>,...` makes the service serve those
  games of the registry only (`GAMES=snake` locally). Cookies are `db_session` (path
  `<base>/<slug>/`) and `db_oauth_state` (path `<base>/<slug>/auth`).
- **Routes.** `/revision` answers below the base path and lists the games served. `POST /api/highscores` answers with
  `order` too. A production image refuses to start without an https `PUBLIC_BASE_URL` even with no games mounted.
- **Pac-Man.** Its `leaderboard.json` and the `community.json` the kit builds are in the contract shape (Opper ids;
  its numbers in `extra`); `shared/leaderboard.ts` turns them back into jevman's shape for its page. Its bench-only
  flags (ghosts played by models, `--pacman greedy`) are gone with the old bench script; `--record` remains, for
  demos. It started here as the kit's real-time test fixture (not served); see "jevman, served here" below.
- **Build and tooling.** `vitest.config.ts` is separate from `vite.config.ts` (which needs `GAME`). `community.json`
  is not committed: `npm run submissions` writes it, and `npm run build` runs it for each game. Scripts run under
  plain Node (no tsx). A game's page takes the shared opper.ai chrome with
  `@import "../../../packages/kit/client/opper-chrome.css"` at the top of its stylesheet.
- **CI.** `.github/workflows/ci.yml`: typecheck, tests, every game's submissions replayed, the contract checked, the
  image built and smoke-tested. deploy.yml deploys a green push to main only while the repository variable DEPLOY_ENABLED is true, so main can
  take code before the infrastructure (step 0) exists.

## Implementation notes (snake, the first game on the kit)

- **Baselines.** `GameDefinition.baselines` lists a game's free scripted players by name. A baseline with a
  `transport` answers the game's questions itself, like a model (snake's). One without is played by the game itself,
  for baselines that read the full game state (the fighter's): the bench calls `play` with `model: 'baseline/<name>'`
  and a transport that throws if ever called. The bench plays either with `--model baseline/<name>` (no key, no
  warm-up) and writes them only with `--leaderboard --out <file>` (a game's `public/baselines.json`): never into
  `leaderboard.json` or a submission, and submissions may not take a baseline's name or id, so the hub never shows a
  baseline as a model. A game's page reads its baselines file itself.
- **Issued seeds.** A game whose high scores need a dealt board sets `highScores.seeded`; the service then answers
  `GET <game>/api/seed` with a random 31-bit seed and a stateless token signed with a per-game key
  (`HMAC(SESSION_SECRET, "decision-benchmarks:seeds:" + slug)`, one hour). `highScores.check` gets a `SeedVerifier`
  as its third argument, returning the seed and the token's age. The client side is `packages/kit/client/seeds.ts`.
- **Snake** follows `games/snake/SPEC.md`; its last section lists where the build differs from the spec.

## Implementation notes (phase 2, the fighter on the kit)

- **games/fighter** is in the registry, the root typecheck and the root tests. Its port is recorded, with the choices
  the code forced, in `games/fighter/docs/specs/2026-10-12-port-to-kit.md`.
- **Baselines.** The fighter's five baselines (`baseline/random`, `guard`, `greedy`, `payoff`, `maximin`) are
  `baselines` without a transport (see above); `public/baselines.json` holds their results.
- **Shared settings.** The root `tsconfig.json` takes the fighter's ES2023 target and `verbatimModuleSyntax`, which the
  whole repository passes. mediabunny (clip export in the browser) is the first runtime dependency, pinned exactly; it
  ships in the fighter's page bundle only, never in the service.

## Implementation notes (jevman, served here)

- **The decision.** The brief kept jevman in its own repository and left moving it in as an option. The owner chose to
  move it: `games/jevman` (slug `jevman`) is served at `opper.ai/decision-benchmarks/jevman/` like snake and fighter,
  and it is first in the registry. The old address, `opper.ai/jevman-benchmark`, keeps running from
  opper-ai/jevman-benchmark until a redirect is decided.
- **What changed.** Only the slug, from `pacman` to `jevman`: the folder, `game.ts`, `game.server.ts`, the `game`
  field of its results files and `game.json`. The in-game actor is still `pacman`, and the recording and replay
  formats are unchanged, so every submission and demo recording replays as before (nothing in a submission names the
  slug). Answer signatures are keyed per slug (`answerKey(secret, slug)`), so a player's game started on the old
  slug cannot post a high score on the new one; recordings never carry those signatures into submissions.
- **Fixtures.** There are none left, so the registry has no fixture list: `GAMES` picks from the registry,
  `check-contract` requires every game's poster, the image copies every game, and CI's separate fixture build is
  gone. The image build covers it, and the container smoke test checks each served game's `game.json` (its
  `updatedAt` included) and `poster.png`.
- **Hub files.** `public/poster.png` is jevman-benchmark's (branch `hub-contract`); `game.json` names the author as
  that repository's does (`joch`, `https://github.com/joch/jevman`). The page's "Add your model" links point at this
  repository, where its submissions are now checked.
- **High scores** start empty: the service reads `<bucket>/[HIGHSCORES_PREFIX/]jevman/highscores.json`, which does not
  exist until a player posts one, unless jevman's live board is copied from its own bucket first (an ops step, not
  done).
