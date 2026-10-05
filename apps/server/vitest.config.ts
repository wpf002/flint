import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Tests never reach the screen (no notifications, dialogs or apps).
    setupFiles: ['../../test-support/quiet.ts'],
  },
});
