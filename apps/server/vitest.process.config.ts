import { defineConfig } from 'vitest/config';

/**
 * The process test alone: the real server started as a process of its own, on
 * a scratch HOME, against loopback stand-ins (test/process). It takes a few
 * seconds and is part of `pnpm test` too; `pnpm test:process` runs just it.
 */
export default defineConfig({
  test: {
    environment: 'node',
    // Tests never reach the screen (no notifications, dialogs or apps).
    setupFiles: ['../../test-support/quiet.ts'],
    include: ['test/process/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One server at a time: each run owns its ports and its scratch HOME.
    fileParallelism: false,
  },
});
