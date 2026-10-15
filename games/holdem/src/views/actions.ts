// Your turn: one row of buttons (fold, check or call, the menu's sizes with their chips, Raise…, all-in) and, from
// Raise…, a small panel over the bar with a raise of your own: a brass slider with a chip for a thumb, ticks at the
// menu's sizes that it snaps to, the amount in big blinds and as a share of the pot, −/+ by the minimum raise, and a
// confirm button. On a narrow bar (a phone, or the table's column beside the chat) the row keeps only fold, check or
// call, Raise… and all-in, and the menu's sizes ride over it as a slim row of chips, one tap each (style.css shows the
// chips or the size buttons, by the bar's width; the chips' row keeps its place on a narrow bar even when it is empty).
// Keys: F fold, C check or call, 1 to 4 the sizes, A all-in, R opens the raise panel (arrows adjust, Enter confirms,
// Esc closes). The keys do nothing while a dialog (the hand review, the end, Leave?) covers the table.
import type { Action } from '../../shared/engine.ts';
import { h } from '../dom.ts';
import type { HumanTurn } from '../driver.ts';
import { chips, menuButtons, quickBets } from '../view-model.ts';

/** What the raise panel says about an amount: the pot and the big blind it is measured against. */
export interface TableContext {
  /** Every chip in the middle, this street's bets included. */
  pot: number;
  bb: number;
}

/** The raise panel's numbers for a turn: its range, its step, and where the menu's sizes fall on it. */
export function raisePlan(turn: HumanTurn, ctx: TableContext) {
  const r = turn.raise!;
  const currentBet = turn.options.find((o) => o.key === 'call' || o.key === 'check')!.to;
  const step = Math.max(1, Math.min(r.max - r.min, r.min - currentBet || ctx.bb));
  const base = ctx.pot + turn.toCall;
  const share = (to: number) => (base > 0 ? Math.round((100 * (to - currentBet)) / base) : 0);
  // The menu's sizes as the buttons name them ("2.5 BB", "½ pot", "Pot"), short as the slider's ticks.
  const quick = menuButtons(turn.options).flatMap((b) => {
    const o = turn.options.find((x) => x.key === b.key)!;
    return b.look === 'raise' && o.to >= r.min && o.to <= r.max ? [{ to: o.to, label: b.size ?? '' }] : [];
  });
  const ticks = quick.filter((q) => q.to > r.min && q.to < r.max).map((q) => ({ to: q.to, label: q.label.replace(/ pot$/, '') }));
  return { min: r.min, max: r.max, step, currentBet, ticks, quick, share, bet: turn.options.some((o) => o.kind === 'bet') };
}

/**
 * Where an amount sits on the slider, 0 to 1, and back. The scale is a cube: the small raises people make most get
 * most of the track, and the deep end runs on to all-in.
 */
export const positionOf = (amount: number, plan: { min: number; max: number }): number => (plan.max > plan.min ? Math.cbrt(Math.max(0, Math.min(1, (amount - plan.min) / (plan.max - plan.min)))) : 0);
export const amountAt = (position: number, plan: { min: number; max: number }): number => Math.round(plan.min + (plan.max - plan.min) * Math.max(0, Math.min(1, position)) ** 3);

/** Snaps an amount to the nearest tick within 2% of the track, else to whole chips within the range. */
export function snap(v: number, plan: { min: number; max: number; ticks: { to: number }[] }): number {
  const at = positionOf(v, plan);
  const t = plan.ticks.filter((x) => Math.abs(positionOf(x.to, plan) - at) <= 0.02).sort((a, b) => Math.abs(a.to - v) - Math.abs(b.to - v))[0];
  return Math.max(plan.min, Math.min(plan.max, Math.round(t ? t.to : v)));
}

