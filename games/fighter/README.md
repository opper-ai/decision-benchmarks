# Jev Fighter

Stick figures fight; decision models pick every move. A 2D fighting game built as a benchmark: a deterministic engine,
exact replays, and one question per decision whose options are the fighter's legal moves. Served at
[opper.ai/decision-benchmarks/fighter](https://opper.ai/decision-benchmarks/fighter/): fight the models yourself, watch
recorded matches, and see how every decision model Opper serves ranks.

Ported from [Jose-Sabater/jev-fighter](https://github.com/Jose-Sabater/jev-fighter) (MIT) onto this repository's kit:
see [CREDITS.md](CREDITS.md).

## What it measures

**Round-win share against the baselines.** One benchmark game is one match of the model under test against one of three
fixed-rule baselines, the strongest ones: **greedy** (the biggest swing if the opponent stands still or repeats itself),
**payoff** (the best average) and **maximin** (the safest move). The score is the model's share of the rounds, a drawn
round counting half, in percent; a model's result is the mean over its games.

- **Paused mode**: the fight waits for each answer (up to 5 s, then the fallback blocks), so only the quality of the
  decisions counts, not speed.
- **Assisted track**: each option shows its payoffs (below), so the test is weighing risk and reading the opponent.
- **Fixed seeds, both sides**: game `i` plays seed `i`. `i % 3` picks the baseline, `floor(i / 3) % 2` the side and
  `floor(i / 6)` the fight (its start distance and position). The official 102 games are 17 fights, each against every
  baseline from both sides; a submission plays at least the first 24.

The baselines' own results on the same games are in [public/baselines.json](public/baselines.json) (maximin about 71%,
greedy 54%, payoff 25%, guard 7%, random 0%). A model below payoff is doing worse than reading its own options.

## The rules

Two fighters on a 10 body-length stage. Best of 3 rounds of 60 seconds; a knockout wins a round, otherwise the fighter
with more health when time runs out (equal health is a drawn round, and a match can run to 5 rounds when rounds are
drawn). 100 health each.

- **Strikes beat throws, throws beat blocks, blocks beat strikes** (a blocked strike does a quarter of its damage).
- **High or low**: block high stops highs and jump kicks; block low stops lows.
- **Uppercut beats jump-ins**; **jumping and backdashing** dodge lows and throws.
- **Passivity**: 8 seconds free to act without attacking or stepping in costs 1 HP per second until the fighter engages
  (time under attack does not count).
- A fighter sees its opponent as it was 10 frames ago (about human reaction time).

Moves (frames at 60 per second: startup / active / recovery, damage, reach in body-lengths):

| Move | Type | Frames | Damage | Reach | Notes |
|---|---|---|---|---|---|
| Jab | high | 4 / 2 / 8 | 4 | 1.0 | Fastest move |
| Straight | high | 7 / 3 / 14 | 8 | 1.2 | |
| Low kick | low | 6 / 3 / 12 | 6 | 1.1 | Beats a standing guard |
| High kick | high | 10 / 4 / 20 | 12 | 1.3 | Longest standing reach |
| Uppercut | high | 6 / 4 / 24 | 14 | 0.95 | Knocks down; immune to jump-ins for 8 frames |
| Sweep | low | 11 / 4 / 22 | 9 | 1.3 | Knocks down |
| Throw | unblockable | 5 / 2 / 20 | 12 | 0.85 | Knocks down; misses fighters who are attacking or airborne |
| Jump kick | overhead | hits frames 14 to 20 of 34 | 10 | 1.1 | Travels 1.5 forward; must be blocked high |
| Dash palm (special) | high | 9 / 5 / 26 | 18 | 1.1 | Dashes 1.0 first; costs a full meter; absorbs one hit |
| Jab, straight | high | | 4 + 8 | 1.0 | The straight only comes out if the jab hits |
| Low kick, sweep | low | | 6 + 9 | 1.1 | The sweep only comes out if the low kick hits |
| Block high / low | stance | at least 18 | | | |
| Step in / step back, dash, backdash, jump | movement | 12 to 34 | | | |

## The question

Each decision is one System One `choice` question named `move`: the rules as instructions, the situation as `state`,
and every sensible move as an option, shuffled per question. On the assisted track each option has a payoff row worked
out by the engine: the HP swing over the exchange averaged over everything the opponent could do (`avg`), if it plays
its best answer (`worst`, named) and if it repeats its usual attack (`usual`), plus `adv`, the frames you can act before
(+) or after (-) the opponent when it ends.

```json
{
  "state": { "you": "100 HP, meter 0, standing, free to act, 4.0 from your wall", "opponent": "...", "distance": "1.1",
             "time": "round 1, 52 s left, rounds won 0-0", "recent": "none yet" },
  "questions": { "move": { "type": "choice", "instructions": "You control one fighter in a 2D fighting game. ...",
    "criteria": { "sweep": "avg +2.3, worst -15 (if low_kick_sweep); adv +34f", "block_low": "avg -0.4, worst -12 (if high_kick); adv -10f" } } }
}
```

Answer with one of the criteria keys (`{ "answers": { "move": { "type": "choice", "choice": "sweep" } } }`). A late,
missing or unusable answer, or a move that is no longer legal, makes the fighter block: the game never plays well on a
model's behalf. Decision models with a short context (Laya) get compact instructions and fewer columns.

## Benchmark your model

From the repository root (see [CONTRIBUTING.md](../../CONTRIBUTING.md)):

```bash
node games/fighter/example-endpoint.ts                                        # a model to copy, on :8787
npm run bench -- --game fighter --endpoint http://localhost:8787 --games 6    # try it
npm run bench -- --game fighter --endpoint http://localhost:8787 --submit games/fighter/submissions/my-model \
  --name "My Model" --by your-github-handle                                   # 24 games (--games 102 to match ours)
npm run submissions -- --game fighter                                         # check it the way CI will
npm run bench -- --game fighter --model baseline/maximin --games 6            # a baseline as the player: free
```

CI replays every submitted game with our code: it rebuilds the match from its seed, recomputes every baseline move,
checks that every one of your moves was legal and offered when your fighter could act, that every fallback is the
fallback rule's and every answer came within the deadline, and that the checkpoint hashes and rounds match.

## Playing it

**Play**: you at the keyboard against a decision model (on the free credits, then on your own Opper account once you
sign in), or any two fighters, baselines included, in real time or paused. Keys: A D walk (hold back to block high,
double-tap to dash), W jump, S block low, U I O punches, J K L kicks, H throw, Y jump kick, Space special. A match you
play stays in your browser: watch it with its stats, export a clip, or download it.

**Watch**: recorded benchmark matches (public/demo/), with every decision, the question it answered, a timeline and
per-fighter stats. Space plays and pauses, arrows step, `[` `]` jump between decisions.

## Layout

```
game.ts            the GameDefinition (bench and submissions check)
game.server.ts     the request check the service runs before a model sees a question
shared/engine/     the deterministic simulation (integer math, 60 ticks per second); ENGINE_VERSION
shared/            questions, perception, baselines, fallback, the live match driver, the benchmark (gauntlet.ts),
                   replays, stats
src/               the page: renderer, sound, keyboard, the fight, replay, stats and leaderboard views, clip export
public/            game.json, poster.png, leaderboard.json, baselines.json, demo/, audio/
tests/             engine, questions, matches, the benchmark and its verifier, the request check, submissions
```

The sounds and music were generated with ElevenLabs models through Opper's audio API.

## License

MIT, see [LICENSE](LICENSE).
