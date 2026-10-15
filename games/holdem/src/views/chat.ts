// The table chat, as in an online card room: the dealer's lines (each hand, every move, the board, who won), the
// models' words as messages with their face and name, and, where the cards are face up (watching, a replay, once you
// are out), their reasoning folded under the message ("thinking"). Newest at the bottom; it follows the talk unless
// the reader has scrolled up (then "New messages" brings them down). In play there is a line to type your own talk
// into (90 characters, Enter sends). A panel beside the table on a wide screen, a sheet from the bottom on a phone
// (opened from the toolbar's chat button, which counts what came while it was shut). style.css lays it out.
import type { HandEvent, Street } from '../../shared/engine.ts';
import type { ActionMeta } from '../../shared/table.ts';
import { chatLinesOf, SAY_MAX, sayCount, type ActionEvent, type ChatLine } from '../chat-lines.ts';
import { h } from '../dom.ts';
import { actionChip, aHand, cardFace, chips, logNote, STREET_NAMES, type SeatPerson } from '../view-model.ts';
import { avatarEl } from './parts.ts';

/** At most this many lines are kept (the oldest go). */
const KEEP = 240;

/** A chip with the move: its words in a colour for what it does (fold, check or call, bet or raise, all-in). */
export function chipEl(act: Pick<ActionEvent, 'kind' | 'to' | 'add' | 'allIn'>): HTMLElement {
  const c = actionChip(act);
  return h(`span.act-chip.t-${c.tone}`, null, c.label);
}

/** Cards as text with their suits, red or black: "K♣ 5♥". */
function cardsText(cards: readonly string[]): HTMLElement {
  return h('span.chat-cards', null, ...cards.map((c) => {
    const f = cardFace(c);
    return h(`span.cc${f.red ? '.red' : ''}`, { 'aria-label': f.label }, `${f.rank}${f.suit}`);
  }));
}

export interface ChatOptions {
  people: readonly SeatPerson[];
  /** Your seat in play (your own talk, "you" in the dealer's lines), else null. */
  viewer: number | null;
  /** Play mode: a line to type into, and what to do with what was typed. */
  onSay?: (text: string) => void;
}

export class ChatBox {
  readonly el: HTMLElement;
  /** The toolbar's button for a phone: opens the chat as a sheet, with a count of what came while it was shut. */
  readonly button: HTMLButtonElement;
  private scroller: HTMLElement;
  private newer: HTMLButtonElement;
  private note: HTMLElement;
  private input: HTMLInputElement | null = null;
  private street: Street = 'preflop';
  private unread = 0;
  private o: ChatOptions;

  constructor(o: ChatOptions) {
    this.o = o;
    this.note = h('p.chat-note', null, logNote(o.people.map((p) => p.style)));
    this.scroller = h('div.chat-scroll', { role: 'log', 'aria-live': 'polite', 'aria-label': 'Table chat', tabindex: '0' }, this.note);
    this.newer = h('button.chat-newer', { type: 'button', hidden: true, onclick: () => this.toBottom() }, 'New messages ↓') as HTMLButtonElement;
    this.scroller.addEventListener('scroll', () => {
      if (this.atBottom()) this.newer.hidden = true;
    });
    const collapse = h('button.chat-collapse', { type: 'button', 'aria-expanded': 'true', 'aria-label': 'Hide the chat', title: 'Hide the chat', onclick: () => this.toggle() }, chev());
    const head = h('header.chat-head', null, h('h3', null, 'Table talk'), collapse);
    const body = h('div.chat-body', null, this.scroller, this.newer);
    this.el = h('section.chat', { 'aria-label': 'Table talk' }, head, body);
    if (o.onSay) this.el.append(this.sayForm(o.onSay));
    this.button = h('button.tbtn.icon.chat-btn', { type: 'button', 'aria-label': 'Table talk', 'aria-expanded': 'false', title: 'Table talk', onclick: () => this.toggle() }) as HTMLButtonElement;
    this.button.innerHTML = CHAT_ICON;
    // Open beside the table on a wide screen; shut (the toolbar's button opens it) on a phone.
    this.toggle(typeof matchMedia === 'function' && matchMedia('(min-width: 1000px)').matches);
  }

  /** The chat as a sheet (a phone) or a panel (wide): open or shut. */
  toggle(open = !this.el.classList.contains('open')): void {
    this.el.classList.toggle('open', open);
    this.el.classList.toggle('collapsed', !open);
    this.el.querySelector('.chat-collapse')?.setAttribute('aria-expanded', String(open));
    this.button.setAttribute('aria-expanded', String(open));
    if (open) {
      this.unread = 0;
      this.button.removeAttribute('data-unread');
      this.toBottom();
    }
  }

