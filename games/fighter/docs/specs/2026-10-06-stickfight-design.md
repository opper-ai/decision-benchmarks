# Jev Fighter (then called Stickfight): design

Date: 2026-10-06. Status: draft for review.

## 1. Goal

A 2D stick-figure fighting game where each fighter is controlled by a model. It is both a spectacle
(smooth, ink-on-paper animation, readable decisions) and a benchmark harness (repeatable matches,
rich stats, exact replays, a leaderboard).

- First-class players: System One decision models (`typesafe/jev-1.13.0`, `opper/kev-4b`,
  `opper/clef`, `opper/clef-flash`, `berget/convaiinnovations/laya`) via Opper's System One endpoint.
- Any chat LLM on Opper can play through an adapter that asks the same question and forces the same
  output shape.
- Model vs model in v1. The engine accepts a keyboard adapter so human vs model can be added later.

### Success criteria

1. A match between two models plays at 60 Hz with no visible stalls or snapping, at any display
   refresh rate.
2. Any finished match can be replayed frame-identically from its replay file, without calling a
   model.
3. The bench CLI runs N matches per pairing headlessly and produces per-match stats and a
   leaderboard.
4. The viewer shows, for every decision, what the model was asked, its probabilities, latency, cost
   and what happened.

### Non-goals for v1

Human player UI, multiple arenas, per-fighter movesets, two questions per decision (approach C),
online multiplayer, mobile touch controls beyond the viewer.

## 2. Architecture

TypeScript throughout, one repo, one npm package (same layout idea as jevman):

```
shared/      deterministic engine, moves data, question builder, replay codec, stats. No DOM, no Node APIs.
adapters/    model adapters: systemone, chat (LLM), fallback (greedy), keyboard (later)
server/      Node HTTP server: Login with Opper, model proxy, replay storage, leaderboard
src/         browser app: renderer, live match driver, replay viewer, leaderboard page
scripts/     bench CLI, leaderboard CLI, smoke test
tests/
```

- The engine in `shared/` is pure and deterministic. It runs unchanged in Node (bench) and the
  browser (live and replay).
- The renderer only reads engine state. It never feeds anything back into the simulation.
- The server proxies all model calls so keys never reach the browser.

Licensing note: jevman is AGPL-3.0. We read it for ideas only and write our own code against the
public Opper and System One docs. No code is copied unless we choose AGPL for this repo too.

## 3. Engine

### 3.1 Simulation

- Fixed 60 Hz tick. All simulation math in integers (positions in 1/1000 body-length units,
  velocities per tick). No trigonometry or `Math.random` inside the simulation. Randomness comes from
  a seeded PRNG (mulberry32) stored in the state.
- Stage: 10 body-lengths wide, walls at both ends. Fighters start 3 body-lengths apart and never get closer than 0.7.
- Each fighter is a state machine: `idle`, `walk`, `startup`, `active`, `recovery`, `blockstun`,
  `hitstun`, `airborne`, `knockdown`, `getup`, `ko`.
- Collisions: per-move hitbox vs hurtbox rectangles per frame, axis-aligned, in integer units.
- Health 100 per round. Meter 0 to 100, gained by dealing damage (1 per point) and taking it
  (0.5 per point).
- Match: best of 3 rounds, 60 s per round (3600 ticks). Timeout: higher health wins the round; a tie
  is a draw round.
- `engine.step(state, inputs) -> state` is a pure function. `hash(state)` gives a 32-bit FNV-1a hash
  of the canonical state for replay checks.

### 3.2 Moves

Frames are startup / active / recovery. Range is the reach of the hitbox from the body center in
body-lengths. "Height" decides which block stops it.

