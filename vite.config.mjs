import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';

export default defineConfig({
  plugins: [svelte()],
  root: path.resolve(__dirname, 'admin/svelte'),
  build: {
    outDir: path.resolve(__dirname, 'admin/public/dist'),
    emptyOutDir: false,
    rollupOptions: {
      input: {
        bundle: path.resolve(__dirname, 'admin/svelte/main.js'),
        planmapping: path.resolve(__dirname, 'admin/svelte/plan-mapping-entry.js'),
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === 'planmapping') return 'plan-mapping.js';
          return '[name].js';
        },
        chunkFileNames: (chunk) => `chunk-${chunk.name.toLowerCase()}.js`,
        assetFileNames: (info) => {
          if (info.name && info.name.endsWith('.css')) return '[name].css';
          return '[name][extname]';
        },
      },
    },
  },
});
