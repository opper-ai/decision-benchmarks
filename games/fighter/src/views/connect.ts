import { DEFAULT_BASE_URL, FORMATS, endpointProblem, endpointUrl, hostOf, isOpperUrl, type Format } from '../../shared/endpoints.ts';
import { logout, type Me } from '../api.ts';
import { checkOpperKey, connections, directEndpoint, endpointKey, forgetAll, mask, newEndpointId, subscribe, update, type MyEndpoint } from '../connections.ts';
import { h } from '../dom.ts';

/** A masked key field: the browser shows dots. */
const keyInput = (id: string, value: string, placeholder: string) =>
  h('input', { id, type: 'password', value, placeholder, autocomplete: 'off', spellcheck: 'false', 'data-1p-ignore': true, 'data-lpignore': 'true' }) as HTMLInputElement;

let dialog: HTMLDialogElement | null = null;

/**
 * The Connect panel: Opper (sign-in or API key), your endpoints, and how long keys are kept.
 * `addEndpoint` opens it with the new-endpoint form showing.
 */
export function openConnect(me: Me, opts: { addEndpoint?: boolean } = {}): void {
  dialog?.remove();
  const d = h('dialog.connect', { 'aria-labelledby': 'connect-title' }) as HTMLDialogElement;
  dialog = d;
  const body = h('div.connect-body');
  const close = h('button.btn.small.connect-close', { type: 'button', 'aria-label': 'Close' }, 'Close');
  close.addEventListener('click', () => d.close());
  d.append(h('div.connect-head', null, h('h2', { id: 'connect-title' }, 'Connect'), close), body);
  // A click on the backdrop (outside the panel) closes it.
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close();
  });
  d.addEventListener('close', () => {
    unsubscribe();
    d.remove();
    if (dialog === d) dialog = null;
  });
  let editing: MyEndpoint | null = opts.addEndpoint ? blankEndpoint() : null;
  // Survives redraws (saving a setting redraws the panel).
  const ui = { opperCheck: null as { text: string; warn: boolean } | null };
  const render = () => body.replaceChildren(opperSection(me, ui, render), endpointsSection(me, editing, (e) => ((editing = e), render())), storageSection());
  const unsubscribe = subscribe(render);
  render();
  document.body.append(d);
  d.showModal();
  if (opts.addEndpoint) (d.querySelector('#ep-name') as HTMLInputElement | null)?.focus();
}

const blankEndpoint = (): MyEndpoint => ({ id: '', name: '', url: DEFAULT_BASE_URL, format: 'systemone', model: '', key: '' });

function opperSection(me: Me, ui: { opperCheck: { text: string; warn: boolean } | null }, redraw: () => void): HTMLElement {
  const c = connections();
  const status = h(`p.note.result${ui.opperCheck?.warn ? '.warn' : ''}`, null, ui.opperCheck?.text ?? '');
  const key = keyInput('opper-key', c.opperKey, 'Your Opper API key');
  const save = () => {
    if (key.value.trim() !== connections().opperKey) {
      ui.opperCheck = null;
      update((x) => (x.opperKey = key.value.trim()));
    }
  };
  key.addEventListener('change', save);
  const test = h('button.btn.small', { type: 'button' }, 'Check');
  test.addEventListener('click', async () => {
    const value = key.value.trim();
    save();
    const show = (text: string, warn = false) => {
      ui.opperCheck = { text, warn };
      redraw();
    };
    if (!value) return show('Paste a key first.', true);
    show('Checking...');
    const r = await checkOpperKey(value);
    show(r.ok ? `Works: project ${r.project}${r.balance ? `, ${r.balance} left` : ''}.` : r.error, !r.ok);
  });
  const signin =
    me.mode === 'player'
      ? h(
          'p',
          null,
          `Signed in as ${me.user?.email ?? 'you'}. `,
          h(
            'button.btn.small',
            {
              type: 'button',
              onclick: async (e: Event) => {
                const btn = e.currentTarget as HTMLButtonElement;
                try {
                  await logout();
                  location.reload();
                } catch (err) {
                  btn.textContent = `Sign out failed: ${(err as Error).message}`;
                }
              },
            },
            'Sign out',
          ),
        )
      : me.mode === 'dev'
        ? h('p', null, 'This server has a key in .env (OPPER_API_KEY), so listed models already play.')
        : me.loginAvailable
          ? h('p', null, h('a.btn.primary', { href: '/auth/login', 'data-external': '1' }, 'Sign in with Opper'), ' Plays every listed model, billed to your Opper wallet.')
          : null;
  return h(
    'section',
    null,
    h('h3', null, 'Opper'),
    signin,
    h('label', { for: 'opper-key' }, me.mode === 'none' && me.loginAvailable ? 'Or use an Opper API key' : 'Opper API key', h('div.inline', null, key, test)),
    status,
    h('p.note', null, 'Create a key at ', h('a', { href: 'https://platform.opper.ai', target: '_blank', rel: 'noopener' }, 'platform.opper.ai'), '. A key here is used before your sign-in.'),
  );
}

