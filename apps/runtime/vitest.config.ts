import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests never reach the screen (no notifications, dialogs or apps).
    setupFiles: ['../../test-support/quiet.ts'],
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    environment: 'node',
    // The database tests share one scratch database and reset it between files.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
