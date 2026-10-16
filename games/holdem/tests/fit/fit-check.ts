// A browser check (not a vitest file): does everything at the table sit inside the room? Load the page in a browser
// (a dev server, ?practice), then in its console or a test driver:
//
//   const fit = await import('/holdem/tests/fit/fit-check.ts');
//   fit.measure();                                  // the table on screen now: a list of problems, [] when it fits
//   await fit.matrix({ modes: ['play', 'watch'], seats: [2, 3, 4, 5, 6] });   // starts each table from the lobby
//   await fit.matrix({ modes: ['play'], handover: true, bust: true });        // and the bar between hands, and going out
//
// Every seat (face, name plate, tag, tell, hole cards), bet, the dealer button and every speech bubble must sit inside
// the room with MARGIN px to spare, below the toolbar, and above the action bar's row; nothing at the table may
// overlap another seat's face, plate or cards (a bubble may cover a bet or the button), and the action bar keeps to one
// row clear of every seat and the board. A bubble shows its whole line (talk is at most 90 characters): nothing cut off.
// With the chat open beside the table (a wide screen) no bubble shows at all: matrix() checks that while it plays. The
// room's height is recorded so a caller can check it does not change during a game.
//
// The action bar's place (--bar-h) is kept the whole game, so whatever shows there (your options, Deal the next hand
// and Review between hands, a refused move's line) must fit it: measureBar() checks every control is inside the bar's
// own box and the room, shows its whole label, and keeps clear of the seats and the board. With handover, matrix() folds
// once and measures the bar between hands too; with bust, it then goes all-in until you are out and measures the
// poster that covers the room (Watch the rest, or the end of the game): inside the room, its buttons all reachable.

import { bubbleSize } from '../../src/view-model.ts';

export const MARGIN = 8;

type Box = { l: number; t: number; r: number; b: number };
const box = (e: Element): Box => {
  const r = e.getBoundingClientRect();
  return { l: r.left, t: r.top, r: r.right, b: r.bottom };
};
const union = (bs: Box[]): Box => bs.reduce((a, b) => ({ l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b) }));
const meet = (a: Box, b: Box) => a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;
const seen = (e: Element) => {
  const r = e.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
};

/** A seat's visible parts: face, plate, tag, tell and hole cards (not its bubble). */
function seatParts(seat: Element): Box[] {
  return [...seat.querySelectorAll('.avatar-wrap, .plate, .tag:not([hidden]), .tell:not([hidden]), .hole .card, .shown-name:not([hidden])')].filter(seen).map(box);
}

