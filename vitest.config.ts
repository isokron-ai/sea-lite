import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Generous: the suite spawns many CLI and server processes, and a loaded
    // machine (the 0.7.0 dogfood run) pushed one past 20 s.
    testTimeout: 60_000,
  },
});
