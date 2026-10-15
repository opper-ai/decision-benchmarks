// The end of the Sit & Go: an ivory poster with the finishing places, who knocked out whom, the biggest pot and the
// best highlight of the game, then its buttons: Play again (or Watch again), Share, which opens a panel of the ways to
// share it (X, LinkedIn, the image, a link that replays the whole game (share.ts), the 1200×630 image of this poster
// (share-image.ts)), and Review the hands and Change the table side by side.
import { appPath } from '../../../../packages/kit/client/paths.ts';
import { track } from '../../../../packages/kit/client/track.ts';
import { h, reducedMotion } from '../dom.ts';
import type { Review, TableSnapshot } from '../driver.ts';
import { factsOf, momentOf } from '../highlights.ts';
import { canShare, shareLink } from '../share.ts';
import { resultFacts, resultText } from '../social.ts';
import { face, imageShareButton, networkButtons } from './share-buttons.ts';
import { canvasMeasure, download, renderShareCard, shareCardData, shareCardLayout } from '../share-image.ts';
import { chips, ordinal, personOf } from '../view-model.ts';
import { avatarEl } from './parts.ts';

export interface EndOptions {
  review: Review;
  snapshot: TableSnapshot;
  watching: boolean;
  onAgain(): void;
  onLobby(): void;
  onReview(): void;
  /** The buttons' words, when they differ from a game's ("Watch it again", "Play your own"). */
  again?: string;
  lobby?: string;
  /** Where the poster is, for the share counts: a game's end, or a replay's. */
  source?: 'end' | 'replay';
}

/** The biggest pot of the game: its hand, size and winners. */
export function biggestPot(review: Review): { hand: number; amount: number; winners: number[] } | null {
  let best: { hand: number; amount: number; winners: number[] } | null = null;
  for (const hand of review.hands) {
    const f = factsOf(hand);
    if (!best || f.pot > best.amount) best = { hand: hand.hand, amount: f.pot, winners: [...new Set(f.awards.flatMap((a) => a.winners))] };
  }
  return best;
}

export function endView(o: EndOptions): HTMLElement {
  const people = o.review.players.map((p) => personOf(p));
  const name = (seat: number) => people[seat]!.name;
  /** A name inside a sentence: you, the human, in lower case. */
  const inner = (seat: number) => (people[seat]!.name === 'You' ? 'you' : people[seat]!.name);
  const places = o.snapshot.places;
  const viewer = o.snapshot.viewer;
  const winner = places.indexOf(1);
  const mine = viewer === null ? null : places[viewer];
  const title = viewer === null ? `${name(winner)} wins the table` : mine === 1 ? 'You won the table' : `You finished ${ordinal(mine ?? places.length)}`;
  const level = o.snapshot.view.level;
  const sub = `${o.snapshot.hand} hands${level ? `, blinds up to ${chips(level.sb)}/${chips(level.bb)}` : ''}.`;

  const standings = h('ol.standings');
  const order = places.map((p, seat) => [p ?? 99, seat] as const).sort((a, b) => a[0] - b[0]);
  for (const [place, seat] of order) {
    const out = o.snapshot.eliminations.find((e) => e.seat === seat);
    // In full on a wide screen; on a phone, one short line ("Out in hand 34 · by Clef") so the poster fits (style.css).
    // The phone's line uses the characters' short names ("Luna" for GPT-6 Luna Decisions), as the name plates do.
    const by = out?.by.map(inner).join(' and ');
    const byShort = out?.by.map((s) => (s === viewer ? 'you' : people[s]!.short)).join(' and ');
    const line = out
      ? h('small', null, h('span.long', null, `Out in hand ${out.hand}${by ? `, knocked out by ${by}` : ''}`), h('span.short', null, `Out in hand ${out.hand}${byShort ? ` · by ${byShort}` : ''}`))
      : h('small', null, `Took every chip, ${chips(o.snapshot.view.players[seat]!.stack)}`);
    const who = h('b', null, h('span.long', null, name(seat)), h('span.short', null, people[seat]!.short));
    standings.append(h('li', null, h('span.pl', null, ordinal(place)), avatarEl(people[seat]!, place === 1 ? 'smug' : 'annoyed'), h('div', null, who, line)));
  }

  // One box: the best moment, and the biggest pot as a line under it (said once when it is the moment).
  const facts = h('div.facts');
  const big = biggestPot(o.review);
  const moment = momentOf(o.review.hands, o.review.players, name);
  const bigLine = big ? h('p.fact-line', null, h('b', null, 'Biggest pot '), h('span.hl', null, chips(big.amount)), ` in hand ${big.hand}, to ${big.winners.map(inner).join(' and ')}.`) : null;
  if (moment) facts.append(h('div.fact', null, h('h3', null, `Best moment: ${moment.title}`), h('p', null, moment.text), moment.highlight.kind === 'biggest_pot' ? null : bigLine));
  else if (bigLine) facts.append(h('div.fact', null, bigLine));

  return h(
    'div.poster',
    { role: 'dialog', 'aria-label': 'The game is over' },
    h('h2', null, title),
    h('p.sub', null, sub),
    standings,
    facts,
    h(
      'div.end-actions',
      null,
      h('button.cta.end-again', { type: 'button', onclick: o.onAgain }, o.again ?? (o.watching ? 'Watch again' : 'Play again')),
      shareMenu(o) ?? '',
      h(
        'div.end-more',
        null,
        h('button.cta.quiet', { type: 'button', onclick: o.onReview }, 'Review the hands'),
        h('button.cta.quiet', { type: 'button', onclick: o.onLobby }, o.lobby ?? 'Change the table'),
      ),
    ),
  );
}