function endpointsSection(me: Me, editing: MyEndpoint | null, setEditing: (e: MyEndpoint | null) => void): HTMLElement {
  const c = connections();
  const rows = c.endpoints.map((e) => {
    const result = h('span.note.result');
    const test = h('button.btn.small', { type: 'button' }, 'Test');
    test.addEventListener('click', () => void testEndpoint(e, result));
    return h(
      'li.ep',
      null,
      h('div.ep-main', null, h('strong', null, e.name), h('span.note', null, `${FORMATS.find((f) => f.id === e.format)?.label}, ${hostOf(e.url)}, ${e.model}${endpointKey(e) ? `, key ${mask(endpointKey(e))}` : ''}`), result),
      h('div.ep-actions', null, test, h('button.btn.small', { type: 'button', onclick: () => setEditing({ ...e }) }, 'Edit'), h('button.btn.small', { type: 'button', onclick: () => update((x) => (x.endpoints = x.endpoints.filter((y) => y.id !== e.id))) }, 'Remove')),
    );
  });
  const fromFile = (me.endpoints ?? []).map((e) => h('li.ep', null, h('div.ep-main', null, h('strong', null, e.name), h('span.note', null, `${FORMATS.find((f) => f.id === e.format)?.label}, ${hostOf(e.url)}, ${e.model}, from fighters.json`))));
  return h(
    'section',
    null,
    h('h3', null, 'Your endpoints'),
    h('p.note', null, 'Any server speaking System One, OpenAI chat completions or OpenAI Decisions becomes a fighter. It has to allow calls from a browser (CORS); Opper does. Endpoint fighters are kept off the public leaderboard, since anyone can name theirs anything.'),
    rows.length || fromFile.length ? h('ul.eps', null, ...rows, ...fromFile) : null,
    editing ? endpointForm(editing, setEditing) : h('button.btn', { type: 'button', onclick: () => setEditing(blankEndpoint()) }, 'Add an endpoint'),
  );
}

async function testEndpoint(e: MyEndpoint, out: HTMLElement): Promise<void> {
  out.textContent = 'Testing...';
  out.classList.remove('warn');
  const t0 = performance.now();
  try {
    await directEndpoint(e).warmUp();
    out.textContent = `Works (${Math.round(performance.now() - t0)} ms).`;
  } catch (err) {
    out.textContent = (err as Error).message;
    out.classList.add('warn');
  }
}

function endpointForm(e: MyEndpoint, setEditing: (e: MyEndpoint | null) => void): HTMLElement {
  const name = h('input', { id: 'ep-name', type: 'text', value: e.name, placeholder: 'Shown in the fight', maxlength: 40 }) as HTMLInputElement;
  const url = h('input', { id: 'ep-url', type: 'url', value: e.url, placeholder: DEFAULT_BASE_URL, spellcheck: 'false' }) as HTMLInputElement;
  const format = h('select', { id: 'ep-format' }, ...FORMATS.map((f) => h('option', { value: f.id, selected: f.id === e.format }, f.label))) as HTMLSelectElement;
  const model = h('input', { id: 'ep-model', type: 'text', value: e.model, placeholder: 'typesafe/jev-latest', spellcheck: 'false' }) as HTMLInputElement;
  const key = keyInput('ep-key', e.key, 'Optional');
  const full = h('p.note');
  const problem = h('p.note.warn');
  const result = h('p.note.result');
  const read = (): MyEndpoint => ({ id: e.id, name: name.value.trim(), url: url.value.trim(), format: format.value as Format, model: model.value.trim(), key: key.value.trim() });
  const sync = () => {
    const x = read();
    // Keep what was typed if the panel redraws (another setting changed).
    Object.assign(e, { ...x, id: e.id });
    full.textContent = hostOf(x.url) ? `Calls ${endpointUrl(x)}${!x.key && isOpperUrl(x.url) ? ' with your Opper key' : ''}.` : '';
    problem.textContent = '';
  };
  for (const el of [name, url, model, key]) el.addEventListener('input', sync);
  format.addEventListener('change', sync);
  sync();
  const save = h('button.btn.primary', { type: 'submit' }, e.id ? 'Save' : 'Add');
  const test = h('button.btn', { type: 'button' }, 'Test');
  test.addEventListener('click', () => {
    const x = read();
    const p = endpointProblem(x);
    if (p) return void (problem.textContent = p);
    void testEndpoint(x, result);
  });
  const form = h(
    'form.ep-form',
    null,
    h('label', { for: 'ep-name' }, 'Name', name),
    h('label', { for: 'ep-url' }, 'Base URL', url),
    h('label', { for: 'ep-format' }, 'Format', format),
    h('label', { for: 'ep-model' }, 'Model id', model),
    h('label', { for: 'ep-key' }, 'Key', key),
    full,
    problem,
    result,
    h('div.row', null, save, test, h('button.btn', { type: 'button', onclick: () => setEditing(null) }, 'Cancel')),
  ) as HTMLFormElement;
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const x = read();
    const p = endpointProblem(x);
    if (p) return void (problem.textContent = p);
    setEditing(null);
    update((c) => {
      if (x.id) c.endpoints = c.endpoints.map((y) => (y.id === x.id ? x : y));
      else c.endpoints.push({ ...x, id: newEndpointId() });
    });
  });
  return form;
}

function storageSection(): HTMLElement {
  const c = connections();
  const remember = h('input', { id: 'remember', type: 'checkbox', checked: c.remember }) as HTMLInputElement;
  remember.addEventListener('change', () => update((x) => (x.remember = remember.checked)));
  return h(
    'section',
    null,
    h('div.row', null, h('label.check', { for: 'remember' }, remember, 'Remember on this device'), h('button.btn.small', { type: 'button', onclick: () => forgetAll() }, 'Forget everything')),
    h(
      'p.note',
      null,
      'Keys and endpoints stay in this browser. Keys go straight to the model\'s endpoint, never to this site\'s server, and never into replays. Without "Remember" they are gone when the tab closes. As with any key kept in a browser, a script running on this page could read it.',
    ),
  );
}
