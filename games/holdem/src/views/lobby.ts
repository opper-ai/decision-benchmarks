// The lobby: Play or Watch, an opponent set, and any seat changed from the model list. Who pays decides what can start:
// the chat models (Claude, GPT, Gemini, the Titans and the rest) play on the player's own Opper credits, so they ask a
// signed-out visitor to sign in first; the decision models play on the free credits while they last.
import { MAX_SEATS, MIN_SEATS } from '../../shared/sitngo.ts';
import { h } from '../dom.ts';
import type { SeatConfig } from '../driver.ts';
import { resumeLines } from '../reconnect.ts';
import type { Resumable } from '../remote-driver.ts';
import { GROUP_NAMES, GROUPS, MODELS, modelById, SETS } from '../roster.ts';
import { personOf } from '../view-model.ts';
import { avatarEl } from './parts.ts';

export type Mode = 'play' | 'watch';

export interface LobbyChoice {
  mode: Mode;
  setId: string;
  /** The AI seats, in seat order after you. */
  models: string[];
}

/** What the visitor may start: tables with chat models (signed in, or the local key), and tables of decision models only. */
export interface LobbyAccess {
  chat: boolean;
  decision: boolean;
}

export interface LobbyOptions {
  initial: LobbyChoice;
  /** Practice (?practice in a dev build): bots stand in for the models, and anything can start. */
  practice: boolean;
  /** What can start; everything while it is not known yet (the table answers for itself). */
  access?: LobbyAccess;
  onStart(choice: LobbyChoice): void;
  /** Login with Opper, back to this page. */
  onSignIn(): void;
  /** A table kept in this browser (a reload, a dropped page): a card at the top to sit back down, or let it go. */
  resume?: { saved: Resumable; onResume(): void; onDiscard(): void };
}

/** "Resume your game": the lineup's faces, the hand and how long ago, Resume and Discard. */
function resumeCard(r: NonNullable<LobbyOptions['resume']>): HTMLElement {
  const lines = resumeLines(r.saved);
  const faces = h('span.faces', { 'aria-hidden': 'true' }, ...r.saved.seats.filter((s) => s.kind === 'model').map((s) => avatarEl(personOf(s), 'relaxed', 'face')));
  return h(
    'section.resume-card',
    { 'aria-label': lines.title },
    faces,
    h('div.resume-words', null, h('h3', null, lines.title), h('p', null, lines.detail)),
    h('div.resume-buttons', null, h('button.cta', { type: 'button', onclick: r.onResume }, 'Resume'), h('button.cta.quiet', { type: 'button', onclick: r.onDiscard }, 'Discard')),
  );
}

/** The model an added seat starts with: another of the last seat's family not yet at the table, else any not there. */
export function nextSeat(models: readonly string[]): string {
  const group = modelById(models.at(-1) ?? '')?.group;
  const free = MODELS.filter((m) => !models.includes(m.id));
  return (free.find((m) => m.group === group) ?? free[0] ?? MODELS[0]!).id;
}

/** How many AI seats a table can have: playing, you and one to five; watching, two to six (shared/sitngo.ts). */
export function seatRange(mode: Mode): { min: number; max: number } {
  return mode === 'play' ? { min: MIN_SEATS - 1, max: MAX_SEATS - 1 } : { min: MIN_SEATS, max: MAX_SEATS };
}

/** Whether a lineup needs a sign-in the visitor does not have: any chat model, or decision models without free credits. */
export function needsSignIn(models: readonly string[], access: LobbyAccess | undefined): boolean {
  if (!access) return false;
  return models.some((id) => modelById(id)?.style === 'chat') ? !access.chat : !access.decision;
}

/** The seats a choice sits down: you first when playing. */
export function seatsOf(c: LobbyChoice): SeatConfig[] {
  const ai: SeatConfig[] = c.models.map((id) => ({ kind: 'model', id }));
  return c.mode === 'play' ? [{ kind: 'human', id: 'you' }, ...ai] : ai;
}

