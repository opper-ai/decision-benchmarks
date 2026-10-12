// One Vite config for every game, run per game: GAME=<slug> npm run dev, or GAME=<slug> npx vite build (scripts/build.ts
// builds every game in games/registry.ts). The game's folder is the root and its public/ the public dir; the build
// goes to dist/<slug> and is served at <APP_BASE_PATH>/<slug>/, where the dev server also mounts the game's routes.
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { gamePlugin } from './packages/kit/server/plugin.ts';
import { normalizeBasePath } from './packages/kit/shared/base-path.ts';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
/** Where the games are published, for share links and social-card tags, unless VITE_PUBLIC_URL says otherwise. */
const DEFAULT_PUBLIC_URL = 'https://opper.ai';
const DEFAULT_BASE_PATH = '/decision-benchmarks';

export default defineConfig(async ({ command, mode }) => {
  const slug = process.env.GAME;
  // Loaded by Node at run time, not bundled with this config: Vite's config bundler would otherwise resolve every
  // game's lazy import in the registry, including the Pac-Man fixture, which the image leaves out.
  const registry: typeof import('./games/registry.ts') = await import(pathToFileURL(resolve(ROOT, 'games/registry.ts')).href);
  const entry = slug ? registry.findGame(slug) : undefined;
  if (!slug || !entry) throw new Error('Set GAME to the game to serve or build, e.g. GAME=pacman npm run dev');
  const env = loadEnv(mode, ROOT, ['OPPER_', 'SESSION_', 'TYPESAFE_', 'APP_', 'PUBLIC_', 'TRUSTED_', 'HIGHSCORES_', 'ALLOW_']);
  // APP_BASE_PATH (e.g. /decision-benchmarks) serves every game below that prefix; empty serves them at /<slug>/.
  const basePath = normalizeBasePath(env.APP_BASE_PATH);
  const gameRoot = resolve(ROOT, 'games', slug);
  const pages = readdirSync(gameRoot).filter((f) => f.endsWith('.html'));
  const publicUrl = (loadEnv(mode, ROOT, 'VITE_').VITE_PUBLIC_URL ?? '').replace(/\/+$/, '') || DEFAULT_PUBLIC_URL;
  return {
    root: gameRoot,
    publicDir: resolve(gameRoot, 'public'),
    envDir: ROOT,
    base: `${basePath}/${slug}/`,
    // Also replaced in the game's HTML as %VITE_PUBLIC_URL% and %VITE_APP_URL%.
    define: {
      'import.meta.env.VITE_PUBLIC_URL': JSON.stringify(publicUrl),
      /** The game's public address with a trailing slash, e.g. https://opper.ai/decision-benchmarks/snake/. */
      'import.meta.env.VITE_APP_URL': JSON.stringify(`${publicUrl}${basePath || DEFAULT_BASE_PATH}/${slug}/`),
    },
    // The game's API routes, for the dev server only: a build needs no server code.
    plugins: command === 'serve' ? [gamePlugin(env, await entry.server(), { pages: pages.filter((p) => p !== 'index.html').map((p) => p.replace(/\.html$/, '')) })] : [],
    // The kit lives outside the game's root.
    server: { fs: { allow: [ROOT] } },
    build: {
      outDir: resolve(ROOT, 'dist', slug),
      emptyOutDir: true,
      rollupOptions: { input: Object.fromEntries(pages.map((p) => [p.replace(/\.html$/, ''), resolve(gameRoot, p)])) },
    },
  };
});