/** The problems with the table on screen now ([] when everything fits). */
export function measure(room: Element = document.querySelector('#room')!): string[] {
  const out: string[] = [];
  const felt = room.querySelector('.felt-area');
  if (!felt) return ['no table in the room'];
  const R = box(room);
  const toolbar = room.querySelector('.toolbar');
  const top = Math.max(R.t, toolbar ? box(toolbar).b : R.t) + MARGIN;
  // The table's own space: the felt (the action bar's row and the chat column are not the table's).
  const F = box(felt);
  // MARGIN from the room's edges and the toolbar; within the felt where it meets the action bar or the chat column.
  const area = { l: Math.max(R.l + MARGIN, F.l), t: top, r: Math.min(R.r - MARGIN, F.r), b: Math.min(R.b - MARGIN, F.b) };
  const inside = (name: string, b: Box) => {
    const miss = [b.l < area.l && `left ${Math.round(area.l - b.l)}`, b.t < area.t && `top ${Math.round(area.t - b.t)}`, b.r > area.r && `right ${Math.round(b.r - area.r)}`, b.b > area.b && `bottom ${Math.round(b.b - area.b)}`].filter(Boolean);
    if (miss.length) out.push(`${name} outside by ${miss.join(', ')} px`);
  };
  const seats = [...room.querySelectorAll('.seat')];
  const parts = seats.map((s) => ({ slot: (s as HTMLElement).dataset.slot ?? '?', boxes: seatParts(s) }));
  for (const p of parts) if (p.boxes.length) inside(`seat ${p.slot}`, union(p.boxes));
  for (const b of room.querySelectorAll('.bet:not(.empty), .dealer')) if (seen(b)) inside(`${b.className.split(' ')[0]} ${(b as HTMLElement).dataset.slot ?? ''}`.trim(), box(b));
  // Seats against seats.
  for (let i = 0; i < parts.length; i++)
    for (let j = i + 1; j < parts.length; j++)
      if (parts[i]!.boxes.some((a) => parts[j]!.boxes.some((b) => meet(a, b)))) out.push(`seat ${parts[i]!.slot} meets seat ${parts[j]!.slot}`);
  // The action bar: one row, inside the room, clear of every seat and the board.
  const menu = room.querySelector('.actions:not([hidden]) .menu');
  if (menu && seen(menu)) {
    const buttons = [...menu.querySelectorAll('.act')].filter(seen);
    if (new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size > 1) out.push('the action bar wraps onto a second row');
    const M = box(menu);
    if (M.l < R.l || M.r > R.r || M.b > R.b) out.push('the action bar leaves the room');
    for (const p of parts) if (p.boxes.some((b) => meet(M, b))) out.push(`the action bar meets seat ${p.slot}`);
    for (const c of room.querySelectorAll('.board .card, .board .slot')) if (meet(M, box(c))) out.push('the action bar meets the board');
  }
  // The folded chat, docked at the room's foot: clear of the seats, the board and the action bar.
  const dock = room.querySelector('.chat:not(.open)');
  if (dock && seen(dock) && getComputedStyle(dock).position === 'absolute') {
    const D = box(dock);
    for (const p of parts) if (p.boxes.some((b) => meet(D, b))) out.push(`the folded chat meets seat ${p.slot}`);
    for (const c of room.querySelectorAll('.board .card, .board .slot, .actions:not([hidden]) .act, .bet:not(.empty)')) if (seen(c) && meet(D, box(c))) out.push(`the folded chat meets ${c.closest('.board') ? 'the board' : c.classList.contains('act') ? 'the action bar' : 'a bet'}`);
  }
  // Bets, the button and the board against the seats (a bet or the button on a face, plate or card).
  const things = [...room.querySelectorAll('.bet:not(.empty), .dealer, .board .card, .board .slot, .pots .pot')].filter(seen);
  for (const t of things)
    for (const p of parts)
      if (p.boxes.some((b) => meet(box(t), b))) out.push(`${t.closest('.board') ? 'board' : t.className.split(' ')[0]}${(t as HTMLElement).dataset.slot ? ` ${(t as HTMLElement).dataset.slot}` : ''} on seat ${p.slot}`);
  // Bubbles: inside, and clear of other bubbles and of any seat's face, plate or cards (their own seat's cards too).
  const bubbles = [...room.querySelectorAll('.seat .bubble, .felt-area > .bubble')].filter(seen);
  const slotOf = (el: Element) => (el.closest('.seat') as HTMLElement | null)?.dataset.slot ?? 'middle';
  for (const [i, el] of bubbles.entries()) {
    const slot = slotOf(el);
    const b = box(el);
    inside(`bubble ${slot}`, b);
    const text = el.querySelector('.bubble-text') as HTMLElement | null;
    if (text && (text.scrollHeight > text.clientHeight + 1 || text.scrollWidth > text.clientWidth + 1)) out.push(`bubble ${slot} is cut off`);
    for (const other of bubbles.slice(i + 1)) if (meet(b, box(other))) out.push(`bubble ${slot} meets bubble ${slotOf(other)}`);
    for (const p of parts) {
      const own = p.slot === slot;
      const hits = (own ? [...(el.closest('.seat')?.querySelectorAll('.hole .card') ?? [])].filter(seen).map(box) : p.boxes).some((x) => meet(b, x));
      if (hits) out.push(`bubble ${slot} covers ${own ? 'its own cards' : `seat ${p.slot}`}`);
    }
    // The board's places count while they are empty: the cards come later in the hand.
    for (const c of room.querySelectorAll('.board .card, .board .slot')) if (meet(b, box(c))) out.push(`bubble ${slot} covers the board`);
  }
  return out;
}

/**
 * The action bar's contents against its reserved place: every control (and the keys line, where it shows) inside the
 * bar's box and the room, its label whole, clear of every seat and the board. The raise panel opens over the table on
 * purpose and is left out. [] when the bar is empty or away.
 */
