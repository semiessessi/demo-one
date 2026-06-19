import { defineConfig } from 'vite';

// The app is modern (ESM, dynamic imports) and main.js uses top-level await to
// create the backend, so build for a target (es2022) that supports it.
export default defineConfig({
  build: {
    target: 'es2022',
  },
});
