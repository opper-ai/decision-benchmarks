import type { Adapter, HumanInput } from '../shared/adapter.ts';
import { legalMoves, type GameState, type Side } from '../shared/engine/engine.ts';
import type { MoveId } from '../shared/engine/moves.ts';

/** A key pressed this long before the fighter is free still counts (as in most fighting games). */
export const BUFFER_MS = 150;
/** Two taps of a direction within this long: a dash (forward) or a backdash. */
export const DOUBLE_TAP_MS = 250;

/** Attack keys, by KeyboardEvent.code so they sit in the same place on every layout. */
export const ATTACK_KEYS: Record<string, MoveId> = {
  // As in Street Fighter and Tekken on a keyboard: punches on the top row, kicks below.
  KeyU: 'jab',
  KeyI: 'straight',
  KeyO: 'uppercut',
  KeyJ: 'low_kick',
  KeyK: 'high_kick',
  KeyL: 'sweep',
  KeyH: 'throw',
  KeyY: 'jump_kick',
  Space: 'special',
};
/** With Shift: the two-hit strings. */
export const SHIFT_KEYS: Record<string, MoveId> = { KeyU: 'jab_straight', KeyJ: 'low_kick_sweep' };

type Dir = 'left' | 'right' | 'up' | 'down';
const DIR_KEYS: Record<string, Dir> = {
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
};

/** The controls as shown to the player. */
export const CONTROLS: [string, string][] = [
  ['A D  (or ← →)', 'walk; hold back to block high; double-tap: dash / backdash'],
  ['W  (or ↑)', 'jump'],
  ['S  (or ↓)', 'block low (hold)'],
  ['U I O', 'punches: jab, straight, uppercut (Shift+U: jab, straight)'],
  ['J K L', 'kicks: low kick, high kick, sweep (Shift+J: low kick, sweep)'],
  ['H', 'throw'],
  ['Y', 'jump kick'],
  ['Space', 'special (when the meter is full)'],
];

/**
 * What the keyboard asks for, independent of the DOM so it can be tested. Directions are screen
 * directions; the left fighter's forward is right, the right fighter's is left (they never cross).
 */
export class KeyState implements HumanInput {
  private held = new Map<Dir, number>();
  /** The last press: a move, or a double-tap whose meaning depends on which way the fighter faces. */
  private pressed: { move: MoveId | 'dash_left' | 'dash_right'; at: number } | null = null;
  private lastTap: { dir: Dir; at: number } | null = null;

  down(code: string, shift: boolean, at: number, repeat = false): boolean {
    const dir = DIR_KEYS[code];
    if (dir) {
      if (repeat) return true;
      if (!this.held.has(dir)) this.held.set(dir, at);
      if ((dir === 'left' || dir === 'right') && this.lastTap?.dir === dir && at - this.lastTap.at < DOUBLE_TAP_MS) {
        this.pressed = { move: dir === 'left' ? 'dash_left' : 'dash_right', at };
        this.lastTap = null;
      } else {
        if (dir === 'up') this.pressed = { move: 'jump', at };
        this.lastTap = { dir, at };
      }
      return true;
    }
    const move = (shift && SHIFT_KEYS[code]) || ATTACK_KEYS[code];
    if (!move) return false;
    if (!repeat) this.pressed = { move, at };
    return true;
  }

  up(code: string): void {
    const dir = DIR_KEYS[code];
    if (dir) this.held.delete(dir);
  }

  clear(): void {
    this.held.clear();
    this.pressed = null;
    this.lastTap = null;
  }

  /** `now` lets the buffer expire; tests pass their own clock. */
  now: () => number = () => performance.now();

  next(s: GameState, i: Side, consume: boolean): { move: MoveId; at: number } | null {
    const legal = legalMoves(s, i);
    const forward: Dir = i === 0 ? 'right' : 'left';
    const toMove = (m: MoveId | 'dash_left' | 'dash_right'): MoveId => (m === 'dash_left' || m === 'dash_right' ? (m === `dash_${forward}` ? 'dash_forward' : 'backdash') : m);
    // A fresh press wins over anything held.
    if (this.pressed && this.now() - this.pressed.at <= BUFFER_MS) {
      const move = toMove(this.pressed.move);
      if (legal.includes(move)) {
        const at = this.pressed.at;
        if (consume) this.pressed = null;
        return { move, at };
      }
    }
    const hold = (dir: Dir) => this.held.get(dir);
    const pick = (move: MoveId, at: number | undefined) => (at !== undefined && legal.includes(move) ? { move, at } : null);
    const back: Dir = forward === 'right' ? 'left' : 'right';
    return (
      pick('block_low', hold('down')) ??
      // Walking back guards high; against the wall it becomes a standing guard.
      pick('walk_back', hold(back)) ??
      pick('block_high', hold(back)) ??
      pick('walk_forward', hold(forward))
    );
  }
}

/** The page's keyboard, wired to a KeyState while a fight with a human is on. */
class Keyboard {
  readonly keys = new KeyState();
  private active = false;

  constructor() {
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return Boolean(t && (t.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName)));
    };
    window.addEventListener('keydown', (e) => {
      if (!this.active || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (this.keys.down(e.code, e.shiftKey, performance.now(), e.repeat)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.up(e.code));
    // Keys released while the window was not focused would stay held.
    window.addEventListener('blur', () => this.keys.clear());
  }

  start(): void {
    this.keys.clear();
    this.active = true;
  }

  stop(): void {
    this.active = false;
    this.keys.clear();
  }
}

let keyboard: Keyboard | null = null;
export function getKeyboard(): Keyboard {
  keyboard ??= new Keyboard();
  return keyboard;
}

/** The player's fighter. */
export function humanAdapter(): Adapter {
  const kb = getKeyboard();
  return {
    id: 'human',
    kind: 'human',
    warmUp: async () => {},
    decide: () => Promise.reject(new Error('a human player is never asked')),
    human: kb.keys,
  };
}
