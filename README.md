# decision-benchmarks

Games that decision models play, hosted by Opper at `opper.ai/decision-benchmarks/<game>/`, with a leaderboard per
game: our own runs of every decision model Opper serves, and self-reported runs anyone can send by pull request (CI
replays every submitted game with our code). The hub page that lists the games lives on opper.ai
(`/decision-benchmarks`) and only reads the files each game serves.

The harness is the **kit**, extracted from [jevman](https://github.com/opper-ai/jevman-benchmark), the Pac-Man
benchmark; every game is ported onto it. How it fits together, and the contract with the hub: [docs/design.md](docs/design.md).

## Layout

```
packages/kit/        the harness: shared/ (types, models, stats, contract), client/ (browser), server/ (the service),
                     bench/ (the bench and the submissions check)
games/registry.ts    the games the service serves and the build builds
games/<slug>/        one game: game.ts (bench and replay), game.server.ts (service), src/, index.html, public/
                     (game.json, poster.png, leaderboard.json, community.json), submissions/, tests/
games/pacman/        jevman on the kit: the kit's real-time test fixture, not served (jevman stays live in its own repo)
games/fighter/       jev-fighter, being ported (it keeps its own setup for now)
server/main.ts       the service: every registry game at <APP_BASE_PATH>/<slug>/
scripts/             bench, submissions, build, check-contract
```

## Commands

Node 22.18 or later. Install with `npm ci --ignore-scripts`, and copy `.env.example` to `.env` for keys.

```bash
GAME=pacman npm run dev                       # one game's page and API on the Vite dev server (http://localhost:5173/pacman/)
npm test                                      # every package's and game's tests
npm run typecheck
npm run bench -- --game pacman --games 2      # play a game with the default model (OPPER_API_KEY; paid calls)
npm run bench -- --game <slug> --models all --leaderboard   # official runs: games/<slug>/public/leaderboard.json
npm run bench -- --game <slug> --endpoint http://localhost:8787 --submit games/<slug>/submissions/my-model --name "My Model" --by you
npm run submissions -- --game pacman          # replay every submission, write public/community.json
npm run check-contract                        # validate the files every game serves to the hub
npm run build                                 # build every registry game into dist/<slug> (or: npm run build -- pacman)
npm start                                     # the service (PORT, APP_BASE_PATH; GAMES=pacman to serve the fixture)
```

Benchmark your own model, or suggest a game: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

AGPL-3.0-or-later (see [LICENSE](LICENSE)), as jevman; the kit is meant to become MIT once its authors agree (see
[packages/kit/README.md](packages/kit/README.md)). Each game folder keeps its own license.