export function lobbyView(o: LobbyOptions): HTMLElement {
  let choice: LobbyChoice = { ...o.initial, models: [...o.initial.models] };
  const root = h('div.lobby');

  const draw = () => {
    const modes = h('div.modes', { role: 'radiogroup', 'aria-label': 'Play or watch' });
    for (const [mode, label] of [['play', 'Play'], ['watch', 'Watch']] as const) {
      modes.append(h('button', { type: 'button', role: 'radio', 'aria-checked': String(choice.mode === mode), onclick: () => ((choice = { ...choice, mode }), fit(), draw()) }, label));
    }
    const sets = h('div.sets', { role: 'radiogroup', 'aria-label': 'Opponents' });
    for (const s of SETS) {
      const faces = h('span.faces', { 'aria-hidden': 'true' }, ...s.models.map((id) => avatarEl(personOf({ kind: 'model', id }), 'relaxed', 'face')));
      sets.append(
        h(
          'button.set',
          { type: 'button', role: 'radio', 'aria-checked': String(choice.setId === s.id), onclick: () => ((choice = { ...choice, setId: s.id, models: [...s.models] }), fit(), draw()) },
          faces,
          h('span.set-name', null, s.name),
          h('span.set-blurb', null, s.blurb),
          h('span.pay', null, s.free ? 'Free to play' : o.access && !o.access.chat && !o.practice ? 'Sign in: plays on your Opper credits' : 'Plays on your Opper credits'),
        ),
      );
    }
    const lineup = h('ol');
    if (choice.mode === 'play') lineup.append(h('li', null, avatarEl(personOf({ kind: 'human', id: 'you' }), 'relaxed', 'mono'), h('span.you-line', null, 'You'), h('span')));
    const { min: minAi, max: maxAi } = seatRange(choice.mode);
    choice.models.forEach((id, i) => {
      const select = h('select', { 'aria-label': `Seat ${i + (choice.mode === 'play' ? 2 : 1)}` }) as HTMLSelectElement;
      for (const g of GROUPS) {
        const og = h('optgroup', { label: GROUP_NAMES[g] });
        for (const m of MODELS.filter((x) => x.group === g)) og.append(h('option', { value: m.id, selected: m.id === id }, m.name));
        select.append(og);
      }
      select.addEventListener('change', () => {
        choice.models[i] = select.value;
        choice = { ...choice, setId: 'custom' };
        draw();
      });
      const remove = h('button.remove', { type: 'button', 'aria-label': `Remove ${personOf({ kind: 'model', id }).name}`, disabled: choice.models.length <= minAi, onclick: () => ((choice.models.splice(i, 1), (choice = { ...choice, setId: 'custom' })), draw()) }, '×');
      lineup.append(h('li', null, avatarEl(personOf({ kind: 'model', id })), select, remove));
    });
    const add =
      choice.models.length < maxAi
        ? h('button.add', { type: 'button', onclick: () => (choice.models.push(nextSeat(choice.models)), (choice = { ...choice, setId: 'custom' }), draw()) }, 'Add a seat')
        : null;
    const locked = !o.practice && needsSignIn(choice.models, o.access);
    const start = locked
      ? h('button.cta', { type: 'button', onclick: o.onSignIn }, 'Sign in with Opper to play')
      : h('button.cta', { type: 'button', onclick: () => o.onStart({ ...choice, models: [...choice.models] }) }, choice.mode === 'play' ? 'Deal me in' : 'Start the game');
    const why = locked
      ? h('p.lede.signin-why', null, choice.models.some((id) => modelById(id)?.style === 'chat') ? 'The chat models play on your own Opper credits. The decision models are free to play.' : 'The free credits are used up for now. Sign in to play on your own Opper credits.')
      : null;
    const kids: (HTMLElement | null)[] = [
      o.resume ? resumeCard(o.resume) : null,
      h('h2', null, choice.mode === 'play' ? 'Take a seat' : 'Pull up a chair'),
      h('p.lede', null, choice.mode === 'play' ? 'You and up to five AI models, 1500 chips each. Blinds go up every 8 hands (longer at a bigger table) until one player has every chip.' : 'The models play each other with every card face up. You see what they say, and why.'),
      modes,
      sets,
      h('div.lineup', null, h('h3', null, 'At the table'), lineup, add),
      start,
      why,
      o.practice ? h('p.practice', null, 'Practice: bots stand in for the models (?practice).') : null,
    ];
    root.replaceChildren(...kids.filter((x): x is HTMLElement => x !== null));
  };

  /** Watching needs two AIs; playing has at most five (seatRange). */
  const fit = () => {
    if (choice.mode === 'watch' && choice.models.length < 2) choice.models.push(MODELS.find((m) => !choice.models.includes(m.id))!.id);
    if (choice.mode === 'play' && choice.models.length > seatRange('play').max) choice.models = choice.models.slice(0, seatRange('play').max);
  };

  fit();
  draw();
  return root;
}
