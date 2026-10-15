// The felt: seats round an oval, the board and pots in the middle, bets in front of each seat, and the animations that
// carry one event at a time from the driver to the table (deal, chips in, gather, flip, pay). It keeps its own table
// model (table-model.ts), and the snapshot corrects it at the end of every step.
import { formatCard } from '../../shared/cards.ts';
import type { HandEvent } from '../../shared/engine.ts';
import type { Mood } from '../../shared/recording.ts';
import { audio } from '../audio.ts';
import { h, wait } from '../dom.ts';
import type { ActionMeta, SeatConfig, TableSnapshot } from '../driver.ts';
import { applyEvent, emptyModel, potsOfModel, type TableModel } from '../table-model.ts';
import { actionTag, bubbleMs, chips, handName, ordinal, paced, personOf, potLabels, slotsFor, tellBars, type SeatPerson, type Slot } from '../view-model.ts';
import { avatarEl, cardEl, chipsEl, flipUp, preloadFaces, setFaceMood } from './parts.ts';

interface SeatEls {
  root: HTMLElement;
  avatar: HTMLElement;
  hole: HTMLElement;
  tag: HTMLElement;
  stack: HTMLElement;
  tell: HTMLElement | null;
  bet: HTMLElement;
  shown: HTMLElement;
}

export interface TableOptions {
  seats: SeatConfig[];
  viewer: number | null;
  /** The watch speed (1 is normal) and reduced motion, read on every pause. */
  speed: () => number;
  reduced: () => boolean;
}

export class TableUI {
  readonly el: HTMLElement;
  private area: HTMLElement;
  private fx: HTMLElement;
  private board: HTMLElement;
  private pots: HTMLElement;
  private dealer: HTMLElement;
  private bannerEl: HTMLElement | null = null;
  private seatEls: SeatEls[] = [];
  private people: SeatPerson[];
  private slots: Slot[];
  private model: TableModel;
  private bubbles = new Map<number, number>();
  private o: TableOptions;
  private placesShown: (number | null)[] = [];
  /** The five cards each shown hand plays, from the showdown: lit up for the winners. */
  private best = new Map<number, Set<string>>();
  /** The pot number on screen (chips gathered in the middle), counted towards the model's. */
  private potShown = 0;
  /** Pots already paid out this hand (by index), no longer drawn. */
  private paid = new Set<number>();

  constructor(o: TableOptions) {
    this.o = o;
    this.people = o.seats.map(personOf);
    this.slots = slotsFor(o.seats.length, o.viewer);
    this.model = emptyModel(o.seats.length);
    this.board = h('div.board', { 'aria-label': 'The board' });
    this.pots = h('div.pots', { 'aria-live': 'polite' });
    this.dealer = h('div.dealer', { 'aria-hidden': 'true' }, 'D');
    this.fx = h('div.fx', { 'aria-hidden': 'true' });
    this.area = h(
      'div.felt-area',
      null,
      h('div.rail', null, h('div.felt', null, h('div.wordmark', { 'aria-hidden': 'true' }, "AI Hold'em", h('small', null, 'No-limit Sit & Go')))),
      h('div.middle', null, this.pots, this.board),
      this.dealer,
    );
    this.people.forEach((p, seat) => this.seatEls.push(this.makeSeat(p, seat)));
    this.area.append(this.fx);
    this.el = this.area;
    this.renderBoard();
  }

