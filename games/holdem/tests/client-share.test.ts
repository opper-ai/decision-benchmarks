import { describe, expect, it } from 'vitest';
import type { Action } from '../shared/engine';
import { fingerprintOf, type Recording } from '../shared/recording';
import { mulberry32 } from '../shared/rng';
import type { TableConfig, TableSnapshot } from '../src/driver';
import { LocalDriver } from '../src/local-driver';
import { HOLDEM_MODELS } from '../shared/models';
import { decodeGame, encodeGame, fromBase64Url, linkCodeOf, LINK_MODELS, shareLink, toBase64Url, canShare } from '../src/share';

const coinFrom = (seed: number) => {
  let s = seed;
  return () => {
    let r: number;
    [r, s] = mulberry32(s);
    return r;
  };
};

/** A finished practice game, as the end screen has it. */
async function finishedGame(config: TableConfig, coinSeed = 1): Promise<Recording> {
  const d = new LocalDriver({ thinkScale: 0, sleep: async () => {} });
  const coin = coinFrom(coinSeed);
  let s: TableSnapshot = await d.start(config);
  for (;;) {
    if (s.view.street === 'done') {
      if (s.over) break;
      s = await d.nextHand();
      continue;
    }
    if (s.turn) {
      const t = s.turn;
      let a: Action;
      if (t.raise && coin() < 0.15) a = { kind: 'raise', to: t.raise.min + Math.floor(coin() * (t.raise.max - t.raise.min + 1)) };
      else {
        const passive = t.options.find((o) => o.key === 'check' || o.key === 'call')!;
        a = { key: coin() < 0.75 ? passive.key : t.options[Math.floor(coin() * t.options.length)]!.key };
      }
      s = (await d.act(a)).snapshot;
    } else s = (await d.step()).snapshot;
  }
  return (await d.review()).recording!;
}

const moves = (r: Recording) => r.hands.map((h) => h.actions.map((a) => `${a.seat}${a.key ?? `=${a.to}`}${a.by[0]}`).join(' '));

