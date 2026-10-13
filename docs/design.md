# decision-benchmarks: design

How the repository fits together: the kit every game runs on, what a game gives it, the files each game serves to the
hub on opper.ai, the service that hosts the games, and how submissions are checked.

## Layout

```
packages/kit/
  shared/      isomorphic: System One types and answer parsing, the model list (from Opper's models API, with a
               checked-in snapshot), stats (mean, std error, ties within the margin, ranks), the hub contract
               (contract.ts), the answer-signature message, the GameDefinition / GameServer types (game.ts)
  client/      browser: transport to /api/decide, warm-up, the Login with Opper client, the high-score client, base
               paths, issued seeds, the generic scheduler (real time with ask-ahead, or paused), shared page chrome
  server/      node: one HTTP service that mounts every game at <APP_BASE_PATH>/<slug>/, one Login with Opper for all
               of them at <APP_BASE_PATH>/auth/*, the free-credit pool and one visitor limiter shared by every game,
               sessions, high scores (S3 or files)
  bench/       node: the bench CLI (--game --model(s) --endpoint --format systemone|chat --games --submit --name --by),
               official runs -> leaderboard.json, submissions -> community.json
games/
  registry.ts           the games the service, the bench and the build serve: jevman, snake, fighter
  <slug>/
    game.ts             GameDefinition: the bench and the submissions check
    game.server.ts      GameServer: what the service needs (Node-safe imports only)
    src/  index.html    the game's page
    public/             game.json, poster.png, leaderboard.json, baselines.json (if any), demo/
    submissions/<id>/   submission.json + game-NN.json.gz
    tests/  LICENSE  CREDITS.md
server/main.ts          the service with every registry game
scripts/                bench.ts, submissions.ts, build.ts, check-contract.ts (thin entry points)
```

One root `package.json` (no workspaces), relative imports with `.ts` extensions. Everything the server or the
scripts reach is erasable TypeScript (`erasableSyntaxOnly`: no parameter properties, enums or namespaces), so Node
runs it as is, without a build step; a test imports every registry game's server module under plain Node. One Vite
config, run once per game (`GAME=<slug>`): `root: games/<slug>`, `publicDir: games/<slug>/public`,
`outDir: dist/<slug>`, `base: <APP_BASE_PATH>/<slug>/`. One root vitest config covers `packages/**/tests` and
`games/*/tests`.

## How a game plugs into the kit

A game folder exports two things, typed in `packages/kit/shared/game.ts`:

```ts
interface GameResult { score: number; calls: number; latencyMsSum: number; cost: number; decisions: number; fallbacks: number }
type Verdict<R> = { ok: true; result: R; fingerprint: string } | { ok: false; error: string };

// games/<slug>/game.ts
interface GameDefinition<Rec = unknown, R extends GameResult = GameResult> {
  slug: string;
  benchVersion: number;                       // bump when rules or questions change; older submissions are refused
  mode: 'realtime' | 'paused';
  timing: { decisionTimeoutMs: number; callTimeoutMs: number; maxInFlight: number };
  rules: { minGames: number; officialGames: number; seedFor(i: number): number; maxRecordingBytes: number };
  metric: { name: string; unit: string; higherIsBetter: boolean };
  play(o: { transport: Transport; seed: number; signal: AbortSignal; model: string }): Promise<{ result: R; recording: Rec }>;
  verify(rec: unknown, o: { seed: number }): Verdict<R>;      // recomputes the result with our code
  summarize?(results: R[]): Record<string, number | string>;  // -> a leaderboard entry's extra
  baselines?: Record<string, { name: string; transport?(): Transport }>;
}

// games/<slug>/game.server.ts
interface GameServer {
  slug: string;
  // Required: rebuild or strictly validate the request, so the service only forwards what this game asks.
  decideRequest(body: unknown): { ok: true; request: SystemOneRequest; keys?: Record<string, string>; as?: string } | { ok: false; error: string };
  models?: readonly string[];                 // the Opper ids this game plays; any other is refused with 400
  highScores?: {
    boards: readonly { id: string; label: string }[];   // order matters: the hub shows the first board's top
    seeded?: boolean;                                    // games start from a seed the server issues
    check(rec: unknown, verify: AnswerVerifier, seeds: SeedVerifier): { ok: true; score: number; board: string } | { ok: false; error: string };
  };
}
```