export function measureBar(room: Element = document.querySelector('#room')!): string[] {
  const out: string[] = [];
  const bar = room.querySelector('.actions:not([hidden])');
  if (!bar || !seen(bar)) return out;
  const R = box(room);
  const B = box(bar);
  const parts = [...room.querySelectorAll('.seat')].map((s) => ({ slot: (s as HTMLElement).dataset.slot ?? '?', boxes: seatParts(s) }));
  const board = [...room.querySelectorAll('.board .card, .board .slot')].filter(seen).map(box);
  const items = [...bar.querySelectorAll('button, .hint, .error-line')].filter((e) => seen(e) && !e.closest('.raise-panel'));
  const name = (e: Element) => (e.matches('button') ? `“${(e.textContent ?? '').trim()}”` : `the ${e.className.split(' ')[0]} line`);
  const off = (b: Box, a: Box) => [b.l < a.l - 0.5 && `left ${Math.round(a.l - b.l)}`, b.t < a.t - 0.5 && `top ${Math.round(a.t - b.t)}`, b.r > a.r + 0.5 && `right ${Math.round(b.r - a.r)}`, b.b > a.b + 0.5 && `bottom ${Math.round(b.b - a.b)}`].filter(Boolean).join(', ');
  for (const e of items) {
    const b = box(e);
    const outBar = off(b, B);
    if (outBar) out.push(`${name(e)} leaves the action bar by ${outBar} px`);
    const outRoom = off(b, R);
    if (outRoom) out.push(`${name(e)} leaves the room by ${outRoom} px`);
    const el = e as HTMLElement;
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) out.push(`${name(e)} is cut off`);
    for (const p of parts) if (p.boxes.some((x) => meet(b, x))) out.push(`${name(e)} meets seat ${p.slot}`);
    if (board.some((x) => meet(b, x))) out.push(`${name(e)} meets the board`);
  }
  const el = bar as HTMLElement;
  if (el.scrollHeight > el.clientHeight + 1) out.push(`the action bar overflows its ${el.clientHeight} px by ${el.scrollHeight - el.clientHeight} px`);
  return out;
}

/** A poster over the table (the end, You finished…, Waking the models…): the room's own box, every button reachable. */
export function measureOverlay(room: Element = document.querySelector('#room')!): string[] {
  const out: string[] = [];
  const o = room.querySelector('.overlay') as HTMLElement | null;
  if (!o || !seen(o)) return out;
  const R = box(room);
  const O = box(o);
  if (Math.abs(O.l - R.l) > 1 || Math.abs(O.t - R.t) > 1 || Math.abs(O.r - R.r) > 1 || Math.abs(O.b - R.b) > 1) out.push('the poster does not cover the room');
  if (o.scrollWidth > o.clientWidth + 1) out.push(`the poster is ${o.scrollWidth - o.clientWidth} px too wide`);
  // Reachable: inside the overlay's width, and within its scroll height (it scrolls when the poster is taller).
  for (const b of o.querySelectorAll('button')) {
    if (!seen(b)) continue;
    const x = box(b);
    const label = `“${(b.textContent ?? '').trim() || b.getAttribute('aria-label')}”`;
    if (x.l < O.l - 0.5 || x.r > O.r + 0.5) out.push(`${label} on the poster leaves the room sideways`);
    if (x.b - O.t + o.scrollTop > o.scrollHeight + 0.5) out.push(`${label} on the poster cannot be scrolled to`);
    if (b.scrollWidth > b.clientWidth + 1) out.push(`${label} on the poster is cut off`);
  }
  return out;
}

/** One bubble at a time, over the middle: a table of five or six, or a phone (views/table.ts say()). */
const middleTalk = (room: Element) => room.querySelectorAll('.seat').length >= 5 || innerWidth < 760;

/**
 * Long talk on every seat that can talk (or `slot` alone), as the table would show it (views/table.ts say(): a table of
 * five or six, or a phone, shows it over the middle, with the name).
 */
export function talk(room: Element, text: string, slot?: string): void {
  room.querySelectorAll('.bubble').forEach((b) => b.remove());
  const felt = room.querySelector('.felt-area')!;
  if (middleTalk(room)) {
    const b = document.createElement('div');
    b.className = `bubble center${bubbleSize(text) === 'long' ? ' long' : ''}`;
    b.style.animation = 'none';
    b.innerHTML = `<b>${slot ?? 'Someone'}</b><span class="bubble-text"></span>`;
    b.querySelector('.bubble-text')!.textContent = `“${text}”`;
    felt.append(b);
    return;
  }
  for (const who of room.querySelectorAll(`.seat:not(.you)${slot ? `[data-slot='${slot}']` : ''} .who`)) {
    const b = document.createElement('div');
    b.className = `bubble${bubbleSize(text) === 'long' ? ' long' : ''}`;
    b.style.animation = 'none';
    const t = document.createElement('span');
    t.className = 'bubble-text';
    t.textContent = `“${text}”`;
    b.append(t);
    who.append(b);
  }
}

