// Makes public/poster.png (1280×720, at most 150 KB: the hub's card and the page's og:image) from a curated replay's
// best moment: headless Chrome photographs the page's #/still/<file> route (src/poster.ts draws it with the share
// image's shapes), and ImageMagick cuts the colours down until it fits.
//
//   GAME=holdem npm run dev -- --port 5199        (any server of the page: the dev server, or npm start on a build)
//   node games/holdem/scripts/poster.ts --url http://localhost:5199/holdem/ --file claude-vs-gpt.json.gz [--hand 23] [--kind bluff]
//
// Needs Google Chrome (or CHROME=<path>) and ImageMagick's `magick` on the PATH.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MAX_POSTER_BYTES, pngSize, validatePoster } from '../../../packages/kit/shared/contract.ts';

const { values } = parseArgs({ options: { url: { type: 'string' }, file: { type: 'string' }, hand: { type: 'string' }, kind: { type: 'string' }, out: { type: 'string' } } });
const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
const base = (values.url ?? die('--url <the page, e.g. http://localhost:5199/holdem/> is required')).replace(/#.*$/, '');
const file = values.file ?? die('--file <a curated replay in public/demo/> is required');
// A file path, not the URL's pathname: that is percent-encoded (a checkout path with a space would be written wrong).
const out = values.out ?? fileURLToPath(new URL('../public/poster.png', import.meta.url));
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const query = new URLSearchParams({ ...(values.hand ? { hand: String(Number(values.hand)) } : {}), ...(values.kind ? { kind: values.kind } : {}) }).toString();
const target = `${base}#/still/${encodeURIComponent(file)}${query ? `?${query}` : ''}`;

/** The poster's bytes, or why not. */
function make(dir: string): Buffer | string {
  const shot = join(dir, 'shot.png');
  // A fresh profile; virtual time lets the replay load, the fonts and faces arrive and the canvas draw.
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1280,720', `--user-data-dir=${join(dir, 'profile')}`, '--virtual-time-budget=20000', `--screenshot=${shot}`, target], { stdio: 'ignore', timeout: 120_000 });
  const size = pngSize(readFileSync(shot));
  if (size?.width !== 1280 || size.height !== 720) return `the screenshot is ${size ? `${size.width}x${size.height}` : 'not a PNG'}, not 1280x720`;
  // Fewer colours until it fits (the felt and the faces quantise well; 256 is usually enough). No dither: it would
  // speckle the dark room, which is flat colour anyway.
  for (const colors of [256, 224, 192, 160, 128, 96, 64]) {
    const small = join(dir, `poster-${colors}.png`);
    execFileSync('magick', [shot, '-strip', '-dither', 'None', '-colors', String(colors), '-define', 'png:compression-level=9', '-define', 'png:compression-filter=5', `PNG8:${small}`]);
    const bytes = statSync(small).size;
    console.log(`${colors} colours: ${Math.ceil(bytes / 1024)} KB`);
    if (bytes <= MAX_POSTER_BYTES) {
      const png = readFileSync(small);
      const problems = validatePoster(png);
      return problems.length ? problems.join('\n') : png;
    }
  }
  return `no palette brought the poster under ${MAX_POSTER_BYTES / 1024} KB`;
}

const dir = mkdtempSync(join(tmpdir(), 'holdem-poster-'));
let made: Buffer | string;
try {
  made = make(dir);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (typeof made === 'string') die(made);
writeFileSync(out, made);
console.log(`wrote ${out} from ${target}: 1280x720, ${made.length} bytes`);
