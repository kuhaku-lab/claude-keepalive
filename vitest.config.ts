import { defineConfig } from 'vitest/config';

const includeE2e = process.env.RUN_E2E === '1';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // e2e tests hit a real `claude` CLI and consume API tokens; gate them
    // behind an explicit env flag so `pnpm test` stays cheap and hermetic.
    exclude: includeE2e ? [] : ['test/e2e/**'],
    // Layer-specific scripts may target empty subdirectories; don't fail.
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
    // Default keeps unit/integration tests fast. e2e tests override per-suite.
    testTimeout: 5_000,
  },
});
