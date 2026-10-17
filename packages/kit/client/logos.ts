// Each model's maker mark, as jevman shows it: the mark the maker uses on its own profiles (site, GitHub, Hugging
// Face), served from the game's public/logos (every game has its own copy). Jared Palmer publishes Kev as himself, so
// Kev's mark is his avatar; Convai Innovations uses its brain-and-circuit logo; Upright's is its Hugging Face avatar and
// favicon. GreenPT's Metis has none yet.
import { appPath } from './paths.ts';

const LOGOS: Record<string, { file: string; page?: string; shape?: 'round' | 'square'; mono?: true }> = {
  'typesafe/jev-1.13.0': { file: 'typesafe.png', page: 'typesafe/jev-1-13-0', shape: 'square' },
  'typesafe/jev-1.14.0': { file: 'typesafe.png', page: 'typesafe/jev-1-14-0', shape: 'square' },
  'sference/clef': { file: 'cloudflare.svg', page: 'cloudflare/clef' },
  'cloudflare:global/clef-flash': { file: 'cloudflare.svg', page: 'cloudflare/clef-flash' },
  'opper/kev-4b': { file: 'jared-palmer.webp', page: 'community/kev-4b', shape: 'round' },
  'berget/convaiinnovations/laya': { file: 'convai.webp', page: 'community/laya', shape: 'square' },
  'openai/gpt-6-luna-decisions': { file: 'openai.svg', page: 'openai/gpt-6-luna-decisions', mono: true },
  'azure:global/microsoft-decision-1': { file: 'microsoft.svg', page: 'microsoft/microsoft-decision-1' },
  'empiriolabs/aplomb-1': { file: 'empiriolabs.png', page: 'empiriolabs/aplomb-1', shape: 'round' },
  'eevo:eu/eevo-1': { file: 'upright.png', page: 'upright/eevo-1', shape: 'square' },
};

/** The model's page on opper.ai (its specs, prices and routes), for the models Opper serves. */
export const pageOf = (model: string): string | undefined => (LOGOS[model]?.page ? `https://opper.ai/${LOGOS[model].page}` : undefined);

/** The model's maker mark as an <img> (a black mark turns white in dark mode), or null for a model without one. */
export function logoFor(model: string): HTMLImageElement | null {
  const l = LOGOS[model];
  if (!l) return null;
  const img = document.createElement('img');
  img.src = appPath(`logos/${l.file}`);
  img.alt = '';
  img.decoding = 'async';
  img.width = 18;
  img.height = 18;
  img.className = `logo${l.shape ? ` ${l.shape}` : ''}${l.mono ? ' mono-mark' : ''}`;
  return img;
}
