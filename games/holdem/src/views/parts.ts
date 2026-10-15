// Small pieces every view draws: a card, an avatar, a chip stack.
import { appPath } from '../../../../packages/kit/client/paths.ts';
import type { Mood } from '../../shared/recording.ts';
import { h } from '../dom.ts';
import { avatarPath } from '../roster.ts';
import { cardFace, chipStack, hueOf, type SeatPerson } from '../view-model.ts';

/** A playing card: face up when `up` (and its text is known), else its back. Flip it with .classList.toggle('up'). */
export function cardEl(text: string | null, up: boolean): HTMLElement {
  const face = text ? cardFace(text) : null;
  const el = h(
    'div.card',
    { role: 'img', 'aria-label': face && up ? face.label : 'A card, face down' },
    h('div.card-inner', null, h('div.back'), face ? h(`div.face${face.red ? '.red' : ''}`, null, h('span.rank', null, face.rank), h('span.pip', null, face.suit), h('span.big', null, face.suit)) : null),
  );
  if (face && up) el.classList.add('up');
  el.dataset.card = text ?? '';
  return el;
}

/** Turns a card face up (with its flip). */
export function flipUp(el: HTMLElement): void {
  const text = el.dataset.card;
  if (!text) return;
  el.classList.add('up');
  el.setAttribute('aria-label', cardFace(text).label);
}

/** Faces that have loaded (by URL), and those on their way. */
const loadedFaces = new Set<string>();
const loadingFaces = new Map<string, Promise<boolean>>();

/** Loads a face into the browser's cache; true once it can be shown at once, false if it would not load. */
export function preloadFace(url: string): Promise<boolean> {
  if (loadedFaces.has(url)) return Promise.resolve(true);
  let p = loadingFaces.get(url);
  if (!p) {
    p = new Promise<boolean>((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        loadedFaces.add(url);
        resolve(true);
      };
      img.onerror = () => {
        loadingFaces.delete(url);
        resolve(false);
      };
      img.src = url;
    });
    loadingFaces.set(url, p);
  }
  return p;
}

/** The faces of a lineup in a mood (relaxed: how a table starts), loading; resolves when every one has loaded or failed. */
export function preloadFaces(people: readonly SeatPerson[], mood: Mood = 'relaxed'): Promise<boolean[]> {
  return Promise.all(people.flatMap((p) => (p.slug ? [preloadFace(appPath(avatarPath(p.slug, mood)))] : [])));
}

/**
 * The stand-in while a face loads, or if it never does: a disc in the character's colour with the first letter of its
 * short name ("L" for Luna), as an SVG image so it takes the face's place in every layout.
 */
export function placeholderFace(p: SeatPerson): string {
  const hue = hueOf(p.slug ?? p.name);
  const letter = ([...p.short.trim()][0] ?? '?').toUpperCase().replace(/[<&>]/g, '');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><radialGradient id="g" cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="hsl(${hue} 45% 46%)"/><stop offset="1" stop-color="hsl(${hue} 50% 22%)"/></radialGradient></defs>` +
    `<rect width="96" height="96" fill="url(#g)"/><text x="48" y="50" dominant-baseline="central" text-anchor="middle" font-family="Georgia, serif" font-weight="700" font-size="44" fill="hsl(${hue} 60% 90%)">${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Shows a face once it has loaded: the stand-in (or the last face) until then, never an empty frame. */
function showWhenLoaded(img: HTMLImageElement, url: string, fade: boolean): void {
  img.dataset.face = url;
  if (loadedFaces.has(url)) {
    img.src = url;
    return;
  }
  void preloadFace(url).then((ok) => {
    // A later mood may have been asked for meanwhile: only the latest one is shown.
    if (!ok || img.dataset.face !== url) return;
    img.src = url;
    if (fade) img.classList.add('face-in');
  });
}

/** A model's painted face, or a brass disc with initials for you and the bots. */
export function avatarEl(p: SeatPerson, mood: Mood = 'relaxed', cls = 'avatar'): HTMLElement {
  if (p.slug) {
    const url = appPath(avatarPath(p.slug, mood));
    const img = h(`img.${cls}`, { alt: `${p.name}, ${mood}`, width: 96, height: 96, decoding: 'async' }) as HTMLImageElement;
    if (!loadedFaces.has(url)) img.src = placeholderFace(p);
    showWhenLoaded(img, url, true);
    return img;
  }
  return h(`div.${cls}.mono`, { 'aria-hidden': 'true' }, p.name === 'You' || p.name === 'Human' ? '♠' : p.name.slice(0, 2));
}

/** A face's new mood: the face it has stays until the new one has loaded. */
export function setFaceMood(el: HTMLElement, p: SeatPerson, mood: Mood): void {
  if (!p.slug || !(el instanceof HTMLImageElement)) return;
  el.alt = `${p.name}, ${mood}`;
  showWhenLoaded(el, appPath(avatarPath(p.slug, mood)), false);
}

/** A small stack of chips for an amount: by value, biggest at the bottom, at most `max` chips. */
export function chipsEl(amount: number, size = 16, max = 5): HTMLElement {
  const colours = chipStack(amount, max).reverse();
  const el = h('div.pchips', { style: { '--n': String(colours.length), '--chip': `${size}px` } });
  colours.forEach((c, i) => el.append(h('span.pchip', { 'data-c': c, style: { '--i': String(i) } })));
  return el;
}
