// Generates the table avatars: one illustrated character per model, five faces each (the `mood` a chat model sends).
//
//   node games/holdem/scripts/avatars.ts [--only <model id or slug>]... [--mood <mood>]... [--force]
//
// Writes games/holdem/public/avatars/<slug>/<mood>.webp (384×384, ≤ ~30 KB) and avatars/index.json, which maps each
// model id to its slug, name and moods. A face that already exists is skipped unless --force.
//
// Consistency: the relaxed face is drawn from the character prompt; the other four are edits of it ("same character,
// change only the expression"), so the character, framing and light stay put. The full-size relaxed image is kept in
// --cache (default: the OS temp dir) to edit from; without it, the committed relaxed.webp is the reference. After
// regenerating a relaxed face with --force, regenerate that character's other moods too.
//
// Calls Opper's image API (POST /v3/images) with OPPER_API_KEY, a project key. With an organization key, also set
// OPPER_PROJECT to a project UUID. Needs cwebp (or ImageMagick) on PATH. Costs about $0.015 a relaxed face and
// $0.02 an edit on the default model; the total is printed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const MOODS = ['relaxed', 'confident', 'nervous', 'annoyed', 'smug'] as const;
export type Mood = (typeof MOODS)[number];

const IMAGE_MODEL = 'openai/gpt-image-2.5-flare';
const SIZE = 384;
const MAX_BYTES = 30_000;

/** The art direction every character shares. */
export const STYLE = `Character portrait for a poker video game, in the style of a mid-century casino illustration: hand-painted gouache on lightly textured paper, bold simplified shapes and strong graphic silhouettes, flat colour planes with soft dry-brush shading, crisp dark-brown ink contour lines, a stylised caricature with slightly exaggerated features and expressive eyes — like 1960s magazine and casino-poster art, not photorealistic, no glossy digital rendering. Warm amber light from a low table lamp on the face, a cool teal rim light on the far side. Framing: a tight head-and-shoulders close-up in three-quarter view; the head is large, about half the height of the square frame, centred, with the whole head, hair and any headwear fully inside the frame and clear space above it, shoulders cut off by the bottom edge; no hands visible. Background: plain, flat deep dark bottle-green with a soft vignette, empty, no scenery, no props. No text, no letters, no numbers, no logos, no watermark, no border, no frame.`;

/** What each mood looks like, written to read at 64 px. */
export const MOOD_PROMPTS: Record<Mood, string> = {
  relaxed: 'relaxed — an easy, unhurried half-smile, soft heavy-lidded eyes, head tilted slightly, shoulders loose',
  confident: 'confident — chin raised high, a steady piercing gaze straight at the viewer, a broad self-assured grin, chest out and shoulders squared',
  nervous: 'nervous — eyebrows raised and pinched together with worry, wide eyes darting sideways, a tight wobbly grimace showing clenched teeth, a big bead of sweat running down the temple, shoulders hunched up',
  annoyed: 'annoyed — a deep scowl with heavily furrowed, lowered brows, narrowed glaring eyes, mouth twisted down in irritation, head pushed forward',
  smug: 'smug — a big self-satisfied lopsided smirk, one eyebrow cocked high, half-lidded eyes looking down the nose, head tilted back',
};

const TITAN = 'A titan: larger than life, seen slightly from below, immense broad shoulders spanning the full width of the frame, a faint majestic glow behind the head; the head sits a little lower in the frame so the whole head and crown fit with clear space above.';

