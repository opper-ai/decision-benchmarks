// A browser check (not a vitest file): does everything at the table sit inside the room? Load the page in a browser
// (a dev server, ?practice), then in its console or a test driver:
//
//   const fit = await import('/holdem/tests/fit/fit-check.ts');
//   fit.measure();                                  // the table on screen now: a list of problems, [] when it fits
//   await fit.matrix({ modes: ['play', 'watch'], seats: [2, 3, 4, 5, 6] });   // starts each table from the lobby
//
// Every seat (face, name plate, tag, tell, hole cards), bet, the dealer button and every speech bubble must sit inside
// the room with MARGIN px to spare, below the toolbar, and above the action bar's row; nothing at the table may
// overlap another seat's face, plate or cards (a bubble may cover a bet or the button), and the action bar keeps to one
// row clear of every seat and the board. A bubble shows its whole line (talk is at most 90 characters): nothing cut off.
// With the chat open beside the table (a wide screen) no bubble shows at all: matrix() checks that while it plays. The
// room's height is recorded so a caller can check it does not change during a game.

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
}

/**
 * Starts each table from the lobby (practice), lets it play a moment, measures it (spectating: the table with every
 * card up, as after you are out), then leaves. The room's heights seen while it played are returned with the problems.
 */
export async function matrix(o: { modes?: ('play' | 'watch' | 'spectate')[]; seats?: number[]; playMs?: number; chat?: 'open' | 'folded' } = {}): Promise<MatrixResult[]> {
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
        if (!room.querySelector('.overlay')) measure(room).forEach((p) => problems.add(p));
        if (chatBeside() && room.querySelector('.felt-area .bubble')) problems.add('a bubble shows with the chat open beside the table');
        await sleep(400);
      }
      if (!room.querySelector('.overlay') && !chatBeside()) measureTalk(room).forEach((p) => problems.add(p));
      results.push({ widths: [...widths], mode, seats: n, problems: [...problems], heights: [...heights] });
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
