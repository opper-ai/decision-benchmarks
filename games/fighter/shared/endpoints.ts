import { chatAdapter } from '../adapters/chat.ts';
import { decisionsAdapter } from '../adapters/decisions.ts';
import { systemOneAdapter, type HttpDeps } from '../adapters/systemone.ts';
import type { Adapter } from './adapter.ts';

/**
 * Endpoints: any server speaking one of three formats, as a fighter. Configured in the browser
 * (Connections panel) or, for people running the repo, in fighters.json.
 */

export type Format = 'systemone' | 'chat' | 'decisions';
export const FORMATS: { id: Format; label: string; path: string }[] = [
  { id: 'systemone', label: 'System One', path: '/v1/systemone' },
  { id: 'chat', label: 'OpenAI chat completions', path: '/chat/completions' },
  { id: 'decisions', label: 'OpenAI Decisions', path: '/decisions' },
];
export const DEFAULT_BASE_URL = 'https://api.opper.ai/v3/compat';

export interface Endpoint {
  id: string;
  name: string;
  /** Base URL; the format's path is added unless it is already there. */
  url: string;
  format: Format;
  model: string;
}

export const isFormat = (x: unknown): x is Format => FORMATS.some((f) => f.id === x);

export function hostOf(url: string): string {
  try {
    return new URL(url.trim()).host;
  } catch {
    return '';
  }
}

export const isOpperUrl = (url: string) => /(^|\.)opper\.ai$/.test(hostOf(url).replace(/:\d+$/, ''));

/** The full URL to call: the base URL plus the format's path, unless it is already there. */
export function endpointUrl(e: Pick<Endpoint, 'url' | 'format'>): string {
  const base = e.url.trim().replace(/\/+$/, '');
  const path = FORMATS.find((f) => f.id === e.format)!.path;
  return base.endsWith(path) ? base : `${base}${path}`;
}

/** What is wrong with an endpoint's settings, or null if it can play. */
export function endpointProblem(e: Pick<Endpoint, 'url' | 'format' | 'model' | 'name'>): string | null {
  if (!e.name.trim()) return 'Give it a name.';
  if (!e.model.trim()) return 'Enter the model id.';
  if (!isFormat(e.format)) return 'Pick a format.';
  let u: URL;
  try {
    u = new URL(e.url.trim());
  } catch {
    return `Enter the base URL, for example ${DEFAULT_BASE_URL}.`;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'The URL must be http or https.';
  if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return 'Use https (plain http only for localhost).';
  return null;
}

/**
 * The id an endpoint fighter has in replays and on the leaderboard: namespaced, so an endpoint never
 * passes for a listed model whatever it is called.
 */
export const endpointModelId = (e: Pick<Endpoint, 'url' | 'model'>) => `custom:${hostOf(e.url)}/${e.model.trim()}`;

export function endpointAdapter(e: Endpoint, apiKey: string, fetchImpl?: typeof fetch): Adapter {
  const deps: HttpDeps = { apiKey, endpoint: endpointUrl(e), tag: isOpperUrl(e.url), fetch: fetchImpl };
  const model = e.model.trim();
  return e.format === 'chat' ? chatAdapter(model, deps) : e.format === 'decisions' ? decisionsAdapter(model, deps) : systemOneAdapter(model, deps);
}
