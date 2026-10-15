// The hand review: every player's cards, the board as it would have run, the highlights, and every action in order
// with what each model said, the face it made, how sure it was and why it did it.
import { formatCard } from '../../shared/cards.ts';
import type { HandEvent, Street } from '../../shared/engine.ts';
import { h } from '../dom.ts';
import type { Review, ReviewHand } from '../driver.ts';
import { describeHighlight, factsOf, highlightsOf, titleOf } from '../highlights.ts';
import { aHand, chips, handName, personOf, STREET_NAMES, tellBars, type SeatPerson } from '../view-model.ts';
import { chipEl } from './chat.ts';
import { avatarEl, cardEl } from './parts.ts';


export interface ReviewOptions {
  review: Review;
  /** The hand to open on (from 1); the last one by default. */
  hand?: number;
  onClose(): void;
}

export function reviewView(o: ReviewOptions): HTMLElement {
  const people: SeatPerson[] = o.review.players.map((p) => personOf(p));
  const name = (seat: number) => people[seat]!.name;
  const root = h('div.review', { role: 'dialog', 'aria-label': 'Hand review' });
  const hands = o.review.hands;
  if (!hands.length) {
    root.append(h('div.review-head', null, h('h2', null, 'Hand review'), h('button.tbtn', { type: 'button', onclick: o.onClose }, 'Back to the table')), h('p', null, 'No hand has finished yet. The review fills in as hands end.'));
    return root;
  }
  let index = Math.max(0, hands.findIndex((x) => x.hand === o.hand));
  if (o.hand === undefined) index = hands.length - 1;

  const draw = () => {
    const hand = hands[index]!;
    const select = h('select', { 'aria-label': 'Hand' }) as HTMLSelectElement;
    hands.forEach((x, i) => {
      const hl = highlightsOf(x, o.review.players)[0];
      select.append(h('option', { value: String(i), selected: i === index }, `Hand ${x.hand}${hl ? `: ${titleOf(hl)}` : ''}`));
    });
    select.addEventListener('change', () => ((index = Number(select.value)), draw()));
    const head = h(
      'div.review-head',
      null,
      h('h2', null, `Hand ${hand.hand}`),
      h(
        'div.review-nav',
        null,
        h('button.tbtn.icon', { type: 'button', 'aria-label': 'Previous hand', disabled: index === 0, onclick: () => (index--, draw()) }, '‹'),
        select,
        h('button.tbtn.icon', { type: 'button', 'aria-label': 'Next hand', disabled: index === hands.length - 1, onclick: () => (index++, draw()) }, '›'),
        h('button.tbtn', { type: 'button', onclick: o.onClose }, 'Back to the table'),
      ),
    );
    root.replaceChildren(head, ...handBody(hand, people, name, o.review.players));
    root.parentElement?.scrollTo?.({ top: 0 });
  };
  draw();
  return root;
}