| id | frames | dmg | range | height | notes |
|---|---|---|---|---|---|
| `jab` | 4/2/8 | 4 | 1.0 | high | fastest move |
| `straight` | 7/3/14 | 8 | 1.2 | high | |
| `low_kick` | 6/3/12 | 6 | 1.1 | low | |
| `high_kick` | 10/4/18 | 12 | 1.4 | high | |
| `uppercut` | 6/4/24 | 14 | 0.95 | high | invulnerable to airborne attacks frames 1 to 8 |
| `sweep` | 11/4/22 | 9 | 1.3 | low | knockdown on hit |
| `throw` | 5/2/20 | 12 | 0.85 | unblockable | whiffs against fighters in startup/active (strike beats throw) |
| `jump_kick` | 34 total, active 14 to 20 | 10 | 1.1 | overhead | must be blocked high; travels 1.5 forward |
| `special` | 9/5/26 | 18 | 2.0 | high | costs 100 meter, absorbs one hit (armor) |
| `jab_straight` | jab then straight | 4+8 | 1.0 | high | combo option; second hit only if first hits |
| `low_kick_sweep` | low kick then sweep | 6+9 | 1.1 | low | combo option; second hit only if first hits |
| `block_high` | stance, min 10 | | | | blocks high and overhead |
| `block_low` | stance, min 10 | | | | blocks low |
| `walk_forward` | 12 | | | | 0.4 body-lengths |
| `walk_back` | 12 | | | | 0.4 body-lengths |
| `backdash` | 18 | | | | invulnerable frames 1 to 6, 1.0 body-lengths |
| `jump` | 34 | | | | neutral jump, dodges lows and throws |

Hit reactions: hitstun = 10 + dmg frames, blockstun = 6 + dmg/2 frames, blocked hits deal no damage.
Knockdown: 40 frames down, 20 frames getup (invulnerable).

The interaction loops this produces: strikes beat throws, throws beat blocks, blocks beat strikes;
high vs low is a guess on block; uppercut beats jump-ins; backdash and jump beat throws and lows.

### 3.3 Decision points

A fighter is **actionable** when it is `idle`, its block stance has met its minimum, or it has just
landed, recovered, left blockstun or finished getup. Hitstun, knockdown and startup/active frames
are not actionable.

When actionable with no pending decision, the fighter runs its **waiting behaviour**: guard up (a
`block_high` stance) with a breathing idle animation. Waiting is vulnerable to lows and throws by
design: slow answers cost something.

## 4. Decisions

### 4.1 Asking early

- When a fighter enters a move's recovery (or blockstun, or getup) with 6 or more frames left, the
  engine predicts the state at the moment it will become actionable and asks the question then.
  This hides latency behind animation already playing.
- **Invalidation.** If before the answer arrives the fighter is hit, or the opponent changes state
  class (starts an attack, jumps, is knocked down), the pending question is cancelled
  (`AbortController`) and a new one is asked from the new predicted state.
- At most one question in flight per fighter. The two fighters' requests are independent.
- An answer is applied on the first tick at which the fighter is actionable and the answer has
  arrived. If the chosen move is illegal at that tick (for example `special` without meter), the
  fallback picks instead.
- **Deadline:** 2000 ms by default (configurable). On timeout, error or invalid answer the fallback
  picks and the decision is flagged `fallback`.

### 4.2 Modes

- `realtime` (default): the simulation runs against the wall clock. Answers land whenever they land.
- `paused`: at each decision point the simulation stops until every pending question for that tick
  has an answer or hits the deadline. Latency is still measured and reported but does not affect
  play.

### 4.3 The question

One System One `choice` question per request.

Context (kept short; Jev bills about 250 tokens of fixed overhead per request):

```
You are the left fighter. You: 62 HP, meter 40, actionable, mid-range.
Opponent: 48 HP, recovering from high_kick (9 frames left), 1.4 body-lengths away, back near wall.
Last exchanges: you blocked low_kick, you blocked low_kick, opponent threw you, you hit jab, opponent whiffed high_kick.
Pick the move most likely to win the next exchange.
```

Options: every legal move, each described with computed facts:

```
uppercut: reaches 0.8, opponent at 1.4 -> whiffs.
straight: hits in 7 frames, opponent committed 9 more -> lands, 8 dmg.
low_kick: hits in 6 frames, opponent committed 9 more -> lands, 6 dmg.
throw: out of range.
block_low: safe vs low_kick and sweep, loses to throw and jump_kick.
...
```

History: the last 5 exchanges. An exchange ends when either fighter is hit, a hit is blocked, or both
fighters are actionable with nothing happening for 30 ticks.

### 4.4 Adapters

All adapters implement:

```ts
interface Adapter {
  id: string;                       // model id, e.g. "typesafe/jev-1.13.0"
  kind: "systemone" | "chat" | "fallback" | "keyboard";
  warmUp(): Promise<void>;
  decide(q: Question, signal: AbortSignal): Promise<Answer>;
}
type Answer = {
  move: MoveId;
  probabilities: Record<MoveId, number> | null; // null = uncalibrated
  latencyMs: number;
  costUsd: number | null;
  inputTokens?: number;
};
```

- `systemone`: POST to Opper's `/v3/compat/v1/systemone` with the context and options. Uses the
  model's returned probabilities and picks the argmax.
- `chat`: Opper compat chat completions with a `json_schema` response format
  `{ "move": enum, "probabilities": { [move]: number } }`. Probabilities are clamped to 0 or more and
  normalized. Missing or unusable probabilities are stored as `null` and the model is marked
  uncalibrated for that decision.
- `fallback` (greedy): if a damaging move lands, pick the highest-damage one; else if the opponent is
  attacking, block that height; else walk toward 1.0 body-lengths.
- Warm-up: every model adapter makes one cheap call before the match, during the ring-entry intro.

## 5. Rendering

- The renderer runs on `requestAnimationFrame` at the display rate and draws an interpolation
  between the previous and current simulation state (alpha = time since last tick / tick length).
  Replay speed 0.25x to 4x changes tick pacing, not animation quality.
- **Skeleton:** 12 joints (head, neck, chest, hips, 2 x shoulder/elbow/hand, 2 x hip/knee/foot).
  Each move has keyframed poses per phase (startup, active, recovery) as joint angles. Poses blend
  with easing; any transition cross-fades over 3 to 6 frames, so nothing snaps.
- **Secondary motion:** damped springs on head, hands and feet (overshoot and follow-through); torso
  leans with velocity; two-bone IK keeps planted feet from sliding.
- **Hit feel:** hit-stop of 3 to 8 frames scaled by damage (an engine feature, so it is in the
  replay), screen shake, ink-splash particles, short motion trails on the striking limb, floor
  cracks on knockdowns.
- **KO:** the skeleton hands off to a Verlet ragdoll seeded from the match seed. It is render-only,
  so it does not need to be bit-identical across browsers.
- **Style:** Canvas 2D, variable-width ink strokes, paper texture with a dot grid, two fighter
  colours (orange and teal). HUD: health bars with an instant drop plus a trailing "ghost" bar,
  round timer, model names, meter.
- **Thought bubble** (toggle `T`): while a fighter's question is in flight, it shows the top 3 options
  of its previous decision fading, then the new top 3 with probabilities when the answer lands.

## 6. Replays

File: `<id>.fight.json.gz`.

```ts
type Replay = {
  format: 1;
  engineVersion: string;            // bumped on any change to moves or rules
  seed: number;
  mode: "realtime" | "paused";
  deadlineMs: number;
  fighters: [FighterMeta, FighterMeta]; // model id, adapter kind, colour
  createdAt: string;
  decisions: Decision[];
  cancellations: { fighter: 0 | 1; askedTick: number; cancelledTick: number }[];
  checkpoints: { tick: number; hash: number }[]; // every 600 ticks and at match end
  result: { winner: 0 | 1 | null; rounds: RoundResult[] };
};
type Decision = {
  fighter: 0 | 1;
  askedTick: number;
  appliedTick: number;              // the only thing wall-clock timing affects
  question: Question;               // context text + options with facts
  answer: Answer;
  fallback: null | "timeout" | "error" | "invalid" | "illegal";
  outcome?: "hit" | "blocked" | "whiffed" | "traded" | "punished" | "neutral"; // filled in after the exchange
};
```