/** The longest talk there is: 90 characters (MAX_SAY). */
export const LONG = 'I have been waiting all night for a hand like this one, and here it is at last, my friend.';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (test: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await sleep(150);
  return test();
};

/** Every bubble placement the table can show, with the longest talk: all at once (up to four seats on a wide screen), else one seat at a time. */
export function measureTalk(room: Element = document.querySelector('#room')!): string[] {
  const out: string[] = [];
  if (!middleTalk(room)) {
    talk(room, LONG);
    out.push(...measure(room).filter((p) => p.includes('bubble')));
    talk(room, 'Call.');
    out.push(...measure(room).filter((p) => p.includes('bubble')));
  } else {
    for (const s of room.querySelectorAll('.seat:not(.you)')) {
      talk(room, LONG, (s as HTMLElement).dataset.slot);
      out.push(...measure(room).filter((p) => p.includes('bubble')));
    }
  }
  room.querySelectorAll('.bubble').forEach((b) => b.remove());
  return [...new Set(out)];
}

export interface MatrixResult {
  /** The window's width while it ran (a resize mid-run shows as more than one). */
  widths: number[];
  mode: string;
  seats: number;
  problems: string[];
  heights: number[];
  /** With handover: the room's heights between hands (Deal the next hand, Review), each must be one of `heights`. */
  handoverHeights?: number[];
  /** With bust: the room's heights under the poster when you went out. */
  bustHeights?: number[];
}

/**
 * Starts each table from the lobby (practice), lets it play a moment, measures it (spectating: the table with every
 * card up, as after you are out), then leaves. The room's heights seen while it played are returned with the problems.
 */
