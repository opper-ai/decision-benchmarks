/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { configFromEnv, createApp } from './server/app.ts';
import { seedSamples } from './server/store.ts';

function api(): Plugin {
  return {
    name: 'jev-fighter-api',
    configureServer(server) {
      const env = { ...loadEnv('development', process.cwd(), ''), ...process.env };
      void seedSamples();
      const handle = createApp(configFromEnv(env));
      server.middlewares.use((req, res, next) => {
        handle(req, res).then((done) => (done ? undefined : next()), next);
      });
    },
  };
}

export default defineConfig({
  plugins: [api()],
  appType: 'spa',
  server: { port: 5173 },
  test: { exclude: ['**/node_modules/**', 'scratch/**', 'dist/**'] },
});
