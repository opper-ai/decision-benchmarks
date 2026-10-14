// Who can fight on this page, and who pays: you at the keyboard, a baseline (runs in the browser, free), or a decision
// model through the game's server (the free credits while they last, else your own Opper account once signed in, or the
// local key from .env on a developer's machine). No API key ever reaches the browser.
import type { TransportHooks } from '../../../packages/kit/client/transport.ts';
import type { Adapter } from '../shared/adapter.ts';
import { baselineAdapter, isBaseline } from '../shared/baselines.ts';
import { modelInfo } from '../shared/models.ts';
import type { FighterMeta } from '../shared/replay.ts';
import { modelAdapter, type Me } from './api.ts';
import { humanAdapter } from './input.ts';

/** The picker's value for you at the keyboard. */
export const HUMAN = 'human';

export type Source = 'human' | 'baseline' | 'model';

export interface Plan {
  source: Source;
  /** Who pays, or how it plays, shown under the picker. */
  note: string;
  /** Why it cannot play now, if it cannot. */
  problem: string | null;
  meta: (color: string) => FighterMeta;
  adapter: (baselineLatencyMs: number) => Adapter;
}

/** Why no model can play for this visitor right now, or null when one can. */
export function modelProblem(me: Me): string | null {
  if (me.mode === 'player' || me.mode === 'dev') return null;
  if (me.mode === 'pool') return me.pool?.open === false ? 'The free credits are used up. Sign in with Opper to play the models on your own account.' : null;
  if (me.unavailable) return "Couldn't reach the server, so no model can play right now. Watch a recorded match instead.";
  if (me.loginAvailable) return 'Sign in with Opper to let a model play. Or watch a recorded match.';
  return 'No model can play here: this server has no free credits and no Login with Opper. Watch a recorded match instead.';
}

/** Who pays for a model fighter, as its picker says it. */
function payer(me: Me): string {
  if (me.mode === 'player') return `Your Opper account${me.user?.email ? ` (${me.user.email})` : ''}`;
  if (me.mode === 'dev') return 'The local key from .env';
  return 'Free credits';
}

export function planFighter(choice: string, me: Me, hooks: TransportHooks): Plan {
  if (choice === HUMAN) {
    return {
      source: 'human',
      note: 'You, with the keyboard.',
      problem: null,
      meta: (color) => ({ model: HUMAN, label: 'You', kind: 'human', color, via: 'human' }),
      adapter: () => humanAdapter(),
    };
  }
  const info = modelInfo(choice);
  if (isBaseline(choice)) {
    return {
      source: 'baseline',
      note: 'Runs in your browser: free.',
      problem: null,
      meta: (color) => ({ model: choice, label: info.label, kind: info.kind, color }),
      adapter: (ms) => baselineAdapter(choice, ms),
    };
  }
  const problem = modelProblem(me);
  return {
    source: 'model',
    note: problem ? 'Not available yet' : payer(me),
    problem,
    meta: (color) => ({ model: choice, label: info.label, kind: info.kind, color, via: 'server' }),
    adapter: () => modelAdapter(choice, hooks),
  };
}
