import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';

// Vite config for AccessSync Owner Dashboard (Svelte component library)
// Source:  admin/svelte/
// Output:  admin/public/dist/
// Served:  Express static middleware → admin/public/

export default defineConfig({
  plugins: [svelte()],
  root: path.resolve(__dirname, 'admin/svelte'),
  build: {
    outDir: path.resolve(__dirname, 'admin/public/dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'admin/svelte/main.js'),
      output: {
        entryFileNames: 'bundle.js',
        chunkFileNames: 'bundle-[name].js',
        assetFileNames: (info) => info.name?.endsWith('.css') ? 'bundle.css' : '[name][extname]',
      },
    },
  },
});