  private makeSeat(p: SeatPerson, seat: number): SeatEls {
    const slot = this.slots[seat]!;
    const you = seat === this.o.viewer;
    const avatar = avatarEl(p);
    const hole = h('div.hole');
    const tag = h('span.tag', { hidden: true });
    const stack = h('span.stack');
    const tell = p.style === 'decision' ? h('div.tell', { hidden: true, title: 'How sure it was: fold, call, raise', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')) : null;
    const plate = h('div.plate', null, tag, h('span.name', { title: p.name }, h('span.full', null, p.name), h('span.short', { 'aria-hidden': 'true' }, p.short)), p.badge ? h('span.badge2', null, h('span.full', null, p.badge), h('span.short', { 'aria-hidden': 'true' }, p.tag)) : null, stack);
    const shown = h('span.shown-name', { hidden: true });
    const avatarWrap = h('div.avatar-wrap', null, avatar, tell);
    const who = h('div.who', null, avatarWrap, plate, shown);
    const root = h(`div.seat${you ? '.you' : ''}`, { 'data-slot': slot, 'data-seat': String(seat), role: 'group', 'aria-label': p.name }, who, hole);
    const bet = h('div.bet.empty', { 'data-slot': slot, 'aria-hidden': 'true' });
    this.area.append(root, bet);
    // The other moods, so a change of face shows at once (setFaceMood keeps the old face until the new one is in).
    // After the relaxed face, which the table shows first.
    void preloadFaces([p]).then(() => Promise.all((['confident', 'nervous', 'annoyed', 'smug'] as Mood[]).map((mood) => preloadFaces([p], mood))));
    return { root, avatar, hole, tag, stack, tell, bet, shown };
  }

  private pause(ms: number): Promise<void> {
    return wait(paced(ms, this.o.speed(), this.o.reduced()));
  }

  private get watching(): boolean {
    return this.o.viewer === null || this.allUp;
  }
  /** Play mode, the player out of the game: every card face up from now on, as when watching (seeAll). */
  private allUp = false;

  /** The player is out and watches the rest: the others' cards face up, folded hands left dimmed, as in watch mode. */
  seeAll(): void {
    if (this.allUp) return;
    this.allUp = true;
    this.renderAll();
  }

  // ---------- rendering from the model ----------

  private renderBoard(): void {
    const have = [...this.board.querySelectorAll<HTMLElement>('.card')].map((c) => c.dataset.card);
    const want = this.model.board;
    if (have.length > want.length || have.some((c, i) => c !== want[i])) this.board.replaceChildren();
    const cards = [...this.board.querySelectorAll('.card')].length;
    this.board.querySelectorAll('.slot').forEach((s) => s.remove());
    for (let i = cards; i < want.length; i++) {
      const c = cardEl(want[i]!, false);
      c.classList.add('arrive');
      this.board.append(c);
      requestAnimationFrame(() => requestAnimationFrame(() => flipUp(c)));
    }
    for (let i = want.length; i < 5; i++) this.board.append(h('div.slot'));
  }

  /** A seat's bet spot: its chips and amount, or empty. */
  private drawBet(seat: number, amount: number): void {
    const el = this.seatEls[seat]!.bet;
    el.classList.toggle('empty', amount <= 0);
    if (amount <= 0) {
      el.replaceChildren();
      el.dataset.amount = '0';
      return;
    }
    if (el.dataset.amount === String(amount)) return;
    el.dataset.amount = String(amount);
    el.replaceChildren(chipsEl(amount, 18, 6), h('span.amt', null, chips(amount)));
  }

  /**
   * The middle: the chips gathered from earlier streets (this street's bets sit in front of the seats), one stack, or
   * the main pot and side pots once there are any. `count` runs the number up from what was shown.
   */
  private renderPots(count = false, model: TableModel = this.model): void {
    const all = potsOfModel(model);
    const open = all.flatMap((p, i) => (this.paid.has(i) ? [] : [{ ...p, index: i }]));
    const bets = model.seats.reduce((a, p) => a + p.bet, 0);
    const middle = Math.max(0, model.middle);
    // Side pots show once the street's bets are in (before that, the side pots still include bets in front).
    if (all.length > 1 && open.length && bets === 0) {
      const labels = potLabels(all);
      this.pots.replaceChildren(...open.map((p) => h('span.pot', { 'data-pot': String(p.index) }, chipsEl(p.amount, 16, 6), h('span.lbl', null, labels[p.index]!.label), h('b.n', null, chips(p.amount)))));
      this.potShown = middle;
      return;
    }
    if (middle <= 0) {
      this.pots.replaceChildren();
      this.potShown = 0;
      return;
    }
    const n = h('b.n', null, chips(count ? this.potShown : middle));
    this.pots.replaceChildren(h('span.pot', { 'data-pot': String(open[0]?.index ?? 0) }, chipsEl(middle, 16, 6), h('span.lbl', null, 'Pot'), n));
    if (count) this.count(n, this.potShown, middle, this.motion(260));
    this.potShown = middle;
  }

  private renderSeat(seat: number): void {
    const m = this.model.seats[seat]!;
    const e = this.seatEls[seat]!;
    e.stack.textContent = chips(m.stack);
    e.root.classList.toggle('folded', m.folded);
    e.root.classList.toggle('showing', m.shown !== null);
    const place = this.placesShown[seat];
    e.root.classList.toggle('out', !m.dealt && m.stack === 0 && place !== null && place !== undefined);
    // The tag: the last action, the finishing place of a player who is out.
    if (!m.dealt && place) this.setTag(seat, ordinal(place), 'place');
    else if (m.won > 0 && this.model.street === 'done') this.setTag(seat, `Won ${chips(m.won)}`, 'winner');
    else if (m.last) this.setTag(seat, actionTag(m.last.kind, m.last.allIn), m.last.allIn ? 'allin' : m.last.kind);
    else if (!e.root.classList.contains('thinking')) this.setTag(seat, null);
    // The bet in front of the seat: always laid out (chips fly to it), empty without a bet.
    this.drawBet(seat, m.bet);
    // Hole cards: yours and (watching) everyone's face up, the others' backs; a folded hand is mucked in play.
    const cards = m.cards;
    const mucked = m.folded && !this.watching && seat !== this.o.viewer;
    if (!cards || mucked) e.hole.replaceChildren();
    else {
      const up = seat === this.o.viewer || this.watching || m.shown !== null;
      const have = [...e.hole.querySelectorAll<HTMLElement>('.card')];
      const same = have.length === 2 && have.every((c, i) => (c.dataset.card ?? '') === (cards[i] ?? ''));
      if (!same) e.hole.replaceChildren(...[0, 1].map((i) => cardEl(cards[i] ?? null, up)));
      else if (up) have.forEach(flipUp);
    }
    if (m.shown) {
      e.shown.hidden = false;
      e.shown.textContent = handName(m.shown);
    } else e.shown.hidden = true;
  }

  private renderAll(): void {
    this.model.seats.forEach((_, seat) => this.renderSeat(seat));
    this.renderBoard();
    this.renderPots();
    this.dealer.dataset.slot = this.slots[this.model.button]!;
  }

  private setTag(seat: number, text: string | null, kind = ''): void {
    const tag = this.seatEls[seat]!.tag;
    tag.hidden = text === null;
    tag.textContent = text ?? '';
    tag.className = kind ? `tag t-${kind}` : 'tag';
  }

  // ---------- the animations ----------

  /** A motion's length at the watch speed (0 with reduced motion: the table updates at once). */
  private motion(ms: number): number {
    return this.o.reduced() ? 0 : paced(ms, this.o.speed(), false);
  }

  /** The centre of an element in the felt area's coordinates. */
  private centre(el: Element): { x: number; y: number } {
    const a = this.area.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: r.left - a.left + r.width / 2, y: r.top - a.top + r.height / 2 };
  }

  /** Moves a throwaway element from one place to another, and removes it. `fade` thins and shrinks it on the way. */
  private async fly(make: () => HTMLElement, from: Element, to: Element, duration: number, fade = false): Promise<void> {
    if (duration <= 0) return;
    const a = this.centre(from);
    const b = this.centre(to);
    const el = make();
    el.style.transform = `translate(${a.x}px, ${a.y}px) translate(-50%, -50%)`;
    el.style.transition = `transform ${duration}ms cubic-bezier(0.3, 0.7, 0.25, 1), opacity ${duration}ms ease-in`;
    this.fx.append(el);
    el.getBoundingClientRect();
    el.style.transform = `translate(${b.x}px, ${b.y}px) translate(-50%, -50%)${fade ? ' scale(0.7) rotate(-12deg)' : ''}`;
    if (fade) el.style.opacity = '0';
    await wait(duration);
    el.remove();
  }

  /** A stack of chips for an amount, sliding from one place to another: a bigger, taller push for an all-in. */
  private flyChips(amount: number, from: Element, to: Element, duration: number, big = false): Promise<void> {
    return this.fly(() => h('div.flying-chips', null, chipsEl(amount, big ? 24 : 20, big ? 9 : 6)), from, to, duration);
  }

  /**
   * Runs a number on screen from one amount to another over `ms` (a newer count on the same element wins). With no
   * time (reduced motion), it jumps there and glows a moment instead.
   */
  private count(el: HTMLElement, from: number, to: number, ms: number): void {
    const id = String(Number(el.dataset.count ?? 0) + 1);
    el.dataset.count = id;
    if (from === to || ms <= 0) {
      el.textContent = chips(to);
      if (from !== to) {
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
      }
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      if (el.dataset.count !== id) return;
      const k = Math.min(1, (now - start) / ms);
      el.textContent = chips(Math.round(from + (to - from) * (1 - (1 - k) ** 2)));
      if (k < 1) requestAnimationFrame(tick);
    };
    el.textContent = chips(from);
    requestAnimationFrame(tick);
  }

  /** Plays new events of the hand in play, one at a time, then lines the table up with the snapshot. */
  async play(events: readonly HandEvent[], snap: TableSnapshot): Promise<void> {
    for (const e of events) await this.playEvent(e);
    this.sync(snap);
  }

  /** Every bet in front of the seats sweeps into the middle, one after another, the pot counting up as each lands. */
  private async sweep(before: TableModel): Promise<void> {
    const bets = before.seats.flatMap((p, seat) => (p.bet > 0 ? [{ seat, bet: p.bet }] : []));
    if (!bets.length) return;
    const dur = this.motion(380);
    const stagger = this.motion(90);
    let pot = Math.max(0, before.middle);
    // The pot to count: one stack while it sweeps, the side pots drawn after.
    const potEl = (): HTMLElement => {
      let n = this.pots.querySelector<HTMLElement>('.pot[data-pot="0"] .n');
      if (!n || this.pots.childElementCount > 1) {
        n = h('b.n', null, chips(pot));
        this.pots.replaceChildren(h('span.pot', { 'data-pot': '0' }, chipsEl(Math.max(pot, 1), 16, 6), h('span.lbl', null, 'Pot'), n));
      }
      return n;
    };
    await Promise.all(
      bets.map(async ({ seat, bet }, i) => {
        await wait(i * stagger);
        const spot = this.seatEls[seat]!.bet;
        const chipsAt = spot.querySelector('.pchips') ?? spot;
        const flight = this.fly(() => h('div.flying-chips', null, chipsEl(bet, 18, 6)), chipsAt, this.pots, dur);
        this.drawBet(seat, 0);
        await flight;
        audio.play('chip', { gain: 0.45 });
        const n = potEl();
        this.count(n, pot, pot + bet, this.motion(200));
        pot += bet;
      }),
    );
    this.potShown = pot;
  }

  /** A folded hand slides to the middle and is gone (in play), or stays dimmed with a copy tossed in (watching). */
  private async muck(seat: number): Promise<void> {
    const cards = [...this.seatEls[seat]!.hole.querySelectorAll<HTMLElement>('.card')];
    const dur = this.motion(360);
    await Promise.all(cards.map((c, i) => wait(i * 50).then(() => this.fly(() => cardEl(null, false), c, this.board, dur, true))));
  }

  private async playEvent(e: HandEvent): Promise<void> {
    const before = this.model;
    this.model = applyEvent(before, e);
    switch (e.type) {
      case 'start':
        this.clearBanner();
        this.best.clear();
        this.paid.clear();
        this.potShown = 0;
        for (const el of this.seatEls) {
          el.root.classList.remove('to-act', 'thinking');
          el.hole.replaceChildren();
        }
        this.board.replaceChildren();
        this.renderAll();
        audio.play('shuffle');
        await this.pause(380);
        break;
      case 'post':
        this.renderSeat(e.seat);
        this.renderPots();
        break;
      case 'hole': {
        const seatEl = this.seatEls[e.seat]!;
        audio.play('deal');
        await this.fly(() => cardEl(null, false), this.dealer, seatEl.avatar, this.motion(230));
        this.renderSeat(e.seat);
        await this.pause(60);
        break;
      }
      case 'action': {
        const seat = this.seatEls[e.seat]!;
        const was = before.seats[e.seat]!;
        const now = this.model.seats[e.seat]!;
        if (e.kind === 'fold') {
          audio.play('fold');
          await this.muck(e.seat);
          this.renderSeat(e.seat);
          await this.pause(160);
          break;
        }
        if (e.kind === 'check') {
          audio.play('check');
          this.renderSeat(e.seat);
          await this.pause(220);
          break;
        }
        // Chips in: the stack counts down as a stack of chips slides out to the bet spot; the bet counts up as it lands.
        const big = e.allIn || e.kind === 'allin';
        const dur = this.motion(big ? 470 : 380);
        if (big) audio.play('allin');
        this.count(seat.stack, was.stack, now.stack, dur);
        seat.bet.classList.remove('landed');
        await this.flyChips(e.add, seat.avatar, seat.bet, dur, big);
        audio.play(big ? 'chips' : 'chip');
        this.renderSeat(e.seat);
        const amt = seat.bet.querySelector<HTMLElement>('.amt');
        if (amt) this.count(amt, was.bet, now.bet, this.motion(220));
        void seat.bet.offsetWidth;
        seat.bet.classList.add('landed');
        seat.stack.textContent = chips(now.stack);
        await this.pause(big ? 260 : 180);
        break;
      }
      case 'street': {
        await this.sweep(before);
        this.renderAll();
        audio.play('flip');
        await this.pause(e.street === 'flop' ? 620 : 480);
        break;
      }
      case 'return':
        this.renderSeat(e.seat);
        this.renderPots();
        break;
      case 'showdown':
        this.best = new Map(e.hands.map((x) => [x.seat, new Set(x.best.map(formatCard))]));
        for (const hand of e.hands) {
          audio.play('flip');
          this.renderSeat(hand.seat);
          await this.pause(520);
        }
        break;
      case 'award': {
        // The river's bets (or an uncontested hand's) go in first.
        if (before.seats.some((p) => p.bet > 0)) {
          await this.sweep(before);
          this.model.seats.forEach((_, seat) => this.drawBet(seat, 0));
          await this.pause(150);
        }
        // The pots as they stood before this one is paid.
        this.renderPots(false, { ...this.model, middle: this.model.middle + e.amount });
        // This pot slides to its winners, split in shares; each winner's stack counts up as its share lands.
        const from = this.pots.querySelector(`.pot[data-pot="${e.pot}"]`) ?? this.pots.querySelector('.pot') ?? this.pots;
        const dur = this.motion(440);
        audio.play('win');
        this.paid.add(e.pot);
        const flights = e.winners.map((w, k) => this.flyChips(e.shares[k]!, from, this.seatEls[w]!.avatar, dur, e.shares[k]! > 20 * this.model.bb));
        (from as HTMLElement).classList?.add('paying');
        await Promise.all(flights);
        audio.play('chips');
        this.renderPots();
        this.model.seats.forEach((_, seat) => this.renderSeat(seat));
        e.winners.forEach((w) => this.count(this.seatEls[w]!.stack, before.seats[w]!.stack, this.model.seats[w]!.stack, this.motion(320)));
        this.lightWinners(e.winners);
        await this.pause(300);
        break;
      }
      case 'end':
        this.renderAll();
        break;
    }
  }

  /** Lights the cards that make the winners' hands. */
  private lightWinners(winners: readonly number[]): void {
    for (const w of winners) {
      const best = this.best.get(w);
      if (!best) continue;
      for (const c of [...this.board.querySelectorAll<HTMLElement>('.card'), ...this.seatEls[w]!.hole.querySelectorAll<HTMLElement>('.card')]) if (best.has(c.dataset.card ?? '')) c.classList.add('win');
    }
  }

  /** Lines the table up with the driver's snapshot: stacks, bets, cards, pots, the seat to act, finishing places. */
  sync(snap: TableSnapshot): void {
    this.placesShown = [...snap.places];
    const v = snap.view;
    v.players.forEach((p, seat) => {
      const m = this.model.seats[seat]!;
      m.stack = p.stack;
      m.bet = p.bet;
      if (p.cards && (!m.cards || m.cards.length === 0)) m.cards = [...p.cards];
    });
    this.model.board = [...v.board];
    this.model.button = v.button;
    this.model.middle = v.street === 'done' ? 0 : v.pot - v.players.reduce((a, p) => a + p.bet, 0);
    if (v.street === 'done') for (const m of this.model.seats) m.bet = 0;
    this.renderAll();
    this.seatEls.forEach((el, seat) => el.root.classList.toggle('to-act', v.toAct === seat));
  }

  // ---------- what the controller says on top ----------

  /** The seat to act is thinking: its ring runs down over its time bank. */
  thinking(seat: number, timeBankMs: number | null): void {
    const el = this.seatEls[seat]!;
    el.root.classList.add('thinking');
    el.root.style.setProperty('--bank', `${(timeBankMs ?? 30_000) / 1000}s`);
    this.setTag(seat, 'thinking…', 'thinking');
    if (el.tell) el.tell.hidden = false;
  }

  stopThinking(seat: number): void {
    const el = this.seatEls[seat]!;
    el.root.classList.remove('thinking');
    // Restart the ring next time.
    el.root.style.removeProperty('--bank');
  }

  /** What came with an AI's action: its face, its words, its tell. */
  showMeta(seat: number, meta: ActionMeta): void {
    const el = this.seatEls[seat]!;
    if (meta.mood) this.setMood(seat, meta.mood);
    if (meta.say) this.say(seat, meta.say);
    if (el.tell) {
      const bars = tellBars(meta.probabilities);
      el.tell.hidden = !bars;
      if (bars) [bars.fold, bars.call, bars.raise].forEach((p, i) => (el.tell!.children[i] as HTMLElement).style.setProperty('--p', String(Math.max(0.04, p))));
    }
  }

  setMood(seat: number, mood: Mood): void {
    setFaceMood(this.seatEls[seat]!.avatar, this.people[seat]!, mood);
  }

  /** A speech bubble with table talk, gone after a few seconds. */
  say(seat: number, text: string): void {
    const root = this.seatEls[seat]!.root;
    root.querySelector('.bubble')?.remove();
    clearTimeout(this.bubbles.get(seat));
    const b = h('div.bubble', { role: 'status' }, h('span.bubble-text', null, `“${text}”`));
    b.title = text;
    root.querySelector('.who')!.append(b);
    // Long enough to read: longer for more words, shorter when the table is sped up (view-model.ts).
    const life = bubbleMs(text, this.o.speed());
    this.bubbles.set(
      seat,
      window.setTimeout(() => {
        b.classList.add('fade');
        setTimeout(() => b.remove(), 400);
      }, life),
    );
  }

  /** A line across the felt. */
  banner(title: string, sub?: string, kind: 'win' | 'ko' = 'win'): void {
    this.clearBanner();
    this.bannerEl = h(`div.banner${kind === 'ko' ? '.ko' : ''}`, { role: 'status' }, title, sub ? h('small', null, sub) : null);
    this.area.append(this.bannerEl);
  }

  clearBanner(): void {
    this.bannerEl?.remove();
    this.bannerEl = null;
  }

  /** The seat's name, for lines the controller writes. */
  nameOf(seat: number): string {
    return this.people[seat]!.name;
  }

  person(seat: number): SeatPerson {
    return this.people[seat]!;
  }

  /** Puts every face back to relaxed (a new hand). */
  relax(): void {
    this.people.forEach((_, seat) => this.setMood(seat, 'relaxed'));
    this.seatEls.forEach((el) => {
      if (el.tell) el.tell.hidden = true;
    });
  }
}
