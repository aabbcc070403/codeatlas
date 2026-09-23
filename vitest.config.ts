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
    // 测试基线封闭：额度按规格默认值断言；AI 一律 Mock 基线（清空凭证），
    // 不受开发机 .env 中真实评测配置（额度/真实模型凭证）影响
    env: {
      AI_DAILY_TOKEN_LIMIT: '300000',
      AI_PROVIDER: 'mock',
      AI_BASE_URL: '',
      AI_API_KEY: '',
      AI_CHAT_MODEL: '',
      AI_EMBEDDING_MODEL: '',
    },
  },
})