/** One character per model, inspired by the model's name only. Each has its own colour and silhouette. */
export const CHARACTERS: { id: string; name: string; character: string; slug?: string }[] = [
  // Decision models (packages/kit/shared/models.ts)
  { id: 'typesafe/jev-1.13.0', name: 'Jev 1.13', character: 'A wiry, quick-witted young card sharp in his twenties: a tall glossy jet-black pompadour quiff, a thin pencil moustache, sharp cheekbones, small round amber-tinted spectacles, a single silver ear stud; an electric-teal satin bomber jacket over a black turtleneck.' },
  { id: 'sference/clef', name: 'Clef', character: 'A poised jazz pianist woman in her forties with deep brown skin: her black hair swept up into one tall, elegant spiral curl; long gold drop earrings; a deep violet velvet gown and a black-and-white piano-key patterned silk scarf around her shoulders.' },
  { id: 'cloudflare:global/clef-flash', name: 'Clef Flash', character: 'A hyperactive young DJ in her early twenties: a short spiky platinum-blonde pixie cut with one hot-magenta streak, big chunky white headphones around her neck, freckles; a glossy hot-magenta track jacket with a high zipped collar.' },
  { id: 'opper/kev-4b', name: 'Kev 4B', character: 'A short, stocky, round-faced friendly bloke in his thirties: a bushy ginger beard, rosy cheeks, a brown tweed flat cap, a stubby pencil tucked behind one ear; a chunky bright-orange knitted cardigan over a white t-shirt.' },
  { id: 'berget/convaiinnovations/laya', name: 'Laya', character: 'A serene, graceful woman in her thirties with warm brown skin: long dark hair in a thick side braid woven with small gold beads over one shoulder, gold hoop earrings; layered coral-red and saffron-orange silk shawls draped over her shoulders.' },
  { id: 'openai/gpt-6-luna-decisions', name: 'GPT-6 Luna Decisions', character: 'A sharp-eyed snowy owl card dealer, an anthropomorphic owl: fluffy pale silver-white feathers with grey flecks, huge round golden eyes, tufted brows; a lavender silk waistcoat with a tiny silver crescent-moon pin, a translucent lavender dealer\'s eyeshade visor on its head.' },
  { id: 'azure:global/microsoft-decision-1', name: 'Microsoft Decision 1', character: 'A meticulous corporate strategist in his fifties: neatly side-parted steel-grey hair, a tidy clipped grey beard, rectangular black-rimmed glasses; a crisp navy-blue pinstripe three-piece suit, a pale sky-blue shirt and a silver tie, no badges or emblems.' },
  { id: 'empiriolabs/aplomb-1', name: 'Aplomb 1', character: 'A supremely self-possessed old-school gentleman gambler in his seventies: a bald crown with tufts of white hair at the sides, a magnificent waxed white handlebar moustache, a gold-rimmed monocle; a burgundy velvet smoking jacket with black satin lapels and a cream silk cravat.' },
  { id: 'greenpt/metis', name: 'Metis', character: 'A wise and cunning woman inspired by the ancient Greek titaness of counsel: curly auburn hair pinned up beneath a gold olive-leaf wreath, keen grey eyes; an ivory draped chiton with gold trim and a round gold shoulder brooch.' },
  // Claude family
  // EU routes (games/holdem/shared/models.ts); the folders keep the names they were first generated under.
  { id: 'aws/claude-haiku-5-5-eu', slug: 'anthropic-claude-haiku-5-5', name: 'Haiku 5.5', character: 'A minimalist poet of very few words: a slender, calm young person with a clean-shaven head and a long neck; a plain high-collared charcoal-black linen tunic; a single vermilion-red ink brush tucked behind one ear. A spare, almost monochrome design with one red accent.' },
  { id: 'vertexai/claude-sonnet-5-5-eu', slug: 'anthropic-claude-sonnet-5-5', name: 'Sonnet 5.5', character: 'A romantic poet in his thirties: tousled shoulder-length chestnut curls, a dreamy face with light stubble; an open-necked ruffled cream shirt under a sky-blue velvet frock coat, a white quill tucked in the breast pocket.' },
  { id: 'aws/claude-opus-5-5', slug: 'anthropic-claude-opus-5-5', name: 'Opus 5.5', character: 'A grand, theatrical orchestra conductor and composer in his sixties: an enormous wild mane of swept-back silver hair, bushy dark eyebrows, a hawkish nose, a neat silver goatee; a black tailcoat with a high white wing collar, a crimson silk cravat and gold braid on the shoulders; a slim white conductor\'s baton tucked behind his ear.' },
  { id: 'anthropic/claude-fable-5-1', name: 'Fable 5.1', character: `A legendary ancient storyteller, a giant of myth: a long flowing snow-white beard braided with tiny glowing amber lanterns, deep-set kind twinkling eyes, a crown of gnarled oak branches; a heavy bronze-and-copper cloak embroidered with tiny fairy-tale scenes. ${TITAN}` },
  // GPT family
  { id: 'azure:eu/gpt-6-luna', name: 'GPT-6 Luna', character: 'A calm, enigmatic woman in her thirties with pale skin: sleek silver-white hair in a crescent-moon-shaped updo, moonstone drop earrings, cool silver eyeshadow; a high-collared midnight-blue satin gown scattered with tiny silver beads.' },
  { id: 'azure/gpt-5.6-terra', name: 'GPT-5.6 Terra', character: 'A sturdy, grounded, weather-beaten man in his fifties with tanned olive skin: a broad face, a short grizzled brown beard, a moss-green wool beanie; a chunky earth-brown cable-knit sweater with a leather shoulder patch, a small amethyst geode pendant on a cord.' },
  { id: 'azure:eu/gpt-6.1-sol', name: 'GPT-6.1 Sol', character: 'A radiant, charismatic showman in his forties with warm golden-brown skin: a big swept-up mane of golden hair flaring out like a sunburst, a gleaming smile; a golden-yellow sequinned dinner jacket with a wide shawl collar, a warm sunny glow on his face.' },
  { id: 'azure/gpt-6-astra-global', name: 'GPT-6 Astra', character: `A colossal cosmic star-being: skin the deep indigo-blue of the night sky speckled with tiny glowing stars and faint constellation lines, long flowing hair like a silver nebula, a crown of small floating points of starlight, softly glowing pale eyes; an ornate dark-silver armoured collar. ${TITAN}` },  // Gemini family (the Gemini set; Argon above it is a titan)
  { id: 'vertexai/gemini-3.1-pro-preview', slug: 'google-gemini-3-1-pro', name: 'Gemini 3.1 Pro', character: 'A poised, unflappable professional card player woman in her fifties with pale skin: a sleek black chignon with one bold silver streak, sharp tortoiseshell cat-eye glasses, a knowing red-lipped mouth, small matching pearl studs; a tailored cream-white double-breasted suit over a dusty-rose silk blouse.' },
  { id: 'vertexai/gemini-3.8-flash-eu', slug: 'google-gemini-3-8-flash', name: 'Gemini 3.8 Flash', character: 'A quick, grinning young press photographer in his twenties: a sandy-blond side-swept quiff under a small straw pork-pie hat with a short red feather, bright eager eyes, a gap-toothed smile; a candy-striped red-and-white summer blazer over a navy polo shirt.' },
  { id: 'vertexai/gemini-3.5-flash-lite-eu', slug: 'google-gemini-3-5-flash-lite', name: 'Gemini 3.5 Flash Lite', character: 'A petite, light-hearted young woman in her early twenties with light-brown skin: black hair in two round twin buns high on her head, big lively eyes, small gold hoop earrings; a pastel mint-green windbreaker with a white collar.' },
  { id: 'vertexai/gemini-4-argon-eu', slug: 'google-gemini-4-argon', name: 'Gemini 4 Argon', character: `A serene colossus of twin natures: smooth pale lilac-grey skin, one eye glowing violet and the other pale ice-blue, a short swept-back crest of hair made of glowing lavender-violet light like gas in a neon tube, a slim crown of two small twin stars side by side; massive gunmetal-grey armoured pauldrons with glowing lavender seams, and a soft violet halo of light behind the head. ${TITAN}` },
  // More chat models, three of them the Open models set (games/holdem/shared/models.ts); folders named for the model,
  // not the route.
  { id: 'xai/grok-4.7', slug: 'xai-grok-4-7', name: 'Grok 4.7', character: 'A deadpan space-age rebel in his forties: short slicked-back jet-black hair with a single silver streak, mirrored silver aviator goggles pushed up on his forehead, a sardonic face with a crooked nose; a black leather flight jacket with a high collar and an acid-yellow silk scarf.' },
  { id: 'melious/deepseek-v4.1-flash', slug: 'deepseek-v4-1-flash', name: 'DeepSeek V4.1 Flash', character: 'A nimble, eager young free diver in her twenties with tanned skin: sleek wet black hair pulled back tight, round swimming goggles pushed up on her forehead, a few water droplets on her cheeks; a cobalt-blue wetsuit with a high zipped collar and a lightning-yellow stripe across the shoulder.' },
  { id: 'nebius/deepseek-ai/DeepSeek-V4-Pro-0813', slug: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', character: 'A seasoned deep-sea submarine captain in his sixties: a weathered square face, a thick close-cropped white beard, bushy white eyebrows, keen pale-blue eyes; a navy-blue peaked captain\'s cap with a plain brass band, a chunky rust-red knitted fisherman\'s roll-neck sweater.' },
  { id: 'tensorx/qwen/qwen3.8-flash-next', slug: 'qwen3-8-flash-next', name: 'Qwen3.8 Flash-Next', character: 'A sprightly, endlessly curious young racer in her early twenties: a high swinging ponytail of bright tangerine-orange hair, a heart-shaped face with a few freckles; a white motor-racing jacket with tangerine piping and a high padded collar.' },
  { id: 'alibaba:global/qwen3.8-max', slug: 'qwen3-8-max', name: 'Qwen3.8 Max', character: 'A grand, imposing matriarch in her sixties with olive skin: a towering silver beehive hairdo, oversized carved jade drop earrings, sharp arched brows, deep red lipstick; a jade-green brocade jacket with a tall mandarin collar and frog buttons.' },
  { id: 'sference/kimi-k3', slug: 'moonshot-kimi-k3', name: 'Kimi K3', character: 'A calm, steely high-altitude mountaineer woman in her thirties: wind-burned cheeks, black hair in two short braids, snow goggles hanging around her neck; a puffy crimson-red down jacket with its fur-trimmed hood pushed back over her shoulders.' },
  { id: 'inceptron/zai-org/GLM-5.3-Flash', slug: 'zhipu-glm-5-3-flash', name: 'GLM-5.3 Flash', character: 'A lanky, jittery young street magician in his twenties: a messy mop of bright lime-green hair, big ears, a wide toothy face; a sparkly lime-green bow tie and a black waistcoat over a crumpled white shirt.' },
  { id: 'inceptron/zai-org/GLM-5.3', slug: 'zhipu-glm-5-3', name: 'GLM-5.3', character: 'A dignified grand stage illusionist in his fifties with light brown skin: a neat salt-and-pepper goatee, heavy-lidded knowing eyes, a tall black top hat with a wide ochre-gold band; an ochre-gold velvet cape over a black tailcoat and white wing collar.' },
  { id: 'nebius/MiniMaxAI/MiniMax-M3', slug: 'minimax-m3', name: 'MiniMax M3', character: 'A small, sharp-featured, quick-eyed woman in her forties with dark brown skin: an enormous round copper-red afro twice the width of her face, tiny round wire spectacles; a black-and-white houndstooth blazer with a cherry-red pocket square.' },
];

