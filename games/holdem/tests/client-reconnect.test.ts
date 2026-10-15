import { describe, expect, it } from 'vitest';
import { agoText, choiceOf, resumeLines, retryChoice, retryLine } from '../src/reconnect';
import type { Resumable } from '../src/remote-driver';
import { SETS } from '../src/roster';

describe('a dropped connection', () => {
  it('counts down to the next try in whole seconds', () => {
    expect(retryLine(7600)).toBe('Trying again in 8 s');
    expect(retryLine(1000)).toBe('Trying again in 1 s');
    expect(retryLine(0)).toBe('Trying again now');
    expect(retryLine(-200)).toBe('Trying again now');
  });
});

describe('a table kept to resume', () => {
  const decision = SETS.find((s) => s.id === 'decision')!;
  const saved = (o: Partial<Resumable> = {}): Resumable => ({
    mode: 'play',
    seats: [{ kind: 'human', id: 'you' }, ...decision.models.map((id) => ({ kind: 'model' as const, id }))],
    hand: 7,
    savedAt: 0,
    ageMs: 4 * 60_000 + 5000,
    ...o,
  });

  it('says how long ago, in words', () => {
    expect(agoText(20_000)).toBe('just now');
    expect(agoText(60_000)).toBe('1 minute ago');
    expect(agoText(59 * 60_000)).toBe('59 minutes ago');
    expect(agoText(61 * 60_000)).toBe('1 hour ago');
    expect(agoText(5 * 3600_000)).toBe('5 hours ago');
  });

  it('sits the same lineup down again, as the set it was when it is one', () => {
    expect(choiceOf(saved())).toEqual({ mode: 'play', setId: 'decision', models: [...decision.models] });
    const custom = choiceOf(saved({ mode: 'watch', seats: decision.models.slice(0, 2).map((id) => ({ kind: 'model' as const, id })) }));
    expect(custom).toEqual({ mode: 'watch', setId: 'custom', models: decision.models.slice(0, 2) });
  });

  it('names the game on the lobby card', () => {
    expect(resumeLines(saved())).toEqual({ title: 'Resume your game', detail: `You and ${decision.models.length} models, hand 7, last played 4 minutes ago.` });
    expect(resumeLines(saved({ mode: 'watch', hand: 12, ageMs: 0 })).title).toBe('Resume watching');
  });
});

describe('Try again, when a table stopped', () => {
  const decision = SETS.find((s) => s.id === 'decision')!;
  const older: Resumable = { mode: 'watch', seats: decision.models.slice(0, 2).map((id) => ({ kind: 'model' as const, id })), hand: 9, savedAt: 0, ageMs: 3600_000 };

  it('is offered for the game’s own table only: one that had started, or a resume', () => {
    // A new table that never started: the table kept here is an older game, not this one.
    expect(retryChoice({ gaveUp: true, started: false, resumed: false, saved: older })).toBeNull();
    expect(retryChoice({ gaveUp: true, started: true, resumed: false, saved: older })).not.toBeNull();
    expect(retryChoice({ gaveUp: true, started: false, resumed: true, saved: older })).not.toBeNull();
    // Nothing kept (practice, cleared), or a refusal rather than the connection giving up: no Try again.
    expect(retryChoice({ gaveUp: true, started: true, resumed: false, saved: null })).toBeNull();
    expect(retryChoice({ gaveUp: false, started: true, resumed: true, saved: older })).toBeNull();
  });

  it('sits the kept table’s own lineup and mode down again', () => {
    expect(retryChoice({ gaveUp: true, started: false, resumed: true, saved: older })).toEqual({ mode: 'watch', setId: 'custom', models: decision.models.slice(0, 2) });
  });
});
