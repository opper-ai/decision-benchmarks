import { appPath } from '../../../packages/kit/client/paths.ts';

/**
 * Each decision model's maker mark, as jevman shows it (its public/logos, copied to this game's public/logos): the mark
 * the maker uses on its own profiles. Jared Palmer publishes Kev as himself, so Kev's mark is his avatar. GreenPT's
 * Metis has none yet: the picker shows its initial.
 */
const LOGOS: Record<string, { file: string; shape?: 'round' | 'square'; mono?: true }> = {
  'typesafe/jev-1.13.0': { file: 'typesafe.png', shape: 'square' },
  'sference/clef': { file: 'cloudflare.svg' },
  'cloudflare:global/clef-flash': { file: 'cloudflare.svg' },
  'opper/kev-4b': { file: 'jared-palmer.webp', shape: 'round' },
  'berget/convaiinnovations/laya': { file: 'convai.webp', shape: 'square' },
  'openai/gpt-6-luna-decisions': { file: 'openai.svg', mono: true },
  'azure:global/microsoft-decision-1': { file: 'microsoft.svg' },
  'empiriolabs/aplomb-1': { file: 'empiriolabs.png', shape: 'round' },
};

/** The model's maker mark as an <img> (a black mark turns white in dark mode), or null for a model without one. */
export function logoFor(model: string): HTMLImageElement | null {
  const l = LOGOS[model];
  if (!l) return null;
  const img = document.createElement('img');
  img.src = appPath(`logos/${l.file}`);
  img.alt = '';
  img.decoding = 'async';
  img.className = `logo${l.shape ? ` ${l.shape}` : ''}${l.mono ? ' mono-mark' : ''}`;
  return img;
}