Replay = run the engine from `seed`, applying each decision at its `appliedTick`. Every checkpoint
hash must match, otherwise the viewer reports "replay diverged". Old replays keep working because
each engine version stays importable under `shared/engine/v<N>/`.

Storage: local disk `data/replays/` in v1. Share link `/replay/<id>`.

## 7. Stats and leaderboard

Per match, per fighter:

- Result, rounds, damage dealt and taken, health over time.
- Per move: uses, hit, blocked, whiffed, punished.
- Reads: throw-vs-block wins, high/low guesses right on defense, anti-air success.
- Latency p50, p95, max. Late decisions (answer arrived after the fighter became actionable) and
  total ticks spent waiting. Cancellations.
- Fallback rate by reason.
- Cost total and per decision; input tokens.
- Calibration: reliability curve (chosen-move confidence in 10 bins vs exchange won) and Brier
  score. Uncalibrated decisions are excluded and counted.

Leaderboard: Elo (start 1500, K = 24) per mode, from matches where each pairing is played from both
sides. Columns: Elo, win rate, matches, p50 latency, fallback rate, cost per match, Brier score.
Written to `data/leaderboard-<mode>.json`.

## 8. Surfaces

### 8.1 Bench CLI

```
npm run bench -- --left typesafe/jev-1.13.0 --right opper/kev-4b --matches 10 --mode realtime --deadline 2000
npm run leaderboard -- --models typesafe/jev-1.13.0,opper/kev-4b,opper/clef --matches 10 --mode realtime
```

Headless (no renderer, real wall-clock ticking in realtime mode). Plays each pairing from both sides,
warms each model first, writes replays to `data/replays/`, prints a stats table, updates the
leaderboard. Uses `OPPER_API_KEY` from `.env`.

### 8.2 Web app

- `/`: pick two models, watch the match live, then "watch replay" and the stats tab.
- `/replay/<id>`: replay viewer.
- `/leaderboard`: both modes.
- Not signed in: watch the replay gallery and leaderboard only. Signed in with Login with Opper:
  start live matches billed to the visitor's own wallet. The visitor's key lives in an encrypted
  httpOnly cookie; the browser never sees it.
- Local dev: `OPPER_API_KEY` in `.env` is used when no one is signed in, and only on http://localhost.

### 8.3 Viewer layout

- Fight canvas on top.
- Scrubber below: decision markers per fighter coloured by outcome (hit green, blocked grey,
  punished red, fallback red outline), hit, KO and round markers. Speed 0.25x to 4x, frame step,
  jump to previous or next decision.
- Side panel of decision cards: question text, probability bar per option (chosen one highlighted),
  latency, cost, fallback flag, outcome. Clicking a card seeks to it.
- Stats tab after the match: damage over time, move mix, latency distribution, calibration curve.
- Phone width (390 px): canvas scales to width, side panel stacks below as a list, no horizontal page
  scroll.

## 9. Testing

- Engine unit tests: frame data, each interaction loop (strike beats throw, throw beats block, block
  beats strike, high/low, anti-air), hitstun/blockstun math, timeout rules.
- Determinism: a committed golden replay must reproduce every checkpoint hash. Re-record when the
  engine version bumps.
- Ask-early: predicted actionable state matches the real one when nothing changes; invalidation
  cancels and re-asks.
- Adapters: mocked fetch for System One and chat (valid, malformed JSON, missing probabilities,
  illegal move, timeout, abort).
- Stats: calibration bins and Brier on fixed inputs; Elo on a fixed match list.
- `npm run smoke`: one real call per adapter kind.
- UI: checked in a real browser at desktop width and 390 px before it is called done.

## 10. Later

Approach C (two questions per decision), human vs model with keyboard, more arenas and movesets,
remote replay storage, public deploy under a personal domain, tournament brackets.
