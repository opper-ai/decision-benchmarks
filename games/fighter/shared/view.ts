import { clone, step, type GameState, type Inputs, type Side } from './engine/engine.ts';
import { REACTION_TICKS } from './question.ts';

/**
 * What each fighter can see. A fighter knows its own state exactly, but sees its opponent with a
 * reaction delay: the opponent as it was REACTION_TICKS ago, carried forward to now assuming it started
 * nothing new since (the fighter's own inputs in that window are replayed, since it knows them).
 * Health, meter, round and clock are on screen, so they are current.
 */
export class Perception {
  /** States before each of the last REACTION_TICKS steps, oldest first, with the inputs applied. */
  private past: { state: GameState; inputs: Inputs }[] = [];

  /** Call before every step with the state about to be stepped and that step's inputs. */
  record(state: GameState, inputs: Inputs): void {
    this.past.push({ state: clone(state), inputs: [...inputs] as Inputs });
    if (this.past.length > REACTION_TICKS) this.past.shift();
  }

  view(current: GameState, i: Side): GameState {
    if (this.past.length < REACTION_TICKS) return current;
    const j = (1 - i) as Side;
    const v = clone(this.past[0].state);
    const history = v.history;
    for (const p of this.past) {
      const inputs: Inputs = [null, null];
      inputs[i] = p.inputs[i];
      step(v, inputs);
    }
    v.fighters[i] = structuredClone(current.fighters[i]);
    v.fighters[j].hp = current.fighters[j].hp;
    v.fighters[j].meter = current.fighters[j].meter;
    v.round = structuredClone(current.round);
    v.wins = [...current.wins] as [number, number];
    v.results = structuredClone(current.results);
    v.winner = current.winner;
    v.hitstop = current.hitstop;
    v.tick = current.tick;
    v.rng = current.rng;
    // What has happened is also seen with the delay.
    v.history = history;
    // Mixing two moments can leave them overlapping; they never do in the game.
    const [a, b] = v.fighters;
    if (b.x - a.x < 700) {
      if (i === 0) b.x = a.x + 700;
      else a.x = b.x - 700;
    }
    return v;
  }
}
