import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  // VITE_BASE is set in CI to the GitHub Pages path (e.g. /Vantage-PM/).
  // Defaults to '/' for local dev and user/org GitHub Pages deployments.
  base: process.env.VITE_BASE ?? '/',

  plugins: [svelte({ hot: !process.env.VITEST })],

  // Force the browser-side Svelte build in all environments (including Vitest/jsdom)
  // so that client-only APIs like mount() are available in tests.
  resolve: {
    conditions: ['browser'],
  },

  // @babylonjs/havok ships a WASM binary — esbuild cannot pre-bundle it.
  optimizeDeps: {
    exclude: ['@babylonjs/havok'],
  },

  build: {
    // WebGPU requires modern browsers — no transpilation needed.
    target: 'esnext',

    rollupOptions: {
      output: {
        // Split the heavy Babylon.js packages into separate cacheable chunks.
        // The game code and Svelte UI stay in the main entry chunk.
        // @babylonjs/havok stays in the main chunk — its WASM binary uses a
        // relative self-reference that breaks when the JS wrapper moves chunks.
        manualChunks: {
          'vendor-babylon-core':    ['@babylonjs/core'],
          'vendor-babylon-loaders': ['@babylonjs/loaders'],
        },
      },
    },
  },

  test: {
    environment: 'jsdom',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/engine/**', 'src/components/**'],
    },
  },
});
