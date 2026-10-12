import { defineConfig } from 'vitest/config';

// Every package's and game's tests, from the root. games/fighter keeps its own setup (it needs mediabunny, which is not
// a root dependency) until it is ported onto the kit.
export default defineConfig({
  // What vite.config.ts defines for a game's page, so client modules load the same way under test.
  define: {
    'import.meta.env.VITE_PUBLIC_URL': JSON.stringify('https://opper.ai'),
    'import.meta.env.VITE_APP_URL': JSON.stringify('https://opper.ai/decision-benchmarks/test/'),
  },
  test: {
    include: ['packages/**/tests/**/*.test.ts', 'games/*/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'games/fighter/**'],
    // Some tests replay whole games, which can take several seconds on a busy CI runner.
    testTimeout: 30_000,
  },
});
