import { getDemos } from '../api.ts';
import { h } from '../dom.ts';

/** Watch: the recorded matches in public/demo/ (benchmark matches, played by the bench and replayed here). */
export async function watchView(host: HTMLElement): Promise<void> {
  const body = h('div', null, h('p.note', null, 'Loading...'));
  host.replaceChildren(
    h(
      'div.page',
      null,
      h('h1', null, 'Watch'),
      h('p.lead', null, 'Recorded benchmark matches: each one replays exactly from its seed and its decisions. Click a decision to see the question the fighter got, every option and what it chose.'),
      body,
    ),
  );
  const demos = await getDemos();
  body.replaceChildren(
    demos.length
      ? h(
          'div.cards',
          null,
          ...demos.map((d) => h('div.card', null, h('a.card-body', { href: `#/watch/${d.file}` }, h('div.card-vs', null, d.title), d.note ? h('div.card-meta', null, d.note) : null))),
        )
      : h('p.note', null, 'No recorded matches yet.'),
  );
}
