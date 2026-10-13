import { audio } from '../audio.ts';
import { h } from '../dom.ts';

const SPEAKER = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
const NOTE = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M9 18V6l11-2v12" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="17.5" cy="16" r="2.5" fill="currentColor"/></svg>';

let made: HTMLElement | null = null;

/** The sound and music switches: one pair for the page, moved into whichever view shows (a recording or a fight). */
export function audioToggles(): HTMLElement {
  if (made) return made;
  const toggle = (key: 'sound' | 'music', label: string, icon: string) => {
    const b = h('button.fbtn.icon.toggle', { type: 'button', 'aria-pressed': String(audio.settings[key]), 'aria-label': label, title: `${label} on or off`, html: icon });
    b.addEventListener('click', () => audio.set({ [key]: !audio.settings[key] }));
    audio.onChange(() => b.setAttribute('aria-pressed', String(audio.settings[key])));
    return b;
  };
  made = h('span.audio-toggles', null, toggle('sound', 'Sound', SPEAKER), toggle('music', 'Music', NOTE));
  return made;
}