  /** Lines for a hand's new events; `said` is the answer's own metadata (the seat that moved, its words and why). */
  feed(events: readonly HandEvent[], hand: number, said?: { seat: number; meta: ActionMeta }): void {
    const lines = chatLinesOf(events, hand, this.street);
    // The answer's move is the last move of its seat among these events.
    const own = said ? lines.findLast((l) => l.kind === 'move' && l.seat === said.seat) : undefined;
    for (const l of lines) {
      if (l.kind === 'hand' || l.kind === 'board') this.street = l.kind === 'hand' ? 'preflop' : l.street;
      this.add(this.lineEl(l, l === own ? said!.meta : undefined));
    }
  }

  /** Your own talk, as it is sent. */
  you(text: string): void {
    const p = this.o.viewer !== null ? this.o.people[this.o.viewer] : undefined;
    this.add(h('article.chat-msg.you', null, p ? avatarEl(p, 'relaxed', 'chat-face') : null, h('div.chat-main', null, h('div.chat-who', null, h('b', null, 'You')), h('q.chat-said', null, text))), true);
  }

  private lineEl(l: ChatLine, meta: ActionMeta | undefined): HTMLElement {
    const name = (seat: number) => (seat === this.o.viewer ? 'You' : this.o.people[seat]!.name);
    if (l.kind === 'hand') return h('div.chat-hand', null, h('b', null, `Hand ${l.hand}`), ` · blinds ${chips(l.sb)}/${chips(l.bb)}${l.ante ? `, ante ${chips(l.ante)}` : ''}`);
    if (l.kind === 'board') return h('p.chat-dealer.board', null, h('b', null, STREET_NAMES[l.street]), cardsText(l.cards));
    if (l.kind === 'win') {
      const who = l.winners.map(name).join(' and ');
      const verb = l.winners.length > 1 ? 'split' : who === 'You' ? 'win' : 'wins';
      return h('p.chat-dealer.win', null, h('b', null, who), ` ${verb} ${l.side ? 'a side pot of ' : ''}${chips(l.amount)}${l.category ? ` with ${aHand(l.category)}` : ''}`);
    }
    const p = this.o.people[l.seat]!;
    // Words (talk, reasoning): a message with the face; a bare move: the dealer's line.
    if (!meta?.say && !meta?.reasoning) return h('p.chat-dealer.move', null, h('b', null, name(l.seat)), chipEl(l.act));
    return h(
      'article.chat-msg',
      null,
      avatarEl(p, meta.mood ?? 'relaxed', 'chat-face'),
      h(
        'div.chat-main',
        null,
        h('div.chat-who', null, h('b', null, name(l.seat)), chipEl(l.act)),
        meta.say ? h('q.chat-said', null, meta.say) : null,
        meta.reasoning ? h('details.chat-why', null, h('summary', null, 'thinking'), h('p', null, meta.reasoning)) : null,
      ),
    );
  }

  private atBottom(): boolean {
    return this.scroller.scrollTop + this.scroller.clientHeight >= this.scroller.scrollHeight - 24;
  }

  private toBottom(): void {
    this.scroller.scrollTop = this.scroller.scrollHeight;
    this.newer.hidden = true;
  }

  /** A line at the bottom: followed if the reader is at the bottom (or it is their own), else "New messages". */
  private add(el: HTMLElement, mine = false): void {
    const follow = mine || this.atBottom();
    this.note.hidden = true;
    this.scroller.append(el);
    while (this.scroller.childElementCount > KEEP + 1) this.scroller.children[1]!.remove();
    if (follow) this.toBottom();
    else this.newer.hidden = false;
    if (!this.el.classList.contains('open') && el.matches('.chat-msg') && !mine) {
      this.unread++;
      this.button.dataset.unread = String(Math.min(this.unread, 9));
    }
  }

  private sayForm(onSay: (text: string) => void): HTMLElement {
    const count = h('span.chat-count', { 'aria-hidden': 'true' }, sayCount(''));
    const input = h('input.chat-input', { type: 'text', maxlength: String(SAY_MAX), placeholder: 'Say something to the table…', 'aria-label': 'Say something to the table', autocomplete: 'off', enterkeyhint: 'send' }) as HTMLInputElement;
    this.input = input;
    input.addEventListener('input', () => (count.textContent = sayCount(input.value)));
    // The action bar's keys (F, C, R, A) must not fire while typing here: actions.ts skips text inputs.
    const form = h('form.chat-say', null, input, count, h('button.chat-send', { type: 'submit', 'aria-label': 'Send' }, '↑'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim().slice(0, SAY_MAX);
      if (!text) return;
      input.value = '';
      count.textContent = sayCount('');
      this.you(text);
      onSay(text);
    });
    return form;
  }
}

/** A chevron, pointing down (the chat folds away). */
function chev(): HTMLElement {
  const el = h('span.chev', { 'aria-hidden': 'true' });
  el.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return el;
}

const CHAT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4 3.5V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M8 10h8M8 13h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
