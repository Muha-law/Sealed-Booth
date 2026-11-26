import { defineConfig } from 'vitest/config';

// Separate from vite.config.mjs on purpose: that one sets `root: 'web'` for the
// site build, which would make vitest look for tests under web/ and find none.
export default defineConfig({
  test: {
    root: '.',
    include: ['test/**/*.test.ts'],
    // The crypto here is genuinely slow: ML-DSA-87 keygen plus ML-KEM-1024.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
