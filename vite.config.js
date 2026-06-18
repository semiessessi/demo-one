import { defineConfig } from 'vite';

// The app is modern (WebGPU primary path, ESM, dynamic imports) and main.js uses
// top-level await to pick the backend, so build for a target that supports it.
// (es2022 is supported by every browser that can run the WebGL2 fallback too.)
export default defineConfig({
  build: {
    target: 'es2022',
  },
});
