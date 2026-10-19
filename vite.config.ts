import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const webRoot = fileURLToPath(new URL('./src/web', import.meta.url));

export default defineConfig({
  root: webRoot,
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
  },
});
