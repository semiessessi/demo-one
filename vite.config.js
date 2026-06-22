import { defineConfig } from 'vite';

// The app is modern (ESM, dynamic imports) and main.js uses top-level await to
// create the backend, so build for a target (es2022) that supports it.
export default defineConfig({
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        // Split the three.js vendor code into its own chunk: it rarely changes (so it caches across
        // app deploys) and keeps the app chunk well under the 500 kB warning. Cloudflare serves each
        // as a static asset (gzip/brotli on the wire); none approach the 25 MiB per-file limit.
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
        },
      },
    },
  },
});
