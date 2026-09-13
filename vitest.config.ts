import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve('src') },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 90_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
