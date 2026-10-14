import { h } from '../dom.ts';
import type { FighterMeta } from '../../shared/replay.ts';
import { SIDES } from '../theme.ts';

const stroke = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** The stage's icons, drawn in currentColor on a 24 px grid. */
export const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>',
  thoughts: stroke('<path d="M4 5h16v11h-9l-5 4v-4H4z"/>'),
  clip: stroke('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M3 15h18M8 5v4M16 5v4M8 15v4M16 15v4"/>'),
  download: stroke('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  link: stroke('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  prev: stroke('<path d="M6 5v14M18 5 8 12l10 7z"/>'),
  next: stroke('<path d="M18 5v14M6 5l10 7-10 7z"/>'),
  scissors: stroke('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>'),
};

/** A square tool button for the stage's floor. */
export function toolButton(label: string, html: string): HTMLButtonElement {
  return h('button.tbtn', { type: 'button', 'aria-label': label, title: label, html }) as HTMLButtonElement;
}

/**
 * A tool that opens a small menu above it (sound, speed, save): its button opens and closes it, a click elsewhere, Esc
 * or picking an item closes it. `wrap`, when given, already holds the button (a Watch chip's ⤓ sits in its chip); the
 * menu goes in it. `destroy` drops the page-wide listener.
 */
export function menuTool(btn: HTMLButtonElement, menu: HTMLElement, wrap?: HTMLElement): { el: HTMLElement; close: () => void; destroy: () => void } {
  menu.classList.add('tmenu');
  menu.setAttribute('role', 'menu');
  btn.setAttribute('aria-haspopup', 'menu');
  const open = (on: boolean) => {
    menu.hidden = !on;
    btn.setAttribute('aria-expanded', String(on));
  };
  open(false);
  btn.addEventListener('click', () => open(menu.hidden !== false));
  const el = wrap ?? h('span.tool-menu', null, btn);
  el.classList.add('tool-menu');
  el.append(menu);
  // A download or an action closes the menu once picked; a switch (sound's) keeps it open.
  menu.addEventListener('click', (e) => {
    if ((e.target as Element).closest('a, [role="menuitem"], [role="menuitemradio"]')) setTimeout(() => open(false));
  });
  const outside = (e: PointerEvent) => {
    if (!el.contains(e.target as Node)) open(false);
  };
  document.addEventListener('pointerdown', outside);
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || menu.hidden) return;
    e.stopPropagation();
    open(false);
    btn.focus();
  });
  return { el, close: () => open(false), destroy: () => document.removeEventListener('pointerdown', outside) };
}

/**
 * The stage as both views show it (a recording, a live fight), after jevman's cabinet: the paper stage, and on its floor
 * (the band under the ground line) who is on at the left, the page's one primary button in the middle and the tools at
 * the right. The tools show while the pointer is over the stage or it is paused, and always on a touch screen. On a
 * phone the floor is too short for them: the tools and the button move under the stage. `box` is what goes fullscreen;
 * `frame` holds the stage and its floor, for what covers both (a match's result).
 */
export function stageShell(fstage: HTMLElement, label: Node | null, cta: HTMLElement | null): { box: HTMLElement; frame: HTMLElement; tools: HTMLElement } {
  const tools = h('div.tools', { role: 'toolbar', 'aria-label': 'Playback' });
  const frame = h('div.stage-frame', null, fstage, h('div.floor-ui', null, h('div.floor-label', null, label), h('div.floor-cta', null, cta), tools));
  const box = h('div.stage-box', null, frame);
  return { box, frame, tools };
}

/** "● REPLAY  Luna vs Jev": what the floor says is on. */
export function floorLabel(tag: string, fighters: readonly [FighterMeta, FighterMeta], live = false): HTMLElement {
  return h(
    'span.floor-on',
    null,
    h(live ? 'span.floor-tag.live' : 'span.floor-tag', null, h('i', { 'aria-hidden': 'true' }), tag),
    h('span.floor-names', null, h('span', { style: { color: SIDES[0].deep } }, fighters[0].label), h('span.vs', null, ' vs '), h('span', { style: { color: SIDES[1].deep } }, fighters[1].label)),
  );
}
