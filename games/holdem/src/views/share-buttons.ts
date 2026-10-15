// Buttons that share a finished game to X and LinkedIn (a composer in a new window, text and link prefilled), and its
// image: through the device's own share sheet where it takes files (phones:
// straight into the X or LinkedIn app with the picture), else copied to the clipboard to paste into a post.
import { track } from '../../../../packages/kit/client/track.ts';
import { h } from '../dom.ts';
import { linkedInUrl, xIntentUrl, type ShareSource } from '../social.ts';

type Kind = 'result' | 'game';

/** Small line icons for the share buttons (16px, currentColor), by name. */
const ICONS = {
  x: '<path d="M5 4l14 16M19 4L5 20" stroke-width="2.2"/>',
  linkedin: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M8 10.5V17M8 7.2v.1M11.5 17v-6.5M11.5 13.5c0-2 1.2-3 2.7-3s2.3 1 2.3 3V17" stroke-width="2"/>',
  share: '<path d="M12 15V3.5M8 7.5l4-4 4 4"/><path d="M6 11H5v9.5h14V11h-1"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5.5-5 4 3.5 2.5-2 4 3.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2"/>',
  download: '<path d="M12 3.5V15M7.5 10.5L12 15l4.5-4.5M4.5 19.5h15"/>',
  clip: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M10 9.2v5.6l4.6-2.8z" fill="currentColor"/>',
} as const;
export type IconName = keyof typeof ICONS;

/** A share icon, hidden from screen readers (the button's words say it). */
export function icon(name: IconName): HTMLElement {
  const el = h('span.ic', { 'aria-hidden': 'true' });
  el.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return el;
}

/** A button's face: its icon and its words, and fewer words for a phone's narrow button when given. */
export const face = (name: IconName, words: string, short?: string): HTMLElement[] => [
  icon(name),
  short ? h('span.lbl', null, h('span.long', null, words), h('span.short', null, short)) : h('span.lbl', null, words),
];

/** Opens a composer in a new window, never with access back to this page. */
function open(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** "Post on X" and "LinkedIn" for a text and a link (read when clicked, so they can be made late). */
export function networkButtons(o: { text: () => string; url: () => string; kind: Kind; source: ShareSource; cls: string }): HTMLElement[] {
  const share = (network: 'x' | 'linkedin') => {
    const text = o.text();
    const url = o.url();
    track('share', { game: 'holdem', kind: o.kind, network, source: o.source });
    open(network === 'x' ? xIntentUrl(text, url) : linkedInUrl(text, url));
  };
  return [
    h(`button.${o.cls}`, { type: 'button', 'data-network': 'x', onclick: () => share('x') }, ...face('x', 'Post on X')),
    h(`button.${o.cls}`, { type: 'button', 'data-network': 'linkedin', 'aria-label': 'Share on LinkedIn', onclick: () => share('linkedin') }, ...face('linkedin', 'LinkedIn')),
  ];
}

/** The device can share files through its own share sheet (Web Share level 2). */
export const canShareFiles = (): boolean => {
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([new Uint8Array(1)], 'x.png', { type: 'image/png' })] });
  } catch {
    return false;
  }
};

/** The clipboard takes images (ClipboardItem with image/png). */
export const canCopyImage = (): boolean => {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
  const supports = (ClipboardItem as unknown as { supports?: (type: string) => boolean }).supports;
  return typeof supports !== 'function' || supports('image/png');
};

/**
 * The finished game's picture for a post: "Share…" with the image, text and link through the device's share sheet, or
 * "Copy image" to paste into the composer. Null when the browser can do neither (Download image remains).
 */
export function imageShareButton(o: { image: () => Promise<Blob>; text: () => string; url: () => string; source: ShareSource; say: (t: string) => void; cls: string }): HTMLButtonElement | null {
  if (canShareFiles()) {
    const b = h(`button.${o.cls}`, { type: 'button' }, ...face('share', 'Share…')) as HTMLButtonElement;
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const file = new File([await o.image()], 'ai-holdem.png', { type: 'image/png' });
        await navigator.share({ files: [file], text: `${o.text()} ${o.url()}` });
        track('share', { game: 'holdem', kind: 'result', network: 'device', source: o.source });
      } catch (e) {
        if ((e as Error).name !== 'AbortError') o.say(`Sharing did not work: ${(e as Error).message}`);
      } finally {
        b.disabled = false;
      }
    });
    return b;
  }
  if (canCopyImage()) {
    const b = h(`button.${o.cls}`, { type: 'button' }, ...face('image', 'Copy image')) as HTMLButtonElement;
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        // The promise goes into the item, so Safari keeps the click's permission while the image is drawn.
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': o.image() })]);
        track('share', { game: 'holdem', kind: 'image', network: 'clipboard', source: o.source });
        o.say('Image copied: paste it into your post.');
      } catch (e) {
        o.say(`The image could not be copied: ${(e as Error).message}`);
      } finally {
        b.disabled = false;
      }
    });
    return b;
  }
  return null;
}
