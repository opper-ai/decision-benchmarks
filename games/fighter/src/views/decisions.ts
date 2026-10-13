import { MOVE_LABELS, type MoveId } from '../../shared/engine/moves.ts';
import type { Decision, FighterMeta } from '../../shared/replay.ts';
import { clockTime, h, money } from '../dom.ts';
import { SIDES } from '../theme.ts';

export const OUTCOME_LABEL: Record<string, string> = {
  hit: 'hit',
  traded: 'traded',
  blocked: 'blocked',
  whiffed: 'whiffed',
  punished: 'got hit',
  defended: 'defended',
  neutral: '',
};

export function topMoves(d: Decision, n = 3): { move: MoveId; p: number }[] {
  const probs = d.answer?.probabilities;
  if (!probs) return [{ move: d.move, p: 1 }];
  return (Object.entries(probs) as [MoveId, number][])
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([move, p]) => ({ move, p }));
}

/** A compact, expandable decision card. */
export function decisionCard(d: Decision, meta: [FighterMeta, FighterMeta], onSeek?: (tick: number) => void): HTMLElement {
  const color = SIDES[d.fighter].deep;
  const conf = d.answer?.probabilities?.[d.move];
  const detail = h('div.dc-detail');
  const card = h(
    'div.dc',
    { 'data-tick': d.appliedTick, 'data-side': d.fighter },
    h(
      'button.dc-head',
      {
        type: 'button',
        onclick: () => {
          if (!detail.childElementCount) fillDetail(detail, d);
          card.classList.toggle('open');
          onSeek?.(d.questionTick);
        },
      },
      h('span.dot', { style: { background: color } }),
      h('span.dc-time', null, clockTime(d.appliedTick)),
      h('span.dc-move', null, MOVE_LABELS[d.move]),
      conf !== undefined ? h('span.dc-conf', null, `${Math.round(conf * 100)}%`) : null,
      d.outcome && OUTCOME_LABEL[d.outcome] ? h(`span.badge.o-${d.outcome}`, null, OUTCOME_LABEL[d.outcome]) : null,
      d.fallback ? h('span.badge.o-fallback', { title: d.error ?? '' }, `fallback: ${d.fallback}${d.fallback === 'illegal' && d.answer ? ` (wanted ${MOVE_LABELS[d.answer.move]})` : ''}`) : null,
      h('span.dc-lat', null, `${d.latencyMs} ms`),
    ),
    detail,
  );
  if (d.fallback) card.classList.add('is-fallback');
  return card;
}

function fillDetail(el: HTMLElement, d: Decision): void {
  const probs = d.answer?.probabilities ?? null;
  el.append(
    h('dl.dc-ctx', null, ...Object.entries(d.question.context).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    h(
      'div.dc-opts',
      null,
      ...d.question.options.map((o) => {
        const p = probs?.[o.id] ?? (o.id === d.move ? 1 : 0);
        return h(
          `div.opt${o.id === d.move ? '.chosen' : ''}`,
          null,
          h('div.opt-bar', { style: { width: `${Math.max(0.5, p * 100)}%` } }),
          h('span.opt-name', null, MOVE_LABELS[o.id]),
          h('span.opt-p', null, probs ? `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%` : o.id === d.move ? 'chosen' : ''),
          h('div.opt-facts', null, o.facts),
        );
      }),
    ),
    h(
      'div.dc-meta',
      null,
      `asked ${clockTime(d.askedTick)}, applied ${clockTime(d.appliedTick)}`,
      d.answer?.costUsd != null ? `, ${money(d.answer.costUsd)}` : '',
      d.answer?.inputTokens ? `, ${d.answer.inputTokens} input tokens` : '',
      probs ? '' : d.answer ? ', no probabilities (uncalibrated)' : '',
      d.error ? `. ${d.error}` : '',
    ),
  );
}
