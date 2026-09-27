import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/integration/**/*.test.js'], testTimeout: 600_000, hookTimeout: 600_000 },
});
