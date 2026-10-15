import { describe, expect, it } from 'vitest';
import type { Player } from '../shared/recording';
import { firstPerson, linkedInLinkUrl, linkedInUrl, listOf, resultText, TEXT_BUDGET, X_LIMIT, xIntentUrl, xLength } from '../src/social';

const you: Player = { kind: 'human', id: 'you' };
const opus: Player = { kind: 'model', id: 'aws/claude-opus-5-5' };
const sonnet: Player = { kind: 'model', id: 'vertexai/claude-sonnet-5-5-eu' };
const sol: Player = { kind: 'model', id: 'azure:eu/gpt-6.1-sol' };
const astra: Player = { kind: 'model', id: 'azure/gpt-6-astra-global' };
const fable: Player = { kind: 'model', id: 'anthropic/claude-fable-5-1' };
const msd: Player = { kind: 'model', id: 'azure:global/microsoft-decision-1' };
const luna: Player = { kind: 'model', id: 'openai/gpt-6-luna-decisions' };

describe('result posts', () => {
  it('a player who went out speaks for themselves, the best moment in their voice', () => {
    const t = resultText({ players: [you, opus, sonnet, sol], places: [2, 3, 4, 1], viewer: 0, moment: 'Opus 5.5 bluffed with nothing on the river, and you folded two pair. Pot: 62 big blinds.' });
    expect(t).toBe("I finished 2nd at AI Hold'em against Opus 5.5, Sonnet 5.5 and GPT-6.1 Sol. Opus 5.5 bluffed with nothing on the river, and I folded two pair. Pot: 62 big blinds. Can you beat them?");
    expect(t.length).toBeLessThanOrEqual(TEXT_BUDGET);
  });

  it('a winner says so', () => {
    const t = resultText({ players: [you, opus, sol], places: [1, 3, 2], viewer: 0, moment: 'You called Sol’s river bet with a pair, and won 40 big blinds.' });
    expect(t.startsWith("I won the table at AI Hold'em against Opus 5.5 and GPT-6.1 Sol. I called")).toBe(true);
    expect(t.endsWith('Can you do it too?')).toBe(true);
  });

  it('a spectator names the winner and the best moment, for watching and for replays', () => {
    const t = resultText({ players: [fable, astra, sol], places: [2, 1, 3], viewer: null, moment: 'GPT-6 Astra rivered a flush against Fable 5.1’s three of a kind (78% to win). Pot: 90 big blinds.' });
    expect(t).toBe("GPT-6 Astra took every chip from Fable 5.1 and GPT-6.1 Sol at AI Hold'em. Best moment: GPT-6 Astra rivered a flush against Fable 5.1’s three of a kind (78% to win). Pot: 90 big blinds. Watch the whole game:");
    expect(resultText({ players: [fable, astra], places: [1, 2], viewer: null, moment: null })).toBe("Fable 5.1 took every chip from GPT-6 Astra at AI Hold'em. Watch the whole game:");
  });

  it('stays in budget with long names and a long moment: the pot goes, then the long names, then the invitation', () => {
    const long = 'Microsoft Decision 1 bluffed with nothing on the river, and GPT-6 Luna Decisions folded three of a kind. Pot: 120 big blinds.';
    const t = resultText({ players: [you, msd, luna, sol], places: [4, 1, 2, 3], viewer: 0, moment: long });
    expect(t.length).toBeLessThanOrEqual(TEXT_BUDGET);
    expect(t).toContain('bluffed with nothing');
    expect(t).not.toContain('Pot:');
    const tiny = resultText({ players: [you, msd, luna, sol], places: [4, 1, 2, 3], viewer: 0, moment: long }, 120);
    expect(tiny.length).toBeLessThanOrEqual(120);
    expect(tiny).toMatch(/^I finished 4th at AI Hold'em against (Decision 1|Microsoft Decision 1)/);
    expect(xLength(t)).toBeLessThanOrEqual(X_LIMIT);
  });

  it('turns the moment into the player’s voice', () => {
    expect(firstPerson('You were ahead on the turn with a pair, and the river gave Sol three of a kind.')).toBe('I was ahead on the turn with a pair, and the river gave Sol three of a kind.');
    expect(firstPerson("Your three of a kind beat Opus's pair for 50 big blinds.")).toBe("My three of a kind beat Opus's pair for 50 big blinds.");
    expect(firstPerson('Sol called your river bet with a pair, and won 6 big blinds.')).toBe('Sol called my river bet with a pair, and won 6 big blinds.');
    expect(listOf(['A'])).toBe('A');
    expect(listOf(['A', 'B', 'C'])).toBe('A, B and C');
  });
});

describe('the networks’ links', () => {
  it('builds X and LinkedIn composer links, encoded', () => {
    const url = 'https://opper.ai/decision-benchmarks/holdem/#/r/AQSLj4yQ_-x';
    const text = "I won the table at AI Hold'em & more? 100% #1";
    const x = new URL(xIntentUrl(text, url));
    expect(x.origin + x.pathname).toBe('https://x.com/intent/post');
    expect(x.searchParams.get('text')).toBe(text);
    expect(x.searchParams.get('url')).toBe(url);
    const li = new URL(linkedInUrl(text, url));
    expect(li.origin + li.pathname).toBe('https://www.linkedin.com/feed/');
    expect(li.searchParams.get('shareActive')).toBe('true');
    expect(li.searchParams.get('text')).toBe(`${text} ${url}`);
    expect(new URL(linkedInLinkUrl(url)).searchParams.get('url')).toBe(url);
  });
});
