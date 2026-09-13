/**
 * E2E 隔离环境（R02）：独立 PGlite 数据库 + 独立存储目录 + 生产构建（next build + next start）+ worker。
 * 使用独立 distDir（.next-e2e），不干扰本地开发（3100/.next）与数据库（5433）。
 * 由 playwright webServer 启动，就绪判定 URL：/login。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import postgres from 'postgres'
import { startDbServer } from './db-server'
import { applyMigrations } from '../src/server/db/migrate'
import { seedAll } from '../src/server/db/seed'
import { generateDataset } from '../src/core/evaluation/fixtures'

const APP_PORT = 3210

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-e2e-db-'))
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-e2e-storage-'))
  // R08：评测 fixtures 隔离目录（与仓库 fixtures/ 无关），并限制单次评测项目数（口径见 progress.md）
  const fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-e2e-fixtures-'))
  generateDataset(fixturesDir)

  let handle: Awaited<ReturnType<typeof startDbServer>> | null = null
  for (let i = 0; i < 20 && !handle; i++) {
    const port = 25300 + Math.floor(Math.random() * 800)
    try {
      handle = await startDbServer({ dataDir, port, maxConnections: 8 })
    } catch {
      // 端口被占用：换下一个
    }
  }
  if (!handle) throw new Error('无法为 e2e 分配数据库端口')

  const sql = postgres(handle.url, { max: 2, prepare: false })
  await applyMigrations(sql)
  await seedAll(sql)
  await sql.end()

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: handle.url,
    STORAGE_ROOT: storageRoot,
    AI_PROVIDER: 'mock',
    DEMO_ACCESS_CODE: 'e2e-demo-2026',
    ADMIN_ACCESS_CODE: 'e2e-admin-2026',
    SESSION_SECRET: 'e2e-session-secret',
    APP_ORIGIN: `http://127.0.0.1:${APP_PORT}`,
    NEXT_DIST_DIR: '.next-e2e',
    EVAL_FIXTURES_DIR: fixturesDir,
    EVAL_PROJECT_LIMIT: '6',
  }

  const nextBin = path.resolve('node_modules/next/dist/bin/next')
  const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs')

  // 生产构建（e2e 验证真实产物；distDir 隔离，不影响本地 dev）
  const build = spawnSync(process.execPath, [nextBin, 'build'], { env, stdio: 'inherit' })
  if (build.status !== 0) throw new Error(`e2e 构建失败（exit ${build.status}）`)

  const children: ChildProcess[] = [
    spawn(process.execPath, [nextBin, 'start', '-p', String(APP_PORT)], {
      env,
      stdio: 'inherit',
    }),
    spawn(process.execPath, [tsxCli, 'scripts/worker.ts'], {
      env,
      stdio: 'inherit',
    }),
  ]

  let exiting = false
  const shutdown = (code: number) => {
    if (exiting) return
    exiting = true
    for (const c of children) {
      if (c.pid == null) continue
      if (process.platform === 'win32') {
        // Windows：杀整棵进程树，避免遗留端口占用
        spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'])
      } else {
        c.kill('SIGTERM')
      }
    }
    fs.rmSync(fixturesDir, { recursive: true, force: true })
    void handle?.stop().finally(() => process.exit(code))
  }

  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
  for (const c of children) {
    c.on('exit', (code) => {
      if (!exiting) {
        console.error(`[e2e-server] 子进程退出（code=${code}），关闭环境`)
        shutdown(code ?? 1)
      }
    })
  }

  console.log(`[e2e-server] 数据库 ${handle.url}`)
  console.log(`[e2e-server] 存储 ${storageRoot}`)
  console.log(`[e2e-server] 应用 http://127.0.0.1:${APP_PORT}（next start + worker）`)
}

main().catch((err) => {
  console.error('[e2e-server] 启动失败:', err)
  process.exit(1)
})
