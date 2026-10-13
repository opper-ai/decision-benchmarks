# Credits

**jevman** is the Pac-Man benchmark for decision models by Johnny Chadda and Felix Wunderlich (Opper), from
[opper-ai/jevman-benchmark](https://github.com/opper-ai/jevman-benchmark), AGPL-3.0-or-later (see LICENSE). It is
served from this repository at `opper.ai/decision-benchmarks/jevman/`.

What changed here: the harness (scheduler, transport, warm-up, sign-in, high scores, the server, the bench and the
submissions check) moved into the kit (`packages/kit`), and the game now runs on it. The game, its questions, its
rules and its recordings are unchanged (bench version 1), so the submissions recorded for jevman replay here as they
are. Its results files use the kit's contract shape, which `shared/leaderboard.ts` turns back into jevman's for its
page.