- **Questions.** Every decision is a System One request: a `state` and one or more named questions (`choice` with
  options as `criteria`). `decideRequest` runs for every key (player, pool or dev), and the kit caps a request at five
  questions. A verdict may carry `as`, the game's own name for the model, so a game can keep the ids its recordings
  use while the request carries the Opper id.
- **Answer signatures.** The service signs each answer with a key per game,
  `HMAC(SESSION_SECRET, "decision-benchmarks:answers:" + slug)`, so an answer signed for one game never verifies in
  another. A high-score check uses the signatures to tell real model answers from made-up ones.
- **Seeds.** Official runs and submissions play `seedFor(0)` to `seedFor(N - 1)`, so every model faces the same games.
  A game whose high scores need a dealt board sets `highScores.seeded`; the service then answers `GET <game>/api/seed`
  with a random 31-bit seed and a stateless token signed with a per-game key
  (`HMAC(SESSION_SECRET, "decision-benchmarks:seeds:" + slug)`), valid for an hour.
- **Baselines.** Free scripted players for reference. One with a `transport` answers the game's questions itself, like
  a model; one without is played by the game itself (`play` gets `model: 'baseline/<name>'` and a transport that
  throws if called), for baselines that read the full game state. The bench plays them with
  `--model baseline/<name>` (no key, no calls) and writes them only to a game's `public/baselines.json`, never to
  `leaderboard.json` or a submission, so the hub never shows a baseline as a model.
- **Warm-up** lives in the kit (bench and client), not in games.

## The files each game serves for the hub

The hub at `opper.ai/decision-benchmarks` lists the games and only reads these files, below
`https://opper.ai/decision-benchmarks/<slug>/`:

| File | Shape |
|---|---|
| `game.json` | `{ slug, name, tagline, category: 'Arcade'\|'Puzzle'\|'Fighting'\|'Strategy', author: { github, originalRepo? }, license, metric: { name, unit, higherIsBetter }, updatedAt }`. Our own games have `author.github: "opper-ai"` and no `originalRepo`. `updatedAt` is set at build time from the newest results: the official run, or a newer accepted submission. |
| `leaderboard.json` | `{ generatedAt, game, benchVersion, metric, entries: Entry[], skipped: { model, reason }[] }`. `Entry = { model, name, games, metric: { mean, stdError, best }, meanLatencyMs: number\|null, fallbackRate, costPerGame: number\|null, via: 'systemone'\|'chat-adapter', extra? }`, best first. |
| `community.json` | the same, with entries that add `by, url?, selfReported: true`. Not committed: built from `submissions/` at build time. |
| `api/highscores` | `{ order: string[], boards: { <board>: [{ initials, score, at }] } }`; 404 for a game without high scores. |
| `poster.png` | 16:9, at most 150 KB. |

The top-level `metric` defines the measure; an entry's `metric` holds its values. An official entry's `model` is the
Opper id the run called, one route per model. The types and validators are in `packages/kit/shared/contract.ts`;
`npm run check-contract` validates every game's files and runs in CI.

## The service

One Node process serves every game in the registry (`GAMES=<slug>,...` serves a subset). It mounts at two levels:
`APP_BASE_PATH` (for example `/decision-benchmarks`), then the slug. The bare `<base>/<slug>` redirects to
`<base>/<slug>/`, unknown slugs are 404, hidden paths are 404, and static files never cross between games. `/health`
answers at the root and below the base path, `/revision` below the base path (the commit and the games served).

Per game, below `<base>/<slug>/`: the static page, `api/decide` (one model call), `api/warm` (a tiny call that wakes
an idle model), `api/me` (who is signed in, and whether the free credits are open), `api/highscores` and, for seeded
games, `api/seed`.

**Sign-in.** Login with Opper is one OAuth app and one sign-in for every game: `<base>/auth/login?return=<page>`,
`<base>/auth/callback` and `<base>/auth/logout`, so the app has one redirect URI
(`${PUBLIC_BASE_URL}${APP_BASE_PATH}/auth/callback`) and a player signed in on one game is signed in on all of them.
`return` must be a path below the base path on this origin, checked on the way out and again on the way back, so the
login is no open redirect. The session is an AES-256-GCM sealed cookie (`db_session`, HttpOnly, Secure on https,
SameSite=Lax, path `<base>/`) holding the player's Opper key; the OAuth state cookie (`db_oauth_state`) is scoped to
`<base>/auth`. A production image refuses to start without an https `PUBLIC_BASE_URL` and a `SESSION_SECRET` of at
least 32 characters.

