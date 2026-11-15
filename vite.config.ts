/**
 * Builds the web chat (`bun run build:web`): a client-side single-page application under
 * `src/surface/renderer/web/`, emitted as static assets to `dist/web/`, from where the
 * harness's `web-ui` plugin serves it.
 */
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { UserConfig } from 'vite';
import { defineConfig } from 'vite';

const config: UserConfig = defineConfig({
  root: fileURLToPath(new URL('src/surface/renderer/web', import.meta.url)),
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL('dist/web', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});

export default config;
