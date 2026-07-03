import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const fromHere = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

// Resolve the package by its public name straight to source, so the playground
// runs the real public API with instant HMR and no prior build step. The more
// specific subpath alias must come first.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: 'poker-engine-ts/testing',
        replacement: fromHere('../../src/testing/index.ts'),
      },
      {
        find: 'poker-engine-ts/format',
        replacement: fromHere('../../src/format/index.ts'),
      },
      { find: 'poker-engine-ts', replacement: fromHere('../../src/index.ts') },
    ],
  },
});
