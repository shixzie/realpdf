import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    globalSetup: ['tests/global-setup.mjs'],
    // Browser suites share one app, one sample document and one output folder.
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 180_000,
    teardownTimeout: 30_000,
  },
})
