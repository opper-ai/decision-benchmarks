import { appPath } from '../../../../packages/kit/client/paths.ts';
import { tag } from '../../../../packages/kit/client/track.ts';
import { ReplayPlayer, type Replay } from '../../shared/replay.ts';
import { CLIPS } from '../clips.ts';
import { h } from '../dom.ts';
import { clipName, exportClip, exportSupported } from '../export.ts';
import { highlightTicks } from '../highlight.ts';
import { ICONS } from './shell.ts';

// Saving a match to share it, as on jevman: its highlight as a video (MP4) or a GIF. A recorded match has both, made
// ahead by scripts/clips.ts (public/clips); the match just played makes its video here, in the browser.

export type Clip = (typeof CLIPS)[string];

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

/** A recorded match's highlight in public/clips, when it has one. */
export const clipFor = (demoFile: string | null | undefined): Clip | null => (demoFile ? (CLIPS[demoFile] ?? null) : null);

/** A link that downloads a recorded match's highlight, the 18 s video or the 10 s GIF: a menu row, or a pill. */
export function clipLink(clip: Clip, format: 'mp4' | 'gif', source: string, look: 'menu' | 'pill' = 'menu'): HTMLAnchorElement {
  const menu = look === 'menu';
  const a = h(
    menu ? 'a.tmenu-opt' : 'a.fbtn',
    { href: appPath(`clips/${clip.file}.${format}`), download: `jev-fighter-${clip.file}-highlight.${format}`, role: menu ? 'menuitem' : undefined },
    h(menu ? 'span.tmenu-icon' : 'span.ico', { html: ICONS.download }),
    h('span', null, format === 'mp4' ? 'Video' : 'GIF'),
    h(menu ? 'small' : 'span.ext', null, format === 'mp4' ? `MP4 · ${mb(clip.mp4)}` : `10 s · ${mb(clip.gif)}`),
  );
  return tag(a, 'click_download', { source, format, clip: clip.file });
}

/**
 * A button that makes a video of a match's highlight (its best 18 seconds, with its sound) in the browser and saves
 * it: for the match just played, which has no clip made ahead. Its progress shows on it; a menu stays open meanwhile.
 */
export function videoButton(r: Replay, source: string, look: 'menu' | 'pill' | 'big' = 'menu'): HTMLButtonElement {
  const idle = 'MP4 · best 18 s';
  const meta = h(look === 'menu' ? 'small' : 'span.ext', null, idle);
  const b = h(
    look === 'menu' ? 'button.tmenu-opt' : look === 'big' ? 'button.fbtn.big' : 'button.fbtn',
    { type: 'button', title: 'Its best 18 seconds as a video, made in your browser' },
    h(look === 'menu' ? 'span.tmenu-icon' : 'span.ico', { html: ICONS.download }),
    h('span', null, look === 'big' ? 'Save video' : 'Video'),
    meta,
  ) as HTMLButtonElement;
  if (!exportSupported()) {
    b.disabled = true;
    b.title = 'This browser cannot make videos: use a recent Chrome, Edge or Safari.';
    return b;
  }
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const player = new ReplayPlayer(r);
      const { from, to } = highlightTicks(player, 30);
      const blob = await exportClip(r, player, {
        from,
        to,
        width: 1280,
        height: 720,
        fps: 30,
        sound: true,
        music: true,
        bubbles: true,
        onProgress: (f) => (meta.textContent = `Making it… ${Math.round(f * 100)}%`),
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = clipName(r, from);
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      meta.textContent = 'Saved';
    } catch {
      meta.textContent = "Couldn't make it: try again";
    } finally {
      b.disabled = false;
      setTimeout(() => (meta.textContent = idle), 2500);
    }
  });
  return tag(b, 'click_download', { source, format: 'mp4', clip: 'your-match' });
}
