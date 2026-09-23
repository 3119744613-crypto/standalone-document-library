import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';

// This build never loads the original application's environment or entry point.
export default defineConfig({
  base: './',
  envDir: false,
  plugins: [react()],
  build: {
    outDir: 'dist-general',
    rollupOptions: {input: fileURLToPath(new URL('./general.html', import.meta.url))},
  },
});
