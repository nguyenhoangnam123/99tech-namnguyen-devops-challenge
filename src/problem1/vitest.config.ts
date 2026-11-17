import { defineConfig } from 'vitest/config';

const source = { resolve: { conditions: ['@exchange/source'] } };

export default defineConfig({
  ...source,
  test: {
    projects: [
      {
        ...source,
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'services/*/test/unit/**/*.test.ts'],
        },
      },
      {
        ...source,
        test: {
          name: 'integration',
          include: ['services/*/test/integration/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      {
        ...source,
        test: {
          name: 'e2e',
          fileParallelism: false,
          include: ['tests/e2e/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 60_000,
        },
      },
      {
        ...source,
        test: {
          name: 'security',
          fileParallelism: false,
          include: ['tests/security/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'services/*/src/**'],
      exclude: ['**/gen/**'],
    },
  },
});
