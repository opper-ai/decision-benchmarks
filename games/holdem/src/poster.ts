// The game's poster (public/poster.png: the hub's card and the page's social image, 1280×720) drawn from a curated
// replay's best moment, with the share image's shapes and drawing (share-image.ts): the title and the hook on the left
// with the moment as the end screen says it, the felt on the right with the two players face to face, their cards,
// the board and the pot, and what the protagonist said in that hand. The page draws it alone at #/still/<file> (routes.ts), and
// scripts/poster.ts photographs that page. Like the share image: what it says (posterData) and where everything goes
// (posterLayout) are pure, so tests check them without a canvas.
import { formatCard } from '../shared/cards.ts';
import type { Mood } from '../shared/recording.ts';
import type { Review } from './driver.ts';
import { biggestPotHighlight, describeHighlight, factsOf, highlightsOf, momentOf, potText, titleOf, type HighlightKind, type Moment } from './highlights.ts';
import { C, estimate, wrap, type Item, type Measure } from './share-image.ts';
import { personOf } from './view-model.ts';

export const POSTER_W = 1280;
export const POSTER_H = 720;

export interface PosterSeat {
  name: string;
  slug: string | null;
  mood: Mood;
  hole: string[];
  /** Won the hand. */
  won: boolean;
}

export interface PosterData {
  hook: string;
  sub: string;
  moment: { title: string; where: string; caption: string };
  featured: PosterSeat;
  against: PosterSeat;
  /** The featured player's last words in that hand, if they said any. */
  say: string | null;
  board: string[];
  /** "Pot: 140 big blinds", or "Pot: 5,672 chips, 95% of the chips in play" late in a game. */
  pot: string;
  /** Everyone at the table, seat order. */
  lineup: { name: string; slug: string | null }[];
}

export const POSTER_HOOK = 'Can a model bluff?';
export const POSTER_SUB = 'Play No-limit Hold’em against AI models, or watch them play with every card face up.';

/** The best highlight of one kind among the hands, worded as momentOf words a moment. */
function momentOfKind(hands: Review['hands'], players: Review['players'], name: (seat: number) => string, kind: HighlightKind): Moment | null {
  const best = kind === 'biggest_pot' ? biggestPotHighlight(hands, players) : hands.flatMap((h) => highlightsOf(h, players)).filter((x) => x.kind === kind).sort((a, b) => b.score - a.score)[0];
  return best ? { highlight: best, title: titleOf(best), text: `Hand ${best.hand}. ${describeHighlight(best, name)}` } : null;
}

/** A hand's blinds, "50/100". */
const blindsOf = (h: Review['hands'][number]): string => {
  const f = factsOf(h);
  return `${f.bb / 2}/${f.bb}`;
};

/**
 * What the poster says, from a finished game's review: its best moment (or the best of hand `hand`, or the best of one
 * kind, e.g. the bluff in a hand whose best story is the call that caught it), or null for none.
 */
export function posterData(review: Review, hand?: number, kind?: HighlightKind): PosterData | null {
  const people = review.players.map((p) => personOf(p));
  const name = (seat: number) => people[seat]!.name;
  const hands = hand === undefined ? review.hands : review.hands.filter((h) => h.hand === hand);
  const m = kind ? momentOfKind(hands, review.players, name, kind) : momentOf(hands, review.players, name);
  if (!m) return null;
  const h = review.hands.find((x) => x.hand === m.highlight.hand)!;
  const f = factsOf(h);
  const winners = new Set(f.awards.flatMap((a) => a.winners));
  const lastOf = (seat: number) => [...h.actions].reverse().find((x) => x.seat === seat && x.mood);
  const seatOf = (seat: number): PosterSeat => ({ name: name(seat), slug: people[seat]!.slug, mood: lastOf(seat)?.mood ?? (winners.has(seat) ? 'smug' : 'relaxed'), hole: (f.holes[seat] ?? []).map(formatCard), won: winners.has(seat) });
  const against = m.highlight.against === m.highlight.featured ? m.highlight.seat : m.highlight.against;
  const say = [...h.actions].reverse().find((x) => x.seat === m.highlight.featured && x.say)?.say ?? null;
  return {
    hook: POSTER_HOOK,
    sub: POSTER_SUB,
    moment: { title: m.title, where: `Hand ${m.highlight.hand} of ${review.hands.length}, blinds ${blindsOf(h)}`, caption: m.text.replace(/^Hand \d+\. /, '') },
    featured: seatOf(m.highlight.featured),
    against: seatOf(against),
    say,
    board: f.board.map(formatCard),
    pot: `Pot: ${potText(m.highlight)}`,
    lineup: people.map((p) => ({ name: p.name, slug: p.slug })),
  };
}

