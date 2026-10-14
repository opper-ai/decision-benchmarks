import { audio } from '../audio.ts';
import { h } from '../dom.ts';

const SPEAKER = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
const NOTE = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M9 18V6l11-2v12" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="17.5" cy="16" r="2.5" fill="currentColor"/></svg>';

let made: HTMLElement | null = null;

/**
 * The sound tool on the stage's floor: one speaker that opens the two switches, sound effects and music. One for the
 * page, moved into whichever view shows (a recording or a fight).
 */
export function soundTool(): HTMLElement {
  if (made) return made;
  const option = (key: 'sound' | 'music', label: string, icon: string) => {
    const b = h('button.snd-opt', { type: 'button', role: 'menuitemcheckbox', 'aria-checked': String(audio.settings[key]) }, h('span.snd-icon', { html: icon }), h('span', null, label));
    b.addEventListener('click', () => audio.set({ [key]: !audio.settings[key] }));
    audio.onChange(() => b.setAttribute('aria-checked', String(audio.settings[key])));
    return b;
  };
  const menu = h('div.snd-menu', { role: 'menu', 'aria-label': 'Sound', hidden: true }, option('sound', 'Sound effects', SPEAKER), option('music', 'Music', NOTE));
  const btn = h('button.tbtn', { type: 'button', 'aria-label': 'Sound and music', title: 'Sound and music', 'aria-haspopup': 'menu', 'aria-expanded': 'false', html: SPEAKER }) as HTMLButtonElement;
  const sync = () => btn.classList.toggle('muted', !audio.settings.sound && !audio.settings.music);
  audio.onChange(sync);
  sync();
  const open = (on: boolean) => {
    menu.hidden = !on;
    btn.setAttribute('aria-expanded', String(on));
  };
  btn.addEventListener('click', () => open(menu.hidden !== false));
  const wrap = h('span.snd', null, btn, menu);
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target as Node)) open(false);
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || menu.hidden) return;
    e.stopPropagation();
    open(false);
    btn.focus();
  });
  made = wrap;
  return made;
}
