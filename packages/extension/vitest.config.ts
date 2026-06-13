import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    environmentMatchGlobs: [
      ['src/__tests__/e2e/**', 'node'],
    ],
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@browserhandle/protocol': resolve(__dirname, '../protocol/src/index.ts'),
    },
  },
});