export async function matrix(o: { modes?: ('play' | 'watch' | 'spectate')[]; seats?: number[]; playMs?: number; chat?: 'open' | 'folded'; handover?: boolean; bust?: boolean } = {}): Promise<MatrixResult[]> {
  const results: MatrixResult[] = [];
  const room = document.querySelector('#room')!;
  for (const mode of o.modes ?? ['play', 'watch', 'spectate']) {
    for (const n of o.seats ?? [2, 3, 4, 5, 6]) {
      if (mode !== 'watch' && n < 2) continue;
      const click = (sel: string, text: string) => [...room.querySelectorAll<HTMLElement>(sel)].find((b) => b.textContent?.trim() === text)?.click();
      await until(() => !!room.querySelector('.lobby'), 5000);
      click('.modes button', mode === 'watch' ? 'Watch' : 'Play');
      await sleep(150);
      [...room.querySelectorAll<HTMLElement>('.set')].find((b) => b.textContent?.includes('Claude'))?.click();
      await sleep(150);
      const ai = mode === 'watch' ? n : n - 1;
      // Down to size, then up.
      while (room.querySelectorAll('.lineup li').length - (mode === 'watch' ? 0 : 1) > ai) {
        const remove = room.querySelector<HTMLButtonElement>('.lineup button.remove:not([disabled])');
        if (!remove) break;
        remove.click();
        await sleep(100);
      }
      while (room.querySelectorAll('.lineup li').length - (mode === 'watch' ? 0 : 1) < ai) {
        click('#room button', 'Add a seat');
        await sleep(100);
      }
      click('#room button.cta', mode === 'watch' ? 'Start the game' : 'Deal me in');
      await until(() => !!room.querySelector('.felt-area .seat'), 8000);
      if (mode === 'spectate') room.classList.add('all-up');
      // The chat as asked (a wide screen): open beside the table, or folded to its bar.
      const chat = room.querySelector('.chat');
      if (o.chat && chat && chat.classList.contains('open') !== (o.chat === 'open')) (chat.querySelector('.chat-collapse') as HTMLElement | null)?.click();
      await sleep(400);
      const heights = new Set<number>();
      // The chat open beside the table: talk shows there, never as a bubble.
      const chatBeside = () => innerWidth >= 1000 && !!room.querySelector('.chat.open');
      const widths = new Set<number>([innerWidth]);
      const problems = new Set<string>();
      // Playing: wait for your turn (the action bar), so it is measured too.
      if (mode === 'play') await until(() => !!room.querySelector('.actions:not([hidden]) .menu'), 8000);
      const end = Date.now() + (o.playMs ?? 6000);
      while (Date.now() < end) {
        heights.add(Math.round(room.getBoundingClientRect().height));
        widths.add(innerWidth);
        if (!room.querySelector('.overlay')) [...measure(room), ...measureBar(room)].forEach((p) => problems.add(p));
        if (chatBeside() && room.querySelector('.felt-area .bubble')) problems.add('a bubble shows with the chat open beside the table');
        await sleep(400);
      }
      if (!room.querySelector('.overlay') && !chatBeside()) measureTalk(room).forEach((p) => problems.add(p));
      const result: MatrixResult = { widths: [...widths], mode, seats: n, problems: [...problems], heights: [...heights] };
      // Between hands: fold (or check) at your next turn and wait for Deal the next hand.
      if (mode === 'play' && o.handover) {
        const hs = new Set<number>();
        const between = () => !!room.querySelector('.actions:not([hidden]) .handover');
        // Fold, or check where there is nothing to fold to, at each turn until the hand is over.
        const fold = () => (room.querySelector<HTMLElement>('.actions:not([hidden]) .act.fold') ?? room.querySelector<HTMLElement>('.actions:not([hidden]) .act.check'))?.click();
        if (await until(() => between() || !!room.querySelector('.actions:not([hidden]) .menu'), 20000)) {
          if (await until(() => (fold(), between()), 90000)) {
            await sleep(300);
            hs.add(Math.round(room.getBoundingClientRect().height));
            [...measure(room), ...measureBar(room)].forEach((p) => problems.add(`between hands: ${p}`));
            if (!room.querySelector('.actions .handover button')) problems.add('between hands: no Deal the next hand');
          } else problems.add('between hands: never came');
        }
        result.handoverHeights = [...hs];
        for (const x of hs) if (!heights.has(x)) problems.add(`between hands: the room is ${x} px high, ${[...heights].join('/')} px in the hand`);
      }
      // Out of the game: all-in at every turn (dealing on between hands) until the poster covers the table.
      if (mode === 'play' && o.bust) {
        const hs = new Set<number>();
        const end = Date.now() + 240000;
        while (Date.now() < end && !room.querySelector('.overlay')) {
          const deal = room.querySelector<HTMLElement>('.actions:not([hidden]) .handover .cta:not(.quiet)');
          const allin = room.querySelector<HTMLElement>('.actions:not([hidden]) .act.allin') ?? room.querySelector<HTMLElement>('.actions:not([hidden]) .act.call');
          (deal ?? allin)?.click();
          await sleep(300);
        }
        if (await until(() => !!room.querySelector('.overlay .poster'), 3000)) {
          await sleep(500);
          hs.add(Math.round(room.getBoundingClientRect().height));
          const poster = room.querySelector('.overlay .poster')?.getAttribute('aria-label') ?? 'the poster';
          measureOverlay(room).forEach((p) => problems.add(`${poster}: ${p}`));
          // You are out, three or more seats: watch the rest, and the bar stays away while the others play.
          const watch = [...room.querySelectorAll<HTMLElement>('.overlay button')].find((b) => b.textContent?.trim() === 'Watch the rest');
          if (watch) {
            watch.click();
            await sleep(1500);
            hs.add(Math.round(room.getBoundingClientRect().height));
            [...measure(room), ...measureBar(room)].forEach((p) => problems.add(`watching the rest: ${p}`));
          }
        } else problems.add('never went out');
        result.bustHeights = [...hs];
        for (const x of hs) if (!heights.has(x)) problems.add(`out of the game: the room is ${x} px high, ${[...heights].join('/')} px in the hand`);
      }
      result.problems = [...problems];
      results.push(result);
      // Leave (and say yes when it asks).
      room.querySelector<HTMLElement>('.tools button[aria-label="Leave"]')?.click();
      await sleep(200);
      click('.confirm-veil button', 'Leave');
      room.classList.remove('all-up');
      await sleep(300);
    }
  }
  return results;
}
