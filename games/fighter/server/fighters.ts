import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { endpointProblem, isFormat, type Endpoint } from '../shared/endpoints.ts';

/**
 * Endpoints from fighters.json, for people running the repo: they appear in the web picker and work
 * in the bench. Each one's key comes from the environment variable it names, never from the file.
 */
export interface FileEndpoint extends Endpoint {
  keyEnv?: string;
}

export const FIGHTERS_FILE = process.env.JEV_FIGHTER_FIGHTERS ?? join(process.cwd(), 'fighters.json');

export function loadFighters(file = FIGHTERS_FILE): { endpoints: FileEndpoint[]; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { endpoints: [], errors: err.code === 'ENOENT' ? [] : [`${file}: ${err.message}`] };
  }
  const list = (raw as { fighters?: unknown })?.fighters;
  if (!Array.isArray(list)) return { endpoints: [], errors: [`${file}: expected {"fighters": [...]}`] };
  const endpoints: FileEndpoint[] = [];
  const errors: string[] = [];
  for (const [k, f] of list.entries()) {
    const o = (f ?? {}) as Record<string, unknown>;
    const e: FileEndpoint = {
      id: String(o.id ?? ''),
      name: String(o.name ?? o.id ?? ''),
      url: String(o.url ?? ''),
      format: isFormat(o.format) ? o.format : 'chat',
      model: String(o.model ?? ''),
      ...(typeof o.keyEnv === 'string' ? { keyEnv: o.keyEnv } : {}),
    };
    const problem = !/^[a-z0-9][a-z0-9-]{0,40}$/.test(e.id) ? 'id must be lowercase letters, digits and dashes' : !isFormat(o.format) ? 'format must be systemone, chat or decisions' : endpointProblem(e);
    if (problem) errors.push(`${file}, fighter ${k + 1} (${e.id || 'no id'}): ${problem}`);
    else if (endpoints.some((x) => x.id === e.id)) errors.push(`${file}: the id ${e.id} is used twice`);
    else endpoints.push(e);
  }
  return { endpoints, errors };
}

export const keyFor = (e: FileEndpoint) => (e.keyEnv ? (process.env[e.keyEnv] ?? '') : '');
