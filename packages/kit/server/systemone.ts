import { DEFAULT_MODEL, isModelId } from '../shared/models.ts';

/** Where decision calls go: Opper's System One endpoint, or TypeSafe's own System One API (jev only). */
export type Provider = 'opper' | 'typesafe';

export interface Target {
  provider: Provider;
  apiKey: string;
  baseUrl: string;
  /**
   * Opper only: the project an organization-wide key calls for, sent as X-Opper-Project (OPPER_PROJECT). System One
   * refuses an organization key without one; a project key needs none.
   */
  project?: string;
}

export const OPPER_BASE_URL = 'https://api.opper.ai';
export const TYPESAFE_BASE_URL = 'https://api.typesafe.ai';

/** TypeSafe bills input tokens only (docs.typesafe.ai/models, 2026-10): $0.042 per million. */
export const TYPESAFE_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

const PATHS: Record<Provider, string> = { opper: '/v3/compat/v1/systemone', typesafe: '/v1/systemone' };

/** TypeSafe's own id for jev. */
export const TYPESAFE_JEV = 'jev-1.13.0';

/**
 * The id to send for a listed model (shared/models.ts), or null when the provider does not serve it: Opper serves
 * every listed model under its id, TypeSafe's own API only jev.
 */
export function upstreamModel(provider: Provider, model: string): string | null {
  if (!isModelId(model)) return null;
  if (provider === 'opper') return model;
  return model === DEFAULT_MODEL ? TYPESAFE_JEV : null;
}

export const endpointFor = (t: Pick<Target, 'provider' | 'baseUrl'>): string => `${t.baseUrl.replace(/\/+$/, '')}${PATHS[t.provider]}`;

/**
 * The server's own key from the environment: TYPESAFE_API_KEY (straight to TypeSafe) wins over OPPER_API_KEY (with
 * OPPER_PROJECT when the key is the organization's).
 */
export function devTargetFromEnv(env: Record<string, string | undefined>): Target | undefined {
  if (env.TYPESAFE_API_KEY) return { provider: 'typesafe', apiKey: env.TYPESAFE_API_KEY, baseUrl: env.TYPESAFE_BASE_URL || TYPESAFE_BASE_URL };
  if (env.OPPER_API_KEY) return { provider: 'opper', apiKey: env.OPPER_API_KEY, baseUrl: env.OPPER_BASE_URL || OPPER_BASE_URL, ...(env.OPPER_PROJECT ? { project: env.OPPER_PROJECT } : {}) };
  return undefined;
}
