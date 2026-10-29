import { defineConfig } from 'vite';

// Port 5173 is hardcoded in the upstream tools/ and render/ puppeteer scripts.
export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