/** Every shape, word, face and card on the poster, in drawing order. */
export function posterLayout(d: PosterData, measure: Measure = estimate): Item[] {
  const items: Item[] = [];
  const text = (x: number, y: number, t: string, size: number, o: { font?: string; weight?: number; color?: string; align?: 'left' | 'center' | 'right'; width?: number } = {}) => {
    const font = o.font ?? 'Wix Madefor Text';
    const weight = o.weight ?? 500;
    let s = size;
    while (o.width && s > size * 0.67 && measure(t, font, s, weight) > o.width) s -= 1;
    let line = t;
    while (o.width && line.length > 1 && measure(line, font, s, weight) > o.width) line = `${line.slice(0, -2)}…`;
    items.push({ kind: 'text', x, y, text: line, font, size: s, weight, color: o.color ?? C.text, align: o.align ?? 'left' });
  };
  const lines = (t: string, x: number, y: number, size: number, width: number, max: number, lead: number, color: string): number => {
    const ls = wrap(t, width, max, (s) => measure(s, 'Wix Madefor Text', size, 500) <= width);
    ls.forEach((l, i) => text(x, y + i * lead, l, size, { color, width }));
    return ls.length;
  };

  // The room, and a warm light over the felt.
  items.push({ kind: 'rect', x: 0, y: 0, w: POSTER_W, h: POSTER_H, r: 0, fill: '#1c100a' });
  items.push({ kind: 'ellipse', cx: 905, cy: 372, rx: 375, ry: 340, fill: 'rgba(215, 170, 82, 0.06)' });

  // The left: the name, the hook, what it is, and the moment.
  const lx = 64;
  const lw = 456;
  text(lx, 148, "AI Hold'em", 92, { font: 'Fraunces', weight: 800, color: C.brass, width: lw });
  text(lx, 214, d.hook, 46, { font: 'Fraunces', weight: 800, color: C.ivory, width: lw });
  lines(d.sub, lx, 262, 20, lw, 2, 28, 'rgba(243, 232, 205, 0.72)');
  // The moment's box fits its caption (up to four lines).
  const top = 340;
  const panel: Item = { kind: 'rect', x: lx - 18, y: top, w: lw + 36, h: 0, r: 18, fill: 'rgba(247, 239, 220, 0.05)', stroke: 'rgba(215, 170, 82, 0.5)', line: 1.5 };
  items.push(panel);
  text(lx + 4, top + 44, d.moment.title, 32, { font: 'Fraunces', weight: 800, color: C.brass, width: lw - 8 });
  text(lx + 4, top + 74, d.moment.where, 17, { color: 'rgba(243, 232, 205, 0.6)', width: lw - 8 });
  const n = lines(d.moment.caption, lx + 4, top + 116, 22, lw - 8, 4, 31, C.ivory);
  panel.h = 116 + (n - 1) * 31 + 30;

  // Everyone at the table, and where to play.
  const ly = 636;
  d.lineup.forEach((p, i) => items.push({ kind: 'avatar', cx: lx + 22 + i * 54, cy: ly, r: 22, slug: p.slug, label: p.name }));
  // Their names beside the faces, on two lines when one won't hold them.
  const nx = lx + d.lineup.length * 54 + 6;
  const nw = lx + lw + 20 - nx;
  const names = wrap(d.lineup.map((p) => p.name).join(' · '), nw, 2, (t) => measure(t, 'Wix Madefor Text', 16, 500) <= nw);
  names.forEach((l, i) => text(nx, ly + 6 + (i - (names.length - 1) / 2) * 21, l, 16, { color: 'rgba(243, 232, 205, 0.75)', width: nw }));
  text(lx, 694, 'opper.ai/decision-benchmarks/holdem', 16, { color: 'rgba(243, 232, 205, 0.5)' });

  // The felt.
  const fx = 905;
  const fy = 380;
  items.push({ kind: 'ellipse', cx: fx, cy: fy, rx: 352, ry: 300, fill: C.rail });
  items.push({ kind: 'ellipse', cx: fx, cy: fy, rx: 336, ry: 284, fill: C.felt });
  items.push({ kind: 'ellipse', cx: fx, cy: fy, rx: 312, ry: 260, fill: 'transparent', stroke: 'rgba(215, 170, 82, 0.45)', line: 1.5 });

  // The two players face to face, their cards under them (the winner's lit).
  const seat = (p: PosterSeat, cx: number) => {
    items.push({ kind: 'avatar', cx, cy: 232, r: 74, slug: p.slug, label: p.name, mood: p.mood, ...(p.won ? { ring: '#ffc56b' } : {}) });
    text(cx, 336, p.name, 24, { font: 'Fraunces', weight: 800, color: C.ivory, align: 'center', width: 220 });
    const w = 58;
    p.hole.forEach((c, i) => items.push({ kind: 'card', x: cx - w - 4 + i * (w + 8), y: 352, w, card: c, lit: p.won }));
  };
  seat(d.featured, 772);
  seat(d.against, 1038);
  text(fx, 244, 'vs', 30, { font: 'Fraunces', weight: 800, color: 'rgba(215, 170, 82, 0.8)', align: 'center' });

  // The board as the hand ended.
  const bw = 56;
  const gap = 8;
  const total = d.board.length * bw + Math.max(0, d.board.length - 1) * gap;
  d.board.forEach((c, i) => items.push({ kind: 'card', x: fx - total / 2 + i * (bw + gap), y: 470, w: bw, card: c }));
  text(fx, 600, d.pot, 24, { font: 'Fraunces', weight: 800, color: 'rgba(215, 170, 82, 0.8)', align: 'center' });

  // What the protagonist said, over their head.
  if (d.say) items.push({ kind: 'bubble', x: 772, y: 146, text: `“${d.say}”`, size: 26, maxWidth: 360 });
  return items;
}
