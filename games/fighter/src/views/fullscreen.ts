import { h } from '../dom.ts';

const ENTER = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const EXIT = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Safari before 16.4 (and iPad Safari still) only has the prefixed API; iPhone Safari has none for anything but video.
type Doc = Document & { webkitFullscreenEnabled?: boolean; webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type El = HTMLElement & { webkitRequestFullscreen?: () => void };
const doc = document as Doc;
const current = () => doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;

/** Whether this browser can put an element (not just a video) in fullscreen. */
export const fullscreenSupported = () => Boolean(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);

/**
 * The fullscreen switch for `target` (the stage and its controls): hidden where the browser cannot do it. Esc leaves
 * fullscreen (the browser's own). `destroy` drops the listener and leaves fullscreen if the view goes while in it.
 */
export function fullscreenButton(target: HTMLElement): { el: HTMLButtonElement; exit: () => void; destroy: () => void } {
  const el = h('button.fbtn.icon.fs-btn', { type: 'button', 'aria-label': 'Fullscreen', title: 'Fullscreen', html: ENTER }) as HTMLButtonElement;
  el.hidden = !fullscreenSupported();
  const exit = () => {
    if (current() !== target) return;
    if (document.exitFullscreen) void document.exitFullscreen().catch(() => {});
    else doc.webkitExitFullscreen?.();
  };
  el.addEventListener('click', () => {
    if (current() === target) return exit();
    const t = target as El;
    if (t.requestFullscreen) void t.requestFullscreen().catch(() => {});
    else t.webkitRequestFullscreen?.();
  });
  const sync = () => {
    const on = current() === target;
    el.innerHTML = on ? EXIT : ENTER;
    el.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
    el.title = on ? 'Exit fullscreen (Esc)' : 'Fullscreen';
    target.classList.toggle('is-fullscreen', on);
  };
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
  return {
    el,
    exit,
    destroy: () => {
      exit();
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    },
  };
}
