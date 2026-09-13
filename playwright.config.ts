import { defineConfig } from '@playwright/test'

/**
 * E2E 配置（R02）：webServer 启动 scripts/e2e-server.ts，
 * 其中含独立 PGlite 数据库 / 存储目录 / next dev / worker，与本地开发端口隔离。
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3210',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm tsx scripts/e2e-server.ts',
    url: 'http://127.0.0.1:3210/login',
    reuseExistingServer: false,
    timeout: 240_000,
  },
})
