import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Tests never reach the screen (no notifications, dialogs or apps).
    setupFiles: ['../../test-support/quiet.ts'],
    // One temp folder for the whole run, removed when it ends.
    globalSetup: ['../../test-support/temp-root.ts'],
    // The deploy gate runs this suite on the live Mac beside whatever else it is doing. With vitest's
    // five seconds, a busy minute failed a deploy (2026-10-13: fourteen tests timed out, none wrong).
    // The runtime's suite has had thirty seconds from the start.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