function handBody(hand: ReviewHand, people: SeatPerson[], name: (seat: number) => string, players: Review['players']): HTMLElement[] {
  /** The player's own table talk, where it was said among the moves. */
  const talkRow = (t: { seat: number; say: string }) => h('div.tl.talk', null, avatarEl(people[t.seat]!), h('div.line', null, h('b', null, people[t.seat]!.name), h('span.meta', null, 'said')), h('q.said', null, t.say));
  const f = factsOf(hand);
  const shown = new Map(hand.events.flatMap((e) => (e.type === 'showdown' ? e.hands.map((x) => [x.seat, x.category] as const) : [])));
  const held = h('div.who-held');
  f.holes.forEach((cards, seat) => {
    if (!cards) return;
    const net = f.net[seat] ?? 0;
    const cat = shown.get(seat);
    held.append(
      h(
        'div.held',
        null,
        avatarEl(people[seat]!),
        h('span.nm', null, h('span', null, name(seat)), h(`span.net${net > 0 ? '.up' : net < 0 ? '.down' : ''}`, null, `${net > 0 ? '+' : ''}${chips(net)}`)),
        h('span.cards', null, ...hand.events.flatMap((e) => (e.type === 'hole' && e.seat === seat ? [cardsOf(e)] : [])).flat()),
        f.folded.has(seat) ? h('span.cat', null, `Folded ${STREET_NAMES[f.folded.get(seat)!] === 'Before the flop' ? 'before the flop' : `on the ${f.folded.get(seat)}`}`) : cat ? h('span.cat', null, handName(cat)) : null,
      ),
    );
  });
  const dealt = f.board.length;
  const runout = h('div.runout', null, h('span.lbl', null, dealt < 5 ? 'The board, and the cards still to come' : 'The board'), ...hand.runout.map((c, i) => {
    const el = cardEl(c, true);
    if (i >= dealt) el.classList.add('dim');
    return el;
  }));
  const highlights = h('div.highlights', null, ...highlightsOf(hand, players).map((x) => h('div.hl-card', null, h('b', null, titleOf(x)), h('span', null, describeHighlight(x, name)))));

  const timeline = h('div.timeline');
  let street: Street | null = null;
  const streetCards = new Map<Street, string[]>();
  for (const e of hand.events) if (e.type === 'street') streetCards.set(e.street, e.cards.map(formatCard));
  f.actions.forEach((a, i) => {
    if (a.street !== street) {
      street = a.street;
      const cards = street === 'preflop' ? [] : (streetCards.get(street) ?? []);
      timeline.append(h('div.street-head', null, STREET_NAMES[street], h('span.cards', null, ...cards.map((c) => cardEl(c, true)))));
    }
    for (const t of hand.talk ?? []) if (t.after === i) timeline.append(talkRow(t));
    const meta = hand.actions[i];
    const p = people[a.seat]!;
    const bars = tellBars(meta?.probabilities);
    timeline.append(
      h(
        'div.tl',
        null,
        avatarEl(p, meta?.mood ?? 'relaxed'),
        h('div.line', null, h('b', null, p.name), chipEl(a), meta?.by === 'fallback' ? h('span.meta', null, 'out of time: the fallback played') : null),
        meta?.say ? h('q.said', null, meta.say) : null,
        h(
          'div.meta',
          null,
          [meta?.mood ? `looked ${meta.mood}` : null, meta?.latencyMs !== undefined && meta.by !== 'human' ? `${(meta.latencyMs / 1000).toFixed(1)} s` : null].filter(Boolean).join(', '),
        ),
        bars ? h('div.tellrow', null, ...(['fold', 'call', 'raise'] as const).map((k) => h('span', null, h('i', { style: { width: `${Math.round(bars[k] * 40) + 2}px` } }), `${k} ${Math.round(bars[k] * 100)}%`))) : null,
        meta?.reasoning ? h('p.why', null, meta.reasoning) : null,
      ),
    );
  });
  for (const t of hand.talk ?? []) if (t.after >= f.actions.length) timeline.append(talkRow(t));
  const results = hand.events.flatMap((e) => (e.type === 'award' ? [e] : [])).map((e) => {
    const winners = e.winners.map(name).join(' and ');
    const cat = e.winners.length && shown.get(e.winners[0]!);
    const pot = e.pot === 0 ? 'the pot' : 'a side pot';
    const you = e.winners.length === 1 && people[e.winners[0]!]!.name === 'You';
    return h('div.result-line', null, `${winners} ${e.winners.length > 1 || you ? (e.winners.length > 1 ? 'split' : 'win') : 'wins'} ${pot} of ${chips(e.amount)}${cat ? ` with ${aHand(cat)}` : ''}.`);
  });
  return [held, runout, ...(highlights.childElementCount ? [highlights] : []), timeline, ...results];
}

function cardsOf(e: Extract<HandEvent, { type: 'hole' }>): HTMLElement[] {
  return e.cards.map((c) => cardEl(formatCard(c), true));
}
