import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    // beforeEach restores a PGlite snapshot per test; allow headroom when 9+ suites run in parallel.
    hookTimeout: 30_000,
  },
});