/** A filesystem- and URL-safe directory name for a model id. */
export const slugFor = (id: string): string => id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** A character's folder: its own slug when it has one (a model whose route changed keeps its faces), else its id's. */
const slugOf = (c: { id: string; slug?: string }): string => c.slug ?? slugFor(c.id);

const characterPrompt = (c: (typeof CHARACTERS)[number], mood: Mood) => `${c.character}\n\nExpression: ${MOOD_PROMPTS[mood]}.\n\n${STYLE}`;

const editPrompt = (c: (typeof CHARACTERS)[number], mood: Mood) =>
  `Edit this character portrait. Keep everything else identical: the same character (${c.character.replace(TITAN, '').trim()}), the same face, hair, costume, colours, art style, brushwork, lighting, camera angle, framing, crop and plain dark green background. Keep the whole head and hair inside the frame. Change only the facial expression and posture to: ${MOOD_PROMPTS[mood]}. Exaggerate the expression like a caricature so it reads clearly even as a tiny thumbnail. No hands visible. No text, no letters, no logos.`;

// --- CLI ---------------------------------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const { values } = parseArgs({
    options: {
      only: { type: 'string', multiple: true, default: [] },
      mood: { type: 'string', multiple: true, default: [] },
      force: { type: 'boolean', default: false },
      out: { type: 'string', default: join(here, '../public/avatars') },
      cache: { type: 'string', default: join(tmpdir(), 'holdem-avatars') },
      model: { type: 'string', default: IMAGE_MODEL },
      quality: { type: 'string', default: 'medium' },
      concurrency: { type: 'string', default: '4' },
    },
  });
  const die = (msg: string): never => {
    console.error(msg);
    process.exit(1);
  };
  const key = process.env.OPPER_API_KEY || die('set OPPER_API_KEY (and OPPER_PROJECT for an organization key)');
  const project = process.env.OPPER_PROJECT;

  const only = values.only.flatMap((s) => s.split(','));
  const chars = only.length ? CHARACTERS.filter((c) => only.includes(c.id) || only.includes(slugOf(c))) : CHARACTERS;
  for (const o of only) if (!CHARACTERS.some((c) => c.id === o || slugOf(c) === o)) die(`unknown model: ${o}`);
  const moods = values.mood.flatMap((s) => s.split(',')) as Mood[];
  for (const m of moods) if (!MOODS.includes(m)) die(`unknown mood: ${m} (one of ${MOODS.join(', ')})`);
  const wanted: readonly Mood[] = moods.length ? moods : MOODS;
  const slugs = new Set(CHARACTERS.map(slugOf));
  if (slugs.size !== CHARACTERS.length) die('two models share a slug');

  const encoder = which('cwebp') ? 'cwebp' : which('magick') ? 'magick' : die('needs cwebp or ImageMagick (magick) on PATH');
  mkdirSync(values.out, { recursive: true });
  mkdirSync(values.cache, { recursive: true });
  writeIndex(values.out);

  let cost = 0;
  let made = 0;
  async function generate(body: Record<string, unknown>): Promise<Buffer> {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch('https://api.opper.ai/v3/images', {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(project ? { 'x-opper-project': project } : {}) },
          body: JSON.stringify({ model: values.model, size: '1024x1024', quality: values.quality, n: 1, ...body }),
          signal: AbortSignal.timeout(240_000),
        });
        const text = await res.text();
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`), { retry: res.status >= 500 || res.status === 429 });
        const json = JSON.parse(text) as { data: { b64_json?: string }[]; usage?: { cost?: number } };
        cost += json.usage?.cost ?? 0;
        const b64 = json.data[0]?.b64_json;
        if (!b64) throw new Error(`no image in response: ${text.slice(0, 300)}`);
        return Buffer.from(b64, 'base64');
      } catch (err) {
        const retry = (err as { retry?: boolean }).retry ?? (err as Error).name !== 'SyntaxError';
        if (!retry || attempt >= 3) throw err;
        console.warn(`  retry ${attempt}: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 3000 * attempt));
      }
    }
  }

  async function one(c: (typeof CHARACTERS)[number]) {
    const slug = slugOf(c);
    const dir = join(values.out, slug);
    mkdirSync(dir, { recursive: true });
    const target = (m: Mood) => join(dir, `${m}.webp`);
    const basePng = join(values.cache, `${slug}-relaxed.png`);
    // The relaxed face is the reference for every other mood, so it is made first when missing.
    const needBase = !existsSync(target('relaxed')) || (values.force && wanted.includes('relaxed'));
    if (needBase) {
      console.log(`${c.name}: relaxed`);
      const png = await generate({ prompt: characterPrompt(c, 'relaxed') });
      writeFileSync(basePng, png);
      encode(encoder, basePng, target('relaxed'));
      made++;
    }
    let ref: Buffer | undefined;
    for (const m of wanted) {
      if (m === 'relaxed') continue;
      if (!values.force && existsSync(target(m))) continue;
      if (!ref && existsSync(basePng)) ref = readFileSync(basePng);
      else if (!ref) {
        ref = toPng(target('relaxed'));
        console.warn(`${c.name}: no full-size relaxed image in ${values.cache}; editing from relaxed.webp`);
      }
      console.log(`${c.name}: ${m}`);
      const png = await generate({ prompt: editPrompt(c, m), image: `data:image/png;base64,${ref.toString('base64')}` });
      const tmp = join(values.cache, `${slug}-${m}.png`);
      writeFileSync(tmp, png);
      encode(encoder, tmp, target(m));
      made++;
    }
  }

  const queue = [...chars];
  const failures: string[] = [];
  await Promise.all(
    Array.from({ length: Math.max(1, Number(values.concurrency)) }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        try {
          await one(c);
        } catch (err) {
          failures.push(`${c.name}: ${(err as Error).message}`);
        }
      }
    }),
  );
  console.log(`${made} image(s), $${cost.toFixed(3)}`);
  if (failures.length) die(`failed:\n  ${failures.join('\n  ')}`);
}

