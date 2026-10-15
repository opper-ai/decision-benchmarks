// The bench's question is frozen: the published leaderboard was played on it, so any change to what the bench asks
// (instructions, state, options, the chat models' messages and schema) would make new runs incomparable. Live-table
// wording goes through chatFormatFor(context) and must never leak into the bench's CHAT_FORMAT or requestFor(o).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { botDecide, BOT_NAMES } from '../shared/bots';
import { applyAction, newHand, observe, toAct, type HandState } from '../shared/engine';
import { CHAT_FORMAT, CHAT_SYSTEM, QUESTION, requestFor } from '../shared/questions';
import { deriveSeed } from '../shared/rng';
import { newSitAndGo, actSitAndGo, nextHand } from '../shared/sitngo';

/** Every decision of `hands` bot-played cash hands at the bench's stakes, and of a bot-played Sit & Go. */
function spots(): HandState[] {
  const out: HandState[] = [];
  for (let h = 0; h < 40; h++) {
    let s = newHand({ stacks: [200, 200, 200, 200], button: h % 4, sb: 1, bb: 2, deckSeed: deriveSeed(123_456_789, h) });
    while (toAct(s) !== null) {
      out.push(s);
      const seat = toAct(s)!;
      s = applyAction(s, { key: botDecide(BOT_NAMES[(seat + h) % 4]!, observe(s, seat)) });
    }
  }
  let g = newSitAndGo({ seats: 4, key: '0'.repeat(63) + '7' });
  for (let i = 0; i < 400 && !g.over; i++) {
    if (g.hand.street === 'done') {
      g = nextHand(g);
      continue;
    }
    out.push(g.hand);
    const seat = toAct(g.hand)!;
    g = actSitAndGo(g, { key: botDecide(BOT_NAMES[seat % 4]!, observe(g.hand, seat)) });
  }
  return out;
}

describe("the bench's question", () => {
  it('tells chat models exactly what it told them when the leaderboard was played', () => {
    expect(CHAT_SYSTEM).toBe(
      "You are a player in AI Hold'em, a game of No-limit Texas Hold'em for play-money chips against other players. " +
        'Each turn you get the instructions, the state of the hand and your options, and answer with JSON only: ' +
        '"action": one of the option keys; ' +
        '"say": what you say out loud at the table, at most 90 characters. Every player hears it; it may be true or a bluff, or empty; ' +
        '"mood": the face you show the table, one of relaxed, confident, nervous, annoyed, smug. It can bluff too; ' +
        '"reasoning": why you chose this action, at most 600 characters. The other players do not see it during the hand; it is shown in the review afterwards; ' +
        '"turn_complete": true.',
    );
  });

  it('asks every spot byte for byte as before: the request, the chat messages and the schema', () => {
    const all = spots();
    expect(all.length).toBeGreaterThan(400);
    const hash = createHash('sha256');
    for (const s of all) {
      const o = observe(s, toAct(s)!);
      const req = requestFor(o);
      const q = req.questions[QUESTION]!;
      hash.update(JSON.stringify(req));
      hash.update(JSON.stringify(CHAT_FORMAT.messages(req.state, q)));
      hash.update(JSON.stringify(CHAT_FORMAT.responseFormat(q)));
    }
    expect(hash.digest('hex')).toBe('19c1f723e24eb170eb7a580a9a433af3d9b34b674e137c7b9e3ab3d8162f342c');
  });
});
