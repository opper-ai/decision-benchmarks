// "Show thinking": what the models say and why, as they play, built to scan. Newest on top, under a small header per
// hand and street; each entry the face and name, the move as a coloured chip, the spoken line as a quote, and the
// reasoning under it in a quieter voice. Empty, it says why (decision models give no words, only their tell meters).
// The game (main.ts) and replays (replay-view.ts) both use it.
import type { HandEvent, Street } from '../../shared/engine.ts';
import type { ActionMeta } from '../../shared/table.ts';
import { h } from '../dom.ts';
import { actionChip, logNote, STREET_NAMES, type SeatPerson } from '../view-model.ts';
import { avatarEl } from './parts.ts';

/** At most this many entries are kept (the oldest go). */
const KEEP = 40;

type ActionEvent = Extract<HandEvent, { type: 'action' }>;

/** The street an action was played on: the last street dealt before it in the hand's events. */
export function streetOf(events: readonly HandEvent[], act: ActionEvent): Street {
  let street: Street = 'preflop';
  for (const e of events) {
    if (e === act) break;
    if (e.type === 'street') street = e.street;
  }
  return street;
}

/** A chip with the move: its words in a colour for what it does (fold, check or call, bet or raise, all-in). */
export function chipEl(act: Pick<ActionEvent, 'kind' | 'to' | 'add' | 'allIn'>): HTMLElement {
  const c = actionChip(act);
  return h(`span.act-chip.t-${c.tone}`, null, c.label);
}

export class ThinkingLog {
  readonly el: HTMLElement;
  private note: HTMLElement;
  private groups: HTMLElement;
  private current: { key: string; items: HTMLElement } | null = null;
  private count = 0;

  constructor(o: { label: string; people: readonly SeatPerson[] }) {
    this.note = h('p.log-note', null, logNote(o.people.map((p) => p.style)));
    this.groups = h('div.log-groups');
    this.el = h('div.log', { hidden: true, role: 'log', 'aria-label': o.label }, this.note, this.groups);
  }

  /** An action with words (table talk, reasoning); one without any is not logged. */
  add(o: { hand: number; events: readonly HandEvent[]; act: ActionEvent; person: SeatPerson; meta: ActionMeta }): void {
    const { meta, act, person } = o;
    if (!meta.say && !meta.reasoning) return;
    const street = streetOf(o.events, act);
    const key = `${o.hand}:${street}`;
    if (this.current?.key !== key) {
      const items = h('div.log-items');
      this.groups.prepend(h('section.log-group', null, h('h4.log-head', null, `Hand ${o.hand}`, h('span', null, STREET_NAMES[street])), items));
      this.current = { key, items };
    }
    this.current.items.prepend(
      h(
        'article.log-entry',
        null,
        avatarEl(person, meta.mood ?? 'relaxed', 'log-face'),
        h('div.log-main', null, h('div.log-line', null, h('b', null, person.name), chipEl(act)), meta.say ? h('q.log-said', null, meta.say) : null, meta.reasoning ? h('p.log-why', null, meta.reasoning) : null),
      ),
    );
    this.note.hidden = true;
    if (++this.count > KEEP) this.trim();
  }

  /** The oldest entries go, and a hand's header with them once it has none. */
  private trim(): void {
    while (this.count > KEEP) {
      const last = this.groups.lastElementChild;
      const items = last?.querySelector('.log-items');
      if (!last || !items) return;
      items.lastElementChild?.remove();
      this.count--;
      if (!items.childElementCount) last.remove();
    }
  }
}