**Which key pays.** A signed-in player plays on their own Opper account. A signed-out visitor plays on the free
credits: one Opper key (`OPPER_POOL_API_KEY`) shared by every game, whose organization balance is the pool. The service
reads the balance from Opper periodically to tell the page whether the pool is open; Opper itself stops the key at
zero, and then the page asks the visitor to sign in. Use of the pool is limited per visitor (by IP address, IPv6 by its
/64) with one rate limiter shared by every game, sized for what a real game sends; a pool request's body is also
capped. In local development a key of your own (`OPPER_API_KEY`) can pay instead. Whatever the key, the service only
forwards a request its game's `decideRequest` accepts, for a model the game lists (when it lists them).

**High scores.** A game with `highScores` gets boards of the top ten, three initials each. A player's entry is the
game's recording; the game's `check` replays it on the server (with the answer signatures and, for seeded games, the
seed token) and only the replayed score counts. Entries are rate limited per account (or, signed out, per address)
and game. Boards are stored per game in S3 (`HIGHSCORES_BUCKET`, at `[HIGHSCORES_PREFIX/]<slug>/highscores.json`) or
in files (`HIGHSCORES_DIR`); a save only replaces the version it read, and merges in another server's writes first.

## Submissions and CI replay

Anyone can benchmark their own model: the bench calls their HTTP endpoint (System One shaped, or a chat model through
the bench's adapter) on the game's fixed seeds and writes `games/<slug>/submissions/<id>/`, a `submission.json` and one
gzipped recording per game. See [CONTRIBUTING.md](../CONTRIBUTING.md).

`npm run submissions -- --game <slug>` replays every submission with the game's `verify` and writes
`public/community.json`. A submission is refused when a game does not replay to its recorded result, when its games
are not `game-01` to `game-N` on their seeds, when it has fewer than `minGames`, when it was played on another
`benchVersion`, when a game repeats one already submitted (by fingerprint), when a recording is too large, when
`recordedAt` is not a past date, or when it takes the name or id of an official entry, a kit model or a baseline.
What a replay cannot check (that the model made the moves, its latency, its cost) is as reported, which is why these
rows are marked self-reported.

CI (`.github/workflows/ci.yml`) runs on every pull request: typecheck, tests, every game's submissions replayed, the
contract checked, then the image is built as deployed and smoke-tested (each game's page, hub files and API). A push
to main runs the same CI and then deploys (`deploy.yml`), when deploys are enabled for the repository.

## The games

| Game | Mode | Metric | Official games | License |
|---|---|---|---|---|
| jevman | real time | Score (points) | 100 | AGPL-3.0-or-later |
| snake | real time (275 ms a step) | Apples | 100 | MIT |
| fighter | paused | Rounds won vs bots (%) | 102 | MIT |

- **jevman** (Pac-Man, Arcade): the game the kit was extracted from. A model steers Pac-Man in real time against the
  scripted ghosts until game over or 300 s; the score is the game's points. Players play Pac-Man against ghosts
  played by models, with a high-score board per ghost lineup. Its results files are in the contract shape, and
  `shared/leaderboard.ts` turns them back into jevman's own shape for its page.
- **snake** (Arcade, ours): a model steers a snake on a seeded 16 x 16 board, one `choice` per step (the direction the
  head moves next, every direction but the reverse offered, in a shuffled order), in real time: the snake steps every 275 ms for every model, and a step whose answer is not in by the tick is
  played by a fallback that never steers toward the apple, so the score is decision quality and speed together.
  Score = apples eaten, until death, 150 steps without an apple or 1000 steps. Players race a model on the same server-issued seed,
  and their game is replayed on the server for the high-score board. Rules: `games/snake/SPEC.md`.
- **fighter** (Jev Fighter, Fighting): a deterministic 2D fighting game. One benchmark game is one paused match on the
  assisted track against one of three baselines (greedy, payoff, maximin), from one side, on fixed seeds; the score
  is the model's share of the rounds (a draw counts half). The verifier recomputes the baselines' moves and checks
  every model move's legality, timing and the checkpoint hashes. Its five baselines (`random`, `guard`, `greedy`,
  `payoff`, `maximin`) are on its page, from `public/baselines.json`. Question design:
  `games/fighter/docs/specs/2026-10-06-v2-harness.md`.

## License

The repository root, including the kit and the service, is AGPL-3.0-or-later (see [LICENSE](../LICENSE)). Each game
folder has its own LICENSE: `games/jevman` is AGPL-3.0-or-later, `games/snake` and `games/fighter` are MIT. Each game's
CREDITS.md names its authors and says what changed in the port.
