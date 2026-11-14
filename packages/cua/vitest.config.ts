import { defineConfig } from 'vitest/config';

/** Unit tests: Cua Driver is a scripted fake, so no native runtime, window, or Windows host is needed. */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
