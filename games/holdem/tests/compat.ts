// What 2- to 4-seat games are, as digests: the curated replays, share links and table tokens, replayed through the
// engine, the Sit & Go, the bench's question for every decision, and the service's token. tests/fixtures/
// two-to-four-seats.json froze these before tables of 5 and 6 came in; compat.test.ts checks they are still the same,
// byte for byte.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { observe, toAct } from '../shared/engine';
import { requestFor } from '../shared/questions';
import { replay, verifyRecording, type Player, type Recording } from '../shared/recording';
import { hashText } from '../shared/rng';
import { actSitAndGo, newSitAndGo, nextHand, type SitAndGo } from '../shared/sitngo';
import { snapshotOf } from '../shared/table';
import { encodeAction, rebuild, TOKEN_VERSION, type TableState } from '../server/token';
import { decodeGame, encodeGame } from '../src/share';
import { playTableGame } from './support';

const digest = (v: unknown): string => hashText(JSON.stringify(v));

/** Every decision of a Sit & Go as the seat to act sees it and is asked, and every hand's start as a spectator sees it. */
function walk(rec: Recording): string {
  const parts: unknown[] = [];
  let g: SitAndGo = newSitAndGo({ seats: rec.players.length, key: rec.sitngo!.key, startingStack: rec.sitngo!.startingStack });
  rec.hands.forEach((hand, h) => {
    if (h > 0) g = nextHand(g);
    parts.push(snapshotOf(g, null, () => null));
    for (const x of hand.actions) {
      const seat = toAct(g.hand)!;
      parts.push(requestFor(observe(g.hand, seat)));
      g = actSitAndGo(g, x.key ? { key: x.key } : { kind: 'raise', to: x.to! });
    }
  });
  parts.push(snapshotOf(g, 0, () => null));
  return digest(parts);
}

export const DEMOS = ['titans.json.gz', 'claude-vs-gpt.json.gz', 'open-models.json.gz', 'decision-models.json.gz'];

export function demoVectors(): Record<string, { fingerprint: string; replay: string; walk: string }> {
  const out: Record<string, { fingerprint: string; replay: string; walk: string }> = {};
  for (const file of DEMOS) {
    const rec = JSON.parse(gunzipSync(readFileSync(new URL(`../public/demo/${file}`, import.meta.url))).toString('utf8')) as Recording;
    const v = verifyRecording(rec);
    if (!v.ok) throw new Error(`${file}: ${v.error}`);
    out[file] = { fingerprint: v.fingerprint, replay: digest(replay(rec)), walk: walk(rec) };
  }
  return out;
}

const HUMAN: Player = { kind: 'human', id: 'human' };
const model = (id: string): Player => ({ kind: 'model', id });
const bot = (id: string): Player => ({ kind: 'bot', id });

/** The tables the link vectors are played at: 2, 3 and 4 seats, humans, chat and decision models and bots. */
export const LINEUPS: { players: Player[]; seed: number }[] = [
  { players: [HUMAN, model('aws/claude-opus-5-5')], seed: 225 },
  { players: [bot('rock'), model('sference/clef')], seed: 292 },
  { players: [HUMAN, model('azure:eu/gpt-6.1-sol'), bot('maniac')], seed: 438 },
  { players: [model('anthropic/claude-fable-5-1'), model('azure/gpt-6-astra-global'), model('vertexai/gemini-4-argon-eu')], seed: 443 },
  { players: [HUMAN, model('typesafe/jev-1.13.0'), model('vertexai/claude-sonnet-5-5-eu'), bot('rock')], seed: 530 },
  { players: [model('aws/claude-opus-5-5'), model('vertexai/claude-sonnet-5-5-eu'), model('azure:eu/gpt-6.1-sol'), model('azure/gpt-5.6-terra')], seed: 723 },
  { players: [HUMAN, model('sference/clef'), model('openai/gpt-6-luna-decisions'), model('opper/kev-4b')], seed: 781 },
  { players: [bot('station'), bot('maniac'), bot('random'), bot('rock')], seed: 905 },
];

export interface LinkVector {
  seats: number;
  code: string;
  recording: string;
  walk: string;
  /** The service's token for the table (no bots there): its finished hands and places, rebuilt from the log. */
  token?: string;
}

/** A table's token state for a recorded game of a human and models: the log the service would hold at the end. */
export function tokenStateOf(rec: Recording): TableState {
  const seats = rec.players.map((p) => (p.kind === 'human' ? null : p.id));
  return { v: TOKEN_VERSION, id: 'x', key: rec.sitngo!.key, mode: seats.includes(null) ? 'play' : 'watch', seats, log: rec.hands.map((h) => h.actions.map(encodeAction).join(',')), meta: [], at: 0, exp: 1 };
}

function tokenDigest(rec: Recording): string | undefined {
  if (rec.players.some((p) => p.kind === 'bot')) return undefined;
  const t = rebuild(tokenStateOf(rec), { finished: true });
  return digest({ finished: t.finished, places: t.g.places, over: t.g.over, hands: t.hands });
}

/** The link vectors as the code makes them now: link, decoded recording, its decisions, and its token. */
export function linkVectors(): LinkVector[] {
  return LINEUPS.map(({ players, seed }) => {
    const rec = playTableGame(players, seed);
    const code = encodeGame(rec);
    return linkVector(code);
  });
}

/** What a link decodes to now. */
export function linkVector(code: string): LinkVector {
  const d = decodeGame(code);
  if (!d.ok) throw new Error(d.error);
  const token = tokenDigest(d.recording);
  return { seats: d.recording.players.length, code, recording: digest(d.recording), walk: walk(d.recording), ...(token ? { token } : {}) };
}
