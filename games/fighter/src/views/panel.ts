import { h } from '../dom.ts';

const STORE = 'fighter.panel';
const CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const remembered = (): boolean => {
  try {
    return localStorage.getItem(STORE) === 'collapsed';
  } catch {
    return false;
  }
};

/**
 * The decisions and stats panel, foldable: a collapsed panel keeps only its header, under the stage, so the stage takes
 * the whole width. The choice is remembered per browser (expanded by default). Clicking a tab opens it again.
 */
export function collapsiblePanel(viewer: HTMLElement, tabs: HTMLElement[], body: HTMLElement): HTMLElement {
  const toggle = h('button.panel-toggle', { type: 'button', html: CHEVRON }) as HTMLButtonElement;
  const id = `panel-body-${Math.random().toString(36).slice(2, 8)}`;
  body.id = id;
  toggle.setAttribute('aria-controls', id);
  const set = (collapsed: boolean, save: boolean) => {
    viewer.classList.toggle('panel-collapsed', collapsed);
    body.hidden = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Show the decisions panel' : 'Hide the decisions panel');
    toggle.title = collapsed ? 'Show the panel' : 'Hide the panel';
    if (!save) return;
    try {
      localStorage.setItem(STORE, collapsed ? 'collapsed' : 'expanded');
    } catch {
      // storage blocked: the choice lasts this page only
    }
  };
  toggle.addEventListener('click', () => set(!viewer.classList.contains('panel-collapsed'), true));
  for (const t of tabs) t.addEventListener('click', () => viewer.classList.contains('panel-collapsed') && set(false, true));
  set(remembered(), false);
  return h('aside.panel', null, h('div.tabs', null, ...tabs, h('span.spacer'), toggle), body);
}