/**
 * Share, when the game can be shared (a finished Sit & Go of known players): a button that opens a panel under it with
 * the post's first line and the ways to share, on an even grid. Esc, a tap outside it, or Share again closes it.
 */
function shareMenu(o: EndOptions): HTMLElement | null {
  const rec = o.review.recording;
  if (!canShare(rec)) return null;
  const source = o.source ?? 'end';
  const status = h('p.share-status', { role: 'status' });
  const say = (text: string) => {
    status.textContent = text;
    setTimeout(() => status.textContent === text && (status.textContent = ''), 4000);
  };
  const link = () => shareLink(rec, new URL(appPath('/'), location.href).href);
  const text = () => resultText(resultFacts(o.review, o.snapshot.places, o.snapshot.viewer));
  const makeImage = () => renderShareCard(shareCardLayout(shareCardData(o.review, o.snapshot.places, o.snapshot.eliminations, o.snapshot.hand, o.snapshot.viewer), canvasMeasure()), appPath);
  const copy = async () => {
    const url = link();
    try {
      track('share', { game: 'holdem', kind: 'result', network: 'link', source });
      await navigator.clipboard.writeText(url);
      say('Link copied. It replays the whole game.');
    } catch {
      // No clipboard (an insecure page, a refusal): show the link to copy by hand.
      const field = h('input.share-field', { type: 'text', readonly: true, value: url, 'aria-label': 'The link to this game' }) as HTMLInputElement;
      status.replaceChildren(field);
      field.select();
    }
  };
  const image = async (button: HTMLButtonElement) => {
    button.disabled = true;
    try {
      download(await makeImage(), 'ai-holdem.png');
      track('share', { game: 'holdem', kind: 'image', network: 'download', source });
      say('Image saved.');
    } catch (e) {
      say(`The image could not be made: ${(e as Error).message}`);
    } finally {
      button.disabled = false;
    }
  };
  const imageBtn = h('button.sp-btn', { type: 'button', onclick: () => void image(imageBtn) }, ...face('download', 'Download image', 'Save image')) as HTMLButtonElement;
  // To the networks first (the post: text, link, and the picture where the device can); then the link and the files.
  const buttons = [
    ...networkButtons({ text, url: link, kind: 'result', source, cls: 'sp-btn' }),
    imageShareButton({ image: makeImage, text, url: link, source, say, cls: 'sp-btn' }),
    h('button.sp-btn', { type: 'button', onclick: () => void copy() }, ...face('link', 'Copy link')),
    imageBtn,
  ].filter((b): b is HTMLElement => b !== null);
  const preview = h('p.sp-preview');
  const panel = h(
    'div.share-panel',
    { id: `share-panel-${++panels}`, role: 'group', 'aria-label': 'Share this game', hidden: true },
    preview,
    // data-n: how many, so the grid can fill its rows evenly (style.css).
    h('div.sp-grid', { 'data-n': String(buttons.length) }, ...buttons),
    status,
  );
  const toggle = h('button.cta.end-share', { type: 'button', 'aria-expanded': 'false', 'aria-controls': panel.id, onclick: () => (panel.hidden ? show() : hide(true)) }, ...face('share', 'Share')) as HTMLButtonElement;
  const wrap = h('div.share-wrap', null, toggle, panel);
  const onDown = (e: PointerEvent) => {
    if (!wrap.isConnected) return document.removeEventListener('pointerdown', onDown, true);
    if (!wrap.contains(e.target as Node)) hide(false);
  };
  const show = () => {
    const words = text();
    preview.textContent = `“${words}”`;
    preview.title = words;
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDown, true);
    buttons[0]!.focus({ preventScroll: true });
    panel.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'instant' : 'smooth' });
  };
  const hide = (refocus: boolean) => {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDown, true);
    if (refocus) toggle.focus({ preventScroll: true });
  };
  wrap.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || panel.hidden) return;
    e.preventDefault();
    e.stopPropagation();
    hide(true);
  });
  return wrap;
}

/** Share panels made so far, for their ids. */
let panels = 0;
