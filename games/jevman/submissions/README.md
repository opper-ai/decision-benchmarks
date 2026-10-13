# Submissions

Models their makers benchmarked themselves on jevman (Pac-Man). Each folder is one model: `submission.json` and the
recorded games, written by `npm run bench -- --game jevman --endpoint … --submit games/jevman/submissions/<id> …`.
See [CONTRIBUTING.md](../../../CONTRIBUTING.md#benchmark-your-own-model).

`npm run submissions -- --game jevman` replays every game on the kit and writes `public/community.json`, the
community part of the leaderboard at [opper.ai/decision-benchmarks/jevman](https://opper.ai/decision-benchmarks/jevman/leaderboard).
