# decision-benchmarks

Games that decision models play, hosted by Opper at `opper.ai/decision-benchmarks/<game>/`, with a leaderboard per
game: our own runs of every decision model Opper serves, and self-reported runs anyone can send by pull request (CI
replays every submitted game with our code). The hub page that lists the games lives on opper.ai
(`/decision-benchmarks`) and only reads the files each game serves.

The harness is the **kit**, extracted from [jevman](https://github.com/opper-ai/jevman-benchmark), the Pac-Man
benchmark; every game here is ported onto it. jevman itself stays in its own repository at
[opper.ai/jevman-benchmark](https://opper.ai/jevman-benchmark/), where its links point, and the hub lists it there;
`<APP_BASE_PATH>/jevman/` redirects to it. How it fits together, and the contract with the hub: [docs/design.md](docs/design.md).

## Layout

```
packages/kit/        the harness: shared/ (types, models, stats, contract), client/ (browser), server/ (the service),
                     bench/ (the bench and the submissions check)
games/registry.ts    the games the service serves and the build builds: snake, fighter (and MOVED: jevman's redirect)
games/<slug>/        one game: game.ts (bench and replay), game.server.ts (service), src/, index.html, public/
                     (game.json, poster.png, leaderboard.json, community.json), submissions/, tests/
games/snake/         Snake: our own game, the first built on the kit (see games/snake/README.md)
games/fighter/       Jev Fighter (jev-fighter, by Jose Sabater), on the kit: served at <APP_BASE_PATH>/fighter/
server/main.ts       the service: every registry game at <APP_BASE_PATH>/<slug>/
scripts/             bench, submissions, build, check-contract
```

The kit comes from jevman, by Johnny Chadda and Felix Wunderlich ([opper-ai/jevman-benchmark](https://github.com/opper-ai/jevman-benchmark)); Jev Fighter is by Jose Sabater ([Jose-Sabater/jev-fighter](https://github.com/Jose-Sabater/jev-fighter)). Each game's CREDITS.md says what changed in the port.

## Commands

Node 22.18 or later. Install with `npm ci --ignore-scripts`, and copy `.env.example` to `.env` for keys.

```bash
GAME=snake npm run dev                        # one game's page and API on the Vite dev server (http://localhost:5173/snake/)
npm test                                      # every package's and game's tests
npm run typecheck
npm run bench -- --game snake --games 2       # play a game with the default model (OPPER_API_KEY; paid calls)
npm run bench -- --game snake --model baseline/greedy   # a game's free baseline: no key, no calls
npm run bench -- --game <slug> --models all --leaderboard   # official runs: games/<slug>/public/leaderboard.json
npm run bench -- --game <slug> --endpoint http://localhost:8787 --submit games/<slug>/submissions/my-model --name "My Model" --by you
npm run submissions -- --game snake           # replay every submission, write public/community.json
npm run check-contract                        # validate the files every game serves to the hub
npm run build                                 # build every registry game into dist/<slug> (or: npm run build -- snake)
npm start                                     # the service (PORT, APP_BASE_PATH; GAMES=snake to serve only that game)
```

Login with Opper is one sign-in for every game, at `<APP_BASE_PATH>/auth/*`: register one redirect URI on the OAuth
app, `https://opper.ai/decision-benchmarks/auth/callback` in production and `http://localhost:5173/auth/callback` for
the dev server (see `.env.example`).

Benchmark your own model, or suggest a game: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

AGPL-3.0-or-later (see [LICENSE](LICENSE)), as jevman. Each game folder has its own license: `games/snake` and
`games/fighter` are MIT.
