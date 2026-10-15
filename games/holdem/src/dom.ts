/** Tiny DOM helper: h('div.cls', {attrs}, children...), as the other games' pages use. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K | `${K}.${string}`,
  attrs: Record<string, unknown> | null = null,
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name as K);
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'style' && typeof v === 'object') for (const [prop, value] of Object.entries(v as Record<string, string>)) el.style.setProperty(prop.startsWith('--') ? prop : prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), value);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Resolves after `ms`, or at once for 0. */
export const wait = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * A dialog just shown over the page: marks it modal, moves focus into it (its first button, else the dialog itself),
 * and returns a function that gives focus back to what had it before.
 */
export function focusDialog(root: HTMLElement): () => void {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = root.matches('[role=dialog], [role=alertdialog]') ? root : root.querySelector<HTMLElement>('[role=dialog], [role=alertdialog]');
  if (dialog) {
    dialog.setAttribute('aria-modal', 'true');
    if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1;
  }
  const first = (dialog ?? root).querySelector<HTMLElement>('button:not([disabled]), a[href], select, input');
  (first ?? dialog ?? root).focus({ preventScroll: true });
  return () => {
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
}

/** The visitor asked for less motion. */
export const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
