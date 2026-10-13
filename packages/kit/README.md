# The kit

The game-independent harness every game in this repository runs on, extracted from
[jevman](https://github.com/opper-ai/jevman-benchmark): System One types and answer parsing, the decision model list,
leaderboard statistics, the hub contract, the schedulers (real time and paused), the browser client (transport,
warm-up, Login with Opper, high scores), the service (every game at `<APP_BASE_PATH>/<slug>/`, one free-credits pool),
the bench and the submissions check. See [docs/design.md](../../docs/design.md) for how a game plugs in.

- `shared/`: isomorphic (page, service, bench)
- `client/`: the browser
- `server/`: Node built-ins only; Node runs it as stripped TypeScript
- `bench/`: Node; the bench CLI and the submissions check (entry points in `scripts/`)

## License

MIT (see [LICENSE](../../LICENSE)); authors Johnny Chadda, Felix Wunderlich and Jose Sabater. It was extracted from
jevman, which is AGPL-3.0-or-later; its authors agreed to relicense the extracted harness as MIT (2026-10-13).
