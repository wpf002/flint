import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { setupFiles: ['../../test-support/quiet.ts'], include: ['test/**/*.test.ts'], environment: 'node' },
});
