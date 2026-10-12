import { describe, expect, it } from 'vitest';
import game, { seedFor } from '../game';
import { verifyGame } from '../bench/verify';
import { createGame, step, type Move } from '../shared/engine';
import { allFacts, fallbackMove, viewOf } from '../shared/questions';
import type { Recording } from '../shared/recording';
import { playBaseline } from './support';

const SEED = seedFor(0);
const { recording, result } = await playBaseline('flood', SEED);
const copy = (): Recording => structuredClone(recording);

describe('verify', () => {
  it('replays a recorded game to its result, with the same fingerprint every time', () => {
    const v = verifyGame(copy(), { seed: SEED });
    expect(v).toMatchObject({ ok: true, result: { score: result.score, steps: result.steps, end: result.end, decisions: recording.steps.length, fallbacks: 0 } });
    expect(result.score).toBeGreaterThan(5);
    expect(v.ok && v.fingerprint).toBe((verifyGame(copy(), { seed: SEED }) as { fingerprint: string }).fingerprint);
    expect(game.verify(copy(), { seed: SEED }).ok).toBe(true);
  });

  it('gives a different game a different fingerprint, but not a retimed one', () => {
    const other = verifyGame(structuredClone(playBaselineSync.greedy), { seed: SEED });
    const retimed = copy();
    retimed.steps.forEach((s) => (s.latencyMs = 1234));
    const a = verifyGame(copy(), { seed: SEED });
    const b = verifyGame(retimed, { seed: SEED });
    expect(a.ok && b.ok && a.fingerprint === b.fingerprint).toBe(true);
    expect(a.ok && other.ok && a.fingerprint !== other.fingerprint).toBe(true);
  });

  it('refuses a changed choice', () => {
    const rec = copy();
    const i = 10;
    rec.steps[i]!.choice = rec.steps[i]!.choice === 'straight' ? 'left' : 'straight';
    const v = verifyGame(rec, { seed: SEED });
    expect(v.ok).toBe(false);
  });

  it("refuses a model move dressed up as the fallback's, and a fallback that is not the rule's", () => {
    // Find a step where the model did not do what the fallback would have.
    let s = createGame(SEED);
    let differs = -1;
    for (let i = 0; i < recording.steps.length; i++) {
      const rule = fallbackMove(allFacts(viewOf(s)));
      if (rule !== recording.steps[i]!.choice) {
        differs = i;
        break;
      }
      s = step(s, recording.steps[i]!.choice);
    }
    expect(differs).toBeGreaterThanOrEqual(0);
    const dressed = copy();
    dressed.steps[differs]!.source = 'fallback';
    expect(verifyGame(dressed, { seed: SEED })).toMatchObject({ ok: false, error: expect.stringMatching(/marked as the fallback's/) });
    // A fallback step is free to be what the rule gives: marking a step where the rule agrees is fine.
    const agree = copy();
    agree.steps[0]!.source = fallbackMove(allFacts(viewOf(createGame(SEED)))) === agree.steps[0]!.choice ? 'fallback' : 'model';
    expect(verifyGame(agree, { seed: SEED }).ok).toBe(true);
  });

  it('refuses the wrong seed', () => {
    expect(verifyGame(copy(), { seed: seedFor(1) })).toMatchObject({ ok: false, error: expect.stringMatching(/played seed/) });
    const moved = copy();
    moved.seed = seedFor(1);
    expect(verifyGame(moved, { seed: seedFor(1) }).ok).toBe(false);
  });

  it('refuses an edited score, step count or ending', () => {
    for (const edit of [(r: Recording) => (r.result.score += 1), (r: Recording) => (r.result.steps -= 1), (r: Recording) => (r.result.end = r.result.end === 'wall' ? 'body' : 'wall')]) {
      const rec = copy();
      edit(rec);
      expect(verifyGame(rec, { seed: SEED })).toMatchObject({ ok: false, error: expect.stringMatching(/the replay ends with/) });
    }
  });

  it('refuses a game cut short, moves after the end, and malformed steps', () => {
    const short = copy();
    short.steps.pop();
    expect(verifyGame(short, { seed: SEED })).toMatchObject({ ok: false, error: expect.stringMatching(/before it ended/) });
    // A game that ended before the step cap, with one more move.
    const long = structuredClone(playBaselineSync.greedy);
    expect(long.result.end).not.toBe('steps');
    long.steps.push({ choice: 'straight', source: 'model' });
    expect(verifyGame(long, { seed: SEED })).toMatchObject({ ok: false, error: expect.stringMatching(/after the game ended/) });
    const cases: [(r: Recording) => void, RegExp][] = [
      [(r) => ((r.steps[3] as { choice: string }).choice = 'up'), /not one of left, straight, right/],
      [(r) => ((r.steps[3] as { source: string }).source = 'human'), /source/],
      [(r) => (r.steps[3]!.latencyMs = -5), /latency/],
      [(r) => (r.steps[3]!.costUsd = 1e9), /cost/],
      [(r) => ((r.steps[3] as unknown as Record<string, unknown>).extra = 1), /unknown fields/],
      [(r) => (r.benchVersion = 0), /bench version/],
    ];
    for (const [edit, message] of cases) {
      const rec = copy();
      edit(rec);
      expect(verifyGame(rec, { seed: SEED })).toMatchObject({ ok: false, error: expect.stringMatching(message) });
    }
    expect(verifyGame({ format: 1, game: 'pacman' }, { seed: SEED }).ok).toBe(false);
    expect(verifyGame(null, { seed: SEED }).ok).toBe(false);
  });
});

/** Other games on the same seed, played once. */
const playBaselineSync = { greedy: (await playBaseline('greedy', SEED)).recording };

describe('the fallback in a recording', () => {
  it('replays a game of fallbacks only', () => {
    let s = createGame(SEED);
    const steps: Recording['steps'] = [];
    while (!s.over) {
      const m: Move = fallbackMove(allFacts(viewOf(s)));
      steps.push({ choice: m, source: 'fallback' });
      s = step(s, m);
    }
    const rec: Recording = { format: 1, game: 'snake', benchVersion: game.benchVersion, seed: SEED, model: 'nobody', steps, result: { score: s.apples, steps: s.steps, end: s.over } };
    expect(verifyGame(rec, { seed: SEED })).toMatchObject({ ok: true, result: { fallbacks: steps.length, decisions: steps.length } });
  });
});