describe('share links', () => {
  it('round-trips a played game: same seats, table key, moves and result, without the talk', async () => {
    const rec = await finishedGame({ seed: 1, seats: [{ kind: 'human', id: 'you' }, { kind: 'model', id: 'aws/claude-opus-5-5' }, { kind: 'model', id: 'sference/clef' }, { kind: 'bot', id: 'maniac' }] });
    expect(rec.hands.flatMap((h) => h.actions).some((a) => a.to !== undefined)).toBe(true);
    const code = encodeGame(rec);
    const back = decodeGame(code);
    if (!back.ok) throw new Error(back.error);
    expect(back.recording.players).toEqual([{ kind: 'human', id: 'human' }, ...rec.players.slice(1)]);
    expect(back.recording.sitngo).toEqual(rec.sitngo);
    expect(moves(back.recording)).toEqual(moves(rec));
    expect(back.recording.result).toEqual(rec.result);
    expect(back.recording.hands.flatMap((h) => h.actions).every((a) => a.say === undefined && a.reasoning === undefined)).toBe(true);
    expect(fingerprintOf({ ...back.recording, players: rec.players })).toBe(fingerprintOf(rec));
  });

  it('keeps a typical game short: bots cost nothing, a move is half a byte', async () => {
    const lengths: number[] = [];
    for (const seed of [1, 2, 3]) {
      const rec = await finishedGame({ seed, seats: [{ kind: 'human', id: 'you' }, { kind: 'model', id: 'typesafe/jev-1.13.0' }, { kind: 'model', id: 'sference/clef' }, { kind: 'model', id: 'openai/gpt-6-luna-decisions' }] }, seed);
      const moves = rec.hands.reduce((a, h) => a + h.actions.length, 0);
      const code = encodeGame(rec);
      lengths.push(code.length);
      // About two thirds of a character per move, plus the header (the 32-byte table key is 43 of its characters).
      expect(code.length).toBeLessThan(moves * 0.75 + 80);
      expect(decodeGame(code).ok).toBe(true);
    }
    // A four-handed table of models: every move is in the link. All-bot tables carry only the header.
    const bots = await finishedGame({ seed: 9, seats: [{ kind: 'bot', id: 'rock' }, { kind: 'bot', id: 'station' }, { kind: 'bot', id: 'maniac' }] });
    expect(encodeGame(bots).length).toBeLessThan(56);
    expect(decodeGame(encodeGame(bots)).ok).toBe(true);
    console.info(`link lengths for 4-handed games: ${lengths.join(', ')} characters`);
  });

  it('refuses garbage, tampering, a cut-off game and moves after the end', async () => {
    const rec = await finishedGame({ seed: 77, seats: [{ kind: 'human', id: 'you' }, { kind: 'model', id: 'aws/claude-opus-5-5' }] }, 3);
    const code = encodeGame(rec);
    const bytes = fromBase64Url(code)!;
    const bad = (b: Uint8Array) => decodeGame(toBase64Url(b));
    expect(decodeGame('')).toMatchObject({ ok: false });
    expect(decodeGame('not a link!')).toMatchObject({ ok: false });
    expect(decodeGame('x'.repeat(30_000))).toMatchObject({ ok: false, error: /too long/ });
    // Another version.
    expect(bad(Uint8Array.from([1, ...bytes.subarray(1)]))).toMatchObject({ ok: false, error: /another version/ });
    // A seat the game does not know.
    const seat = Uint8Array.from(bytes);
    seat[3] = (2 << 6) | 60;
    expect(bad(seat)).toMatchObject({ ok: false, error: /does not know/ });
    // Another key deals other cards: the same moves are refused, or (rarely) are another legal game. A link carries no
    // signature: it is a replay to show, never a score to trust.
    const key = Uint8Array.from(bytes);
    key[5] ^= 0x55;
    const other = bad(key);
    if (other.ok) expect(other.recording.sitngo!.key).not.toBe(rec.sitngo!.key);
    // Cut off.
    expect(bad(bytes.subarray(0, bytes.length - 3))).toMatchObject({ ok: false });
    // Moves after the end.
    expect(bad(Uint8Array.from([...bytes, 0x22, 0x22]))).toMatchObject({ ok: false });
    // Every single-byte change in the moves is refused or still a legal, finished game: never an exception.
    for (let i = 8; i < bytes.length; i++) {
      const t = Uint8Array.from(bytes);
      t[i] ^= 0xff;
      const v = bad(t);
      if (v.ok) expect(v.recording.result.places).toHaveLength(2);
    }
  });

  it('builds and reads the link in the hash', async () => {
    const rec = await finishedGame({ seed: 5, seats: [{ kind: 'bot', id: 'rock' }, { kind: 'model', id: 'azure/gpt-6-astra-global' }] });
    const link = shareLink(rec, 'https://opper.ai/decision-benchmarks/holdem/#/old');
    expect(link.startsWith('https://opper.ai/decision-benchmarks/holdem/#/r/')).toBe(true);
    expect(linkCodeOf(new URL(link).hash)).toBe(encodeGame(rec));
    expect(linkCodeOf('#/demo/x.json')).toBeNull();
    expect(canShare(rec)).toBe(true);
    expect(canShare({ ...rec, players: [rec.players[0]!, { kind: 'model', id: 'someone/else' }] })).toBe(false);
    expect(canShare(null)).toBe(false);
  });

  it('can name every model the game seats, each once, in a seat byte', async () => {
    for (const m of HOLDEM_MODELS) expect(LINK_MODELS, m.id).toContain(m.id);
    expect(new Set(LINK_MODELS).size).toBe(LINK_MODELS.length);
    expect(LINK_MODELS.length).toBeLessThanOrEqual(64);
    // Append only: the first ids keep their places.
    expect(LINK_MODELS.slice(0, 2)).toEqual(['typesafe/jev-1.13.0', 'sference/clef']);
    expect(LINK_MODELS.indexOf('azure/gpt-6-astra-global')).toBe(16);
    expect(LINK_MODELS.indexOf('nebius/MiniMaxAI/MiniMax-M3')).toBe(26);
    // A game with models added later goes through a link and back.
    const rec = await finishedGame({ seed: 9, seats: [{ kind: 'human', id: 'you' }, { kind: 'model', id: 'vertexai/gemini-4-argon-eu' }, { kind: 'model', id: 'vertexai/gemini-3.5-flash-lite-eu' }] });
    const back = decodeGame(encodeGame(rec));
    expect(back.ok && back.recording.players.slice(1)).toEqual([{ kind: 'model', id: 'vertexai/gemini-4-argon-eu' }, { kind: 'model', id: 'vertexai/gemini-3.5-flash-lite-eu' }]);
  });

  it('base64url round-trips every length', () => {
    for (let n = 0; n < 20; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
      expect(fromBase64Url(toBase64Url(b))).toEqual(b);
    }
    expect(fromBase64Url('A')).toBeNull();
    expect(fromBase64Url('a+b/')).toBeNull();
  });
});
