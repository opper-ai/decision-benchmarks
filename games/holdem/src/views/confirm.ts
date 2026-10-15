// A small question over the table ("Leave this table?"): two buttons, the safe one focused. Esc, or the safe button,
// keeps things as they are; Enter on the other does it. Focus stays inside while it is open and returns to where it
// was when it closes, as with the other dialogs. An .overlay, so the action bar's keys are off meanwhile.
import { h } from '../dom.ts';

let ids = 0;

export function confirmDialog(o: { title: string; text: string; yes: string; no: string; onYes(): void; onNo?(): void }): HTMLElement {
  const id = `confirm-${++ids}`;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const close = () => {
    veil.remove();
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
  const no = h('button.cta.quiet', { type: 'button', onclick: () => (close(), o.onNo?.()) }, o.no) as HTMLButtonElement;
  const yes = h('button.cta', { type: 'button', onclick: () => (veil.remove(), o.onYes()) }, o.yes) as HTMLButtonElement;
  const box = h(
    'div.poster.confirm',
    { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': `${id}-t`, 'aria-describedby': `${id}-d`, tabindex: '-1' },
    h('h2', { id: `${id}-t` }, o.title),
    h('p.sub', { id: `${id}-d` }, o.text),
    h('div.row', null, no, yes),
  );
  const veil = h('div.overlay.confirm-veil', null, box);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      o.onNo?.();
    } else if (e.key === 'Tab') {
      // Two buttons: Tab and Shift+Tab go from one to the other.
      e.preventDefault();
      (document.activeElement === no ? yes : no).focus();
    }
  });
  // A tap on the dimmed table around it keeps playing.
  veil.addEventListener('pointerdown', (e) => {
    if (e.target === veil) {
      close();
      o.onNo?.();
    }
  });
  queueMicrotask(() => no.focus({ preventScroll: true }));
  return veil;
}
