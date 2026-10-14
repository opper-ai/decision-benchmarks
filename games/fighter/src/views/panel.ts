import { h } from '../dom.ts';

const STORE = 'fighter.activity';
const CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const remembered = (): boolean => {
  try {
    return localStorage.getItem(STORE) === 'open';
  } catch {
    return false;
  }
};

/**
 * Activity: the decisions, the stats and the match's facts, in a drawer that folds out downward from a tab hanging under
 * the stage, so the stage always keeps its size. Closed by default; the choice is remembered per browser. `onOpen` runs
 * whenever it opens (and at once if it is open), for what can only be laid out while it shows.
 */
export function activityDrawer(viewer: HTMLElement, body: HTMLElement): { tab: HTMLButtonElement; drawer: HTMLElement; onOpen: (fn: () => void) => void } {
  const id = `activity-${Math.random().toString(36).slice(2, 8)}`;
  const drawer = h('section.drawer', { id, 'aria-label': 'Activity' }, body);
  const tab = h('button.act-tab', { type: 'button', 'aria-controls': id }, h('span', null, 'Activity'), h('span.chev', { html: CHEVRON })) as HTMLButtonElement;
  const listeners: (() => void)[] = [];
  const set = (open: boolean, save: boolean) => {
    viewer.classList.toggle('act-open', open);
    drawer.hidden = !open;
    tab.setAttribute('aria-expanded', String(open));
    tab.title = open ? 'Fold the activity away' : 'Decisions, key moments and stats';
    if (open) for (const fn of listeners) fn();
    if (!save) return;
    try {
      localStorage.setItem(STORE, open ? 'open' : 'closed');
    } catch {
      // storage blocked: the choice lasts this page only
    }
  };
  tab.addEventListener('click', () => set(drawer.hidden !== false, true));
  drawer.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    set(false, true);
    tab.focus();
  });
  set(remembered(), false);
  return {
    tab,
    drawer,
    onOpen: (fn) => {
      listeners.push(fn);
      if (!drawer.hidden) fn();
    },
  };
}