function writeIndex(out: string) {
  const index = Object.fromEntries(CHARACTERS.map((c) => [c.id, { slug: slugOf(c), name: c.name, moods: [...MOODS] }]));
  writeFileSync(join(out, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
}

function which(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Resizes to SIZE×SIZE and encodes webp, stepping quality down until it fits MAX_BYTES. */
function encode(encoder: string, src: string, dst: string) {
  for (const q of [80, 72, 64, 56, 48, 40]) {
    if (encoder === 'cwebp') execFileSync('cwebp', ['-quiet', '-q', String(q), '-m', '6', '-sharp_yuv', '-resize', String(SIZE), String(SIZE), src, '-o', dst]);
    else execFileSync('magick', [src, '-resize', `${SIZE}x${SIZE}!`, '-quality', String(q), '-define', 'webp:method=6', dst]);
    if (statSync(dst).size <= MAX_BYTES) return;
  }
  console.warn(`  ${dst}: ${statSync(dst).size} bytes, over ${MAX_BYTES} at the lowest quality`);
}

/** Decodes a webp back to PNG bytes (the reference when the full-size original is gone). */
function toPng(webp: string): Buffer {
  if (which('dwebp')) return execFileSync('dwebp', ['-quiet', webp, '-o', '-'], { maxBuffer: 64 << 20 });
  return execFileSync('magick', [webp, 'png:-'], { maxBuffer: 64 << 20 });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
