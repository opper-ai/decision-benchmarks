# Credits

Pac-Man here is **jevman**, the Pac-Man benchmark for decision models by Johnny Chadda and Felix Wunderlich (Opper),
from [opper-ai/jevman-benchmark](https://github.com/opper-ai/jevman-benchmark), AGPL-3.0-or-later (see LICENSE).
jevman stays live in its own repository at [opper.ai/jevman-benchmark](https://opper.ai/jevman-benchmark/).

What changed here: the harness (scheduler, transport, warm-up, sign-in, high scores, the server, the bench and the
submissions check) moved into the kit (`packages/kit`), and the game now runs on it. The game, its questions, its
rules and its recordings are unchanged (bench version 1). Its results files use the kit's contract shape, which
`shared/leaderboard.ts` turns back into jevman's for its page. It is the kit's real-time test fixture and is not
served from this repository; it is deleted once snake and fighter run on the kit.
