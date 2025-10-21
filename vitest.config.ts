import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    reporters: ['verbose'],
    testTimeout: 10000,
    hookTimeout: 10000,
    teardownTimeout: 5000,
    isolate: true,
    setupFiles: ['test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'coverage/**',
        'dist/**',
        'test/**',
        'scripts/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/node_modules/**',
      ],
    },
  },
  resolve: {
    alias: {
      '@cli': resolve(__dirname, './src/cli'),
      '@api': resolve(__dirname, './src/api'),
      '@core': resolve(__dirname, './src/core'),
      '@infra': resolve(__dirname, './src/infra'),
      '@shared': resolve(__dirname, './src/shared'),
    },
  },
  esbuild: {
    target: 'node18',
    format: 'esm',
  },
});
