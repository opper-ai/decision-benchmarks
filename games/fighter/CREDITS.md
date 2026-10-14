# Credits

Jev Fighter is by Jose Sabater, from [Jose-Sabater/jev-fighter](https://github.com/Jose-Sabater/jev-fighter), MIT (see
[LICENSE](LICENSE)). Its history came into this repository with `git subtree` (commit a42042d).

## What we kept

The deterministic engine (`shared/engine`, engine version 7) and its rules, the question design of its v2 harness
(`docs/specs/2026-10-06-v2-harness.md`: perception with a reaction delay, the assisted and raw tracks, shuffled options,
the guard-only fallback), the baselines, the live match driver (real time and paused), replays and their checkpoint
hashes, per-match stats and Bradley-Terry ratings (`shared/stats.ts`), the renderer, the generated sound and music, the
keyboard controls, and the fight, replay, stats, timeline and pose views, with clip export.

## What changed in the port

- **The benchmark** is the kit's `GameDefinition` (`game.ts`): paused, assisted, against the greedy, payoff and maximin
  baselines from both sides on fixed seeds, scored by round-win share. A synchronous stepper (`shared/gauntlet.ts`) plays
  a match for the bench and replays it for the submissions check, which recomputes every baseline move.
- **Model calls** from the page go through the kit's `/api/decide` (free credits, Login with Opper, a local key in
  development), with a strict request check (`game.server.ts`). The page holds no API keys and calls no custom endpoints:
  the "Connect" panel, browser keys and `fighters.json` are gone. Your own endpoints and chat models play in the bench
  (`--endpoint`, `--format systemone|chat`).
- **No server-stored replays.** The replay store, upload, admin deletion and the community/official replay lists are
  gone. Watch plays the recordings committed in `public/demo/`; a match you play stays in your browser and can be
  downloaded.
- **The model list** comes from the kit (Opper's decision models, one route each); chat LLMs are no longer in the picker.
  The default opponent is Clef.
- **The page** follows every game page's layout (Snake's, after JevMan's): the recording on the stage, Fight an AI, then
  How it works. It shows no leaderboard: the game is one to play against the models, not a benchmark.
- **Dropped**: the fighter's own server, session and OAuth code, its bench, smoke, replays and gen-audio scripts, the
  direct System One, chat and OpenAI Decisions adapters, the Dockerfile, Railway and CI configuration, the raw audio
  sources (the generated, trimmed sounds in `public/audio` stay) and the sample replays.
- **Code**: constructor parameter properties became plain fields (the service runs TypeScript as Node strips it), the
  state copy is hand-written (same states, about twice as fast), and the baselines expose a synchronous move.

## Dependencies

- [mediabunny](https://github.com/Vanilagy/mediabunny) 1.61.3 (MPL-2.0), pinned exactly, for clip export in the
  browser (WebCodecs to MP4). Reviewed for the port: a browser-only library with no install scripts; its only
  dependencies are two type packages. It ships in the page bundle, never in the service.
- The sounds and music were generated with ElevenLabs sound-effect and music models through Opper's audio API; the
  provider's terms for generated audio apply.
- Fonts, self-hosted in `public/fonts/` (the page shares opper.ai's origin, so it loads nothing from Google Fonts):
  Caveat (Impallari Type, SIL Open Font License 1.1), Wix Madefor Display and Wix Madefor Text (Wix.com, SIL Open
  Font License 1.1) and JetBrains Mono (JetBrains, SIL Open Font License 1.1), the latin subsets. The license texts are in
  `public/fonts/OFL.txt`.
- The model logos in `public/logos/` are copied from JevMan (opper-ai/jevman-benchmark, its `public/logos/`): each is its
  maker's own mark (TypeSafe, Cloudflare, OpenAI, Microsoft, EmpirioLabs, Convai Innovations, and Jared Palmer's avatar
  for Kev), used to name the model, as on JevMan.
