# Jev Fighter

Stick figures fight; decision models pick every move. A 2D fighting game with a deterministic engine, exact replays,
and one question per decision whose options are the fighter's legal moves. Served at
[opper.ai/decision-benchmarks/fighter](https://opper.ai/decision-benchmarks/fighter/): fight a decision model yourself
(are you better than it?), or watch two models fight.

**Not a benchmark on the page.** The score below (rounds won against four fixed-rule bots) didn't generalize: a
model's rank here said little about how it decides elsewhere. So the page shows no leaderboard, its `game.json` says
`"benchmark": false` (the hub on opper.ai lists the game but never ranks it), and Watch plays only decision models
against each other. The bench and the submissions check below still run, for whoever wants the numbers.

Ported from [Jose-Sabater/jev-fighter](https://github.com/Jose-Sabater/jev-fighter) (MIT) onto this repository's kit:
see [CREDITS.md](CREDITS.md).

## What it measures

**Rounds won against the bots (the baselines).** One benchmark game is one match of the model under test against one of four
fixed-rule baselines: **greedy** (the biggest swing if the opponent stands still or repeats itself), **payoff** (the
best average), **maximin** (the safest move) and **random** (any offered move, drawn from the match's seed, the floor a
model must clear). The score is the model's share of the rounds, a drawn
round counting half, in percent; a model's result is the mean over its games.

- **Real time**: the fight runs live at its normal speed (60 frames a second), as when you fight a model on the page,
  whatever the model does. The model is asked ahead, about the moment its fighter will be free to act (earlier for a
  slower model), and its answer plays on the first frame the fighter can act after it arrives; until then the fighter
  stands still. An answer that takes more than 2 s is dropped (its call cancelled) and the fallback blocks. One question
  is in flight at a time, and an answer on its way is never dropped because the fight moved on (a hit, an attack
  starting): it plays if its move is still legal, else the fallback does, and then the next question goes out. Only a
  new round drops it. So the score is good decisions made in time.
- **Raw track**: the question gives the situation and the rules; each option is the move's own description (height,
  damage, frames, reach). No payoff rows: the model works out what wins.
- **The baselines** play as they do on the page: asked like a model, on the same rules, they think for 250 ms (counted as 15 frames, so
  a replay recomputes every move) and see the opponent with the same reaction delay. They read the full state (on the
  raw track they work the payoff rows out themselves): they are the opponents, not the test.
- **Fixed seeds, both sides**: game `i` plays seed `i`. `i % 4` picks the baseline, `floor(i / 4) % 2` the side and
  `floor(i / 8)` the fight (its start distance and position). The official 104 games are 13 fights, each against every
  baseline from both sides; a submission plays at least the first 24.

The baselines' own results on the same games are in [public/baselines.json](public/baselines.json) (greedy about 80%,
payoff 65%, maximin 38%, random 17%, guard 7%). A model below random is not deciding anything; one below payoff does
worse than a script that picks each move's best average outcome.

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
and every sensible move as an option, shuffled per question. On the raw track (the benchmark's) each option is the
move's static description: height, damage, startup and recovery frames, reach, and what else it does.

```json
{
  "state": { "you": "100 HP, meter 39, blocking high, 5.9 from your wall", "opponent": "61 HP, meter 18, getting up (cannot be hit), 2.1 from their wall",
             "distance": "1.0", "time": "round 1, 56 s left, rounds won 0-0", "recent": "you hit sweep (9); your low_kick_sweep missed" },
  "questions": { "move": { "type": "choice", "instructions": "You control one fighter in a 2D fighting game. ...",
    "criteria": { "throw": "unblockable, 12 dmg, startup 5f, recovery 20f, reach 0.8, knocks down", "block_low": "stops lows",
                  "jump_kick": "overhead, 10 dmg, startup 13f, recovery 14f, reach 2.0, jumps in, must be blocked high" } } }
}
```

The assisted track (an option when you fight on the page) adds a payoff row to each option, worked out by the
engine: the HP swing over the exchange averaged over everything the opponent could do (`avg`), if it plays its best
answer (`worst`, named) and if it repeats its usual attack (`usual`), plus `adv`, the frames you can act before (+) or
after (-) the opponent when it ends.

Answer with one of the criteria keys (`{ "answers": { "move": { "type": "choice", "choice": "sweep" } } }`). A late,
missing or unusable answer, or a move that is no longer legal, makes the fighter block: the game never plays well on a
model's behalf. Decision models with a short context (Laya) get compact instructions.

## Benchmark your model

From the repository root (see [CONTRIBUTING.md](../../CONTRIBUTING.md)):

```bash
node games/fighter/example-endpoint.ts                                        # a model to copy, on :8787
npm run bench -- --game fighter --endpoint http://localhost:8787 --games 3 --parallel 1   # try it
npm run bench -- --game fighter --endpoint http://localhost:8787 --parallel 1 \
  --submit games/fighter/submissions/my-model --name "My Model" --by your-github-handle    # 24 games (--games 104 to match ours)
npm run submissions -- --game fighter                                         # check it the way CI will
npm run bench -- --game fighter --model baseline/maximin --games 6            # a baseline as the player: free
```

A match plays in real time, so a game takes as long as the fight lasts (half a minute to five minutes). Play one game
at a time (`--parallel 1`): games played together share one process, and their baselines' thinking and your model's
calls slow each other down.

CI replays every submitted game with our code, frame by frame: it rebuilds the match from its seed, plays each of your
moves on the frame it was applied, recomputes every baseline move, and checks that every one of your moves was legal
there and one of the options it was asked about, that your fighter could act on that frame and on none since your
answer arrived, that every fallback is the fallback rule's, and that the checkpoint hashes and rounds match. What it
can't check is the timing: when each answer arrived and how long it took are as your bench recorded them. That is why
a submission is self-reported, as on Snake and JevMan.

## Playing it

**Play**: you at the keyboard against a decision model (on the free credits, then on your own Opper account once you
sign in), or any two fighters, baselines included, in real time or paused. Keys: A D walk (hold back to block high,
double-tap to dash), W jump, S block low, U I O punches, J K L kicks, H throw, Y jump kick, Space special. A match you
play stays in your browser: watch it with its stats, or save its best 18 seconds as a video, made in your browser.

**Watch**: recorded matches between decision models only (public/demo/: GPT-6 Luna against Jev, played live on the
benchmark's settings, recorded with scripts/record-demo.ts --left/--right), with every
decision, the question it answered, a timeline and per-fighter stats. Click the stage, then Space plays and pauses,
arrows step, `[` `]` jump between decisions. Each recording's highlight, its 18 seconds with the most damage dealt,
saves as a video (MP4) or its best 10 seconds as a GIF (public/clips/, made with scripts/clips.ts), to share; any
stretch of it as a custom clip.

## Layout

```
game.ts            the GameDefinition (bench and submissions check)
game.server.ts     the request check the service runs before a model sees a question
shared/engine/     the deterministic simulation (integer math, 60 ticks per second); ENGINE_VERSION
shared/            questions, perception, baselines, fallback, the live match driver, the benchmark (gauntlet.ts),
                   replays, stats
src/               the page: renderer, sound, keyboard, the fight, replay and stats views, clip export
public/            game.json, poster.png, leaderboard.json, baselines.json, demo/, clips/, logos/, audio/
tests/             engine, questions, matches, the benchmark and its verifier, the request check, submissions
scripts/           record-demo.ts: records a match for Watch (a benchmark game, or two decision models)
                   clips.ts: renders each Watch recording's highlight to public/clips (MP4 and GIF; needs ffmpeg and
                   `npm i --no-save @napi-rs/canvas`); run it again after recording a match
```

The sounds and music were generated with ElevenLabs models through Opper's audio API.

## License

MIT, see [LICENSE](LICENSE).
