// The game a script works on: --game <slug> (or GAME), from games/registry.ts or its fixtures.
import { findGame, FIXTURES, REGISTRY, type RegisteredGame } from '../games/registry.ts';

export async function gameArg(argv: string[], env: Record<string, string | undefined> = process.env): Promise<{ slug: string; game: RegisteredGame }> {
  const i = argv.findIndex((a) => a === '--game' || a.startsWith('--game='));
  const slug = i === -1 ? env.GAME : argv[i]!.includes('=') ? argv[i]!.split('=')[1] : argv[i + 1];
  const game = slug ? findGame(slug) : undefined;
  if (!slug || !game) {
    console.error(`Name a game with --game <slug>: one of ${[...REGISTRY, ...FIXTURES].map((g) => g.slug).join(', ')}`);
    process.exit(1);
  }
  return { slug, game };
}