/** Shows the bar in `host` and resolves with the action chosen. */
export function askAction(host: HTMLElement, turn: HumanTurn, signal: AbortSignal, ctx: TableContext = { pot: 0, bb: 1 }): Promise<Action> {
  return new Promise((resolve, reject) => {
    const done = (a: Action) => {
      cleanup();
      resolve(a);
    };
    const buttons = menuButtons(turn.options);
    const quick = quickBets(turn.options);
    const canRaise = !!turn.raise && turn.raise.max > turn.raise.min;
    // data-custom: Raise… is there, so a narrow bar can leave the sizes to the chips over it.
    const menu = h('div.menu', { role: 'group', 'aria-label': 'Your options', 'data-custom': canRaise });
    const button = (b: (typeof buttons)[number]) => {
      const key = b.shortcut ?? quick.find((q) => q.key === b.key)?.shortcut;
      return h(
        `button.act.${b.look}`,
        { type: 'button', 'aria-label': b.label + (key ? ` (${key})` : ''), onclick: () => done({ key: b.key }) },
        b.verb ? h('span.what', null, h('span.verb', null, `${b.verb} `), b.size ?? '') : h('span.what', null, b.what),
        b.amount ? h('span.amt', null, b.amount) : null,
        key ? h('kbd', null, key) : null,
      );
    };
    // The sizes as chips over a narrow bar: "½ pot · 96", one tap raises. The row is there, empty, when there are none.
    const chipRow = h(
      'div.quick',
      quick.length ? { role: 'group', 'aria-label': 'Sizes' } : { 'aria-hidden': 'true' },
      ...quick.map((q) =>
        h('button.qb', { type: 'button', 'aria-label': `${q.label} (${q.shortcut})`, onclick: () => done({ key: q.key }) }, h('span.qs', null, q.size, q.word ? h('span.qw', null, q.word) : null), h('b.qa', null, q.amount), h('kbd', null, q.shortcut)),
      ),
    );
    const allin = buttons.find((b) => b.look === 'allin');
    for (const b of buttons) if (b !== allin) menu.append(button(b));

    /** The slider at its top is the all-in. */
    const raiseTo = (to: number): Action => (turn.raise && to >= turn.raise.max ? { key: 'allin' } : { kind: 'raise', to });
    let panel: HTMLElement | null = null;
    let opener: HTMLButtonElement | null = null;
    let slider: HTMLInputElement | null = null;
    const closePanel = (focusOpener = true) => {
      panel?.remove();
      panel = null;
      slider = null;
      opener?.setAttribute('aria-expanded', 'false');
      if (focusOpener) opener?.focus({ preventScroll: true });
    };
    const openPanel = () => {
      if (!canRaise || !opener) return;
      if (panel) return slider?.focus();
      const plan = raisePlan(turn, ctx);
      const verb = plan.bet ? 'Bet' : 'Raise to';
      let value = plan.ticks[0]?.to ?? plan.min;
      const amount = h('b.rp-amount', null, chips(value));
      const facts = h('span.rp-facts');
      const range = h('input.rp-range', { type: 'range', min: 0, max: 1000, step: 1, value: Math.round(positionOf(value, plan) * 1000), 'aria-label': `${verb}, from ${chips(plan.min)} to ${chips(plan.max)} chips` }) as HTMLInputElement;
      const confirm = h('button.rp-go', { type: 'button' }) as HTMLButtonElement;
      const set = (v: number) => {
        value = Math.max(plan.min, Math.min(plan.max, v));
        range.value = String(Math.round(positionOf(value, plan) * 1000));
        range.setAttribute('aria-valuenow', String(value));
        const all = value >= plan.max;
        amount.textContent = chips(value);
        const bbs = ctx.bb > 0 ? Math.round((10 * value) / ctx.bb) / 10 : 0;
        facts.textContent = all ? 'all-in' : `${bbs} big blinds, ${plan.share(value)}% of the pot`;
        range.style.setProperty('--fill', `${positionOf(value, plan) * 100}%`);
        range.setAttribute('aria-valuetext', `${verb} ${chips(value)} chips${all ? ', all-in' : `, ${bbs} big blinds`}`);
        confirm.textContent = all ? `All-in for ${chips(value)}` : `${verb} ${chips(value)}`;
        confirm.classList.toggle('all', all);
      };
      range.addEventListener('input', () => set(snap(amountAt(Number(range.value) / 1000, plan), plan)));
      range.addEventListener('keydown', (e) => {
        const by = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? plan.step : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -plan.step : e.key === 'PageUp' ? 4 * plan.step : e.key === 'PageDown' ? -4 * plan.step : 0;
        if (e.key === 'Home') set(plan.min);
        else if (e.key === 'End') set(plan.max);
        else if (by) set(value + by);
        else return;
        e.preventDefault();
      });
      confirm.addEventListener('click', () => done(raiseTo(value)));
      // A mark for every size; a label only where it has room (from the right, so Pot keeps its label).
      let lastLabel = 2;
      const marks = [...plan.ticks].reverse().map((t) => {
        const at = positionOf(t.to, plan);
        const labelled = lastLabel - at >= 0.1;
        if (labelled) lastLabel = at;
        return h(`button.rp-tick${labelled ? '' : '.mark-only'}`, { type: 'button', tabindex: '-1', title: t.label, style: { left: `${at * 100}%` }, onclick: () => (set(t.to), range.focus()) }, labelled ? t.label : '');
      });
      const ticks = h('div.rp-ticks', { 'aria-hidden': 'true' }, ...marks.reverse());
      const stepBtn = (sign: 1 | -1) => h('button.rp-step', { type: 'button', 'aria-label': `${sign > 0 ? 'More' : 'Less'}, by ${chips(plan.step)}`, onclick: () => (set(value + sign * plan.step), range.focus()) }, sign > 0 ? '+' : '−');
      panel = h(
        'div.raise-panel',
        { role: 'dialog', 'aria-label': `${verb}: choose an amount` },
        h('div.rp-head', null, h('span.rp-verb', null, verb), amount, facts, h('button.rp-close', { type: 'button', 'aria-label': 'Close (Esc)', onclick: () => closePanel() }, '×')),
        h('div.rp-track', null, stepBtn(-1), h('div.rp-rail', null, range, ticks), stepBtn(1)),
        h('div.rp-ends', { 'aria-hidden': 'true' }, h('span', null, chips(plan.min)), h('span', null, `All-in ${chips(plan.max)}`)),
        confirm,
      );
      set(value);
      host.append(panel);
      place();
      opener.setAttribute('aria-expanded', 'true');
      range.focus({ preventScroll: true });
      slider = range;
    };
    /** Over the bar, centred on Raise… on a wide screen (kept inside the bar); the bar's width on a phone. */
    const place = () => {
      if (!panel || !opener) return;
      const bar = host.getBoundingClientRect();
      const b = opener.getBoundingClientRect();
      const w = panel.offsetWidth;
      const centre = b.left - bar.left + b.width / 2;
      const left = Math.max(8, Math.min(bar.width - w - 8, centre - w / 2));
      panel.style.left = `${left}px`;
      // The panel's tail points at Raise….
      panel.style.setProperty('--tail', `${Math.max(16, Math.min(w - 16, centre - left))}px`);
    };
    if (canRaise) {
      const plan = raisePlan(turn, ctx);
      opener = h('button.act.custom', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-label': `${plan.bet ? 'Bet' : 'Raise'} an amount of your own (R)`, onclick: () => (panel ? closePanel() : openPanel()) }, h('span.what', null, plan.bet ? 'Bet…' : 'Raise…'), h('span.amt', null, `${chips(plan.min)}+`), h('kbd', null, 'R')) as HTMLButtonElement;
      menu.append(opener);
    }
    if (allin) menu.append(button(allin));
    host.replaceChildren(chipRow, menu, h('p.hint', null, `Keys: F fold, C check or call, ${quick.length ? `${quick.length > 1 ? `1–${quick.length}` : '1'} sizes, ` : ''}R raise, A all-in`));
    host.hidden = false;
    (menu.querySelector('button.call') as HTMLElement | null)?.focus({ preventScroll: true });

    /** A dialog over the table (the review, the end): the bar's keys are off. */
    const covered = () => document.querySelector('.overlay') !== null;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || covered()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range'))) return;
      if (panel) {
        if (e.key === 'Escape') closePanel();
        else if (e.key === 'Enter' && t?.tagName !== 'BUTTON') (panel.querySelector('.rp-go') as HTMLButtonElement).click();
        else if (e.key.toLowerCase() === 'r') slider?.focus();
        else return;
        e.preventDefault();
        return;
      }
      const k = e.key.toLowerCase();
      const has = (key: string) => turn.options.some((o) => o.key === key);
      if (k === 'f' && has('fold')) done({ key: 'fold' });
      else if (k === 'c' && (has('check') || has('call'))) done({ key: has('check') ? 'check' : 'call' });
      else if (k === 'a' && has('allin')) done({ key: 'allin' });
      else if (k === 'r' && canRaise) openPanel();
      else {
        const size = quick.find((q) => q.shortcut === e.key);
        if (!size) return;
        done({ key: size.key });
      }
      e.preventDefault();
    };
    /** A tap outside the panel (and not on Raise…) closes it. */
    const onDown = (e: PointerEvent) => {
      if (panel && !panel.contains(e.target as Node) && !opener?.contains(e.target as Node)) closePanel(false);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Left the table', 'AbortError'));
    };
    const cleanup = () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', place);
      signal.removeEventListener('abort', onAbort);
      host.replaceChildren();
      host.hidden = true;
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', place);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
