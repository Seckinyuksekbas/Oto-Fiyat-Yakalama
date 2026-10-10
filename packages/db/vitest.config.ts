import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.spec.ts'], testTimeout: 60_000, hookTimeout: 180_000 },
});
