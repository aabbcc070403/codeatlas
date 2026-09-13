import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import postgres from 'postgres'
import type { DbServerHandle } from '../../scripts/db-server'
import { applyMigrations } from '../../src/server/db/migrate'

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect({ host: '127.0.0.1', port })
    probe.once('connect', () => {
      probe.destroy()
      resolve(false)
    })
    probe.once('error', () => resolve(true))
  })
}

export interface TestDb {
  sql: postgres.Sql
  /** 应用侧连接串（测试把它写入 process.env.DATABASE_URL，使被测代码连到本测试库） */
  url: string
  /** PGlite socket 服务句柄；PostgreSQL 直连路径没有本地服务，为 null */
  handle: DbServerHandle | null
  dispose: () => Promise<void>
}

/** 输出测试库真实身份（驱动 + 服务器版本 + 库名），不打印连接串/密码等秘密 */
async function logServerIdentity(sql: postgres.Sql, driver: string, dbName: string): Promise<void> {
  const rows = (await sql`select version() as v`) as unknown as Array<{ v: string }>
  console.info(`[test-db] driver=${driver} server=${rows[0]!.v.split(',')[0]} db=${dbName}`)
}

/**
 * 解析并校验 INTEGRATION_DATABASE_URL（A07）。
 * 仅接受 postgres 协议，且目标库名必须含 "test"——防止把集成测试指到业务库。
 * 报错信息不回显原始 URL（其中可能带密码）。
 */
function parseIntegrationUrl(raw: string): { url: URL; dbName: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('INTEGRATION_DATABASE_URL 不是合法的 URL（值不予回显，避免泄漏秘密）')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`INTEGRATION_DATABASE_URL 协议必须为 postgres://（当前为 ${url.protocol}）`)
  }
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!dbName) {
    throw new Error('INTEGRATION_DATABASE_URL 缺少数据库名（例如 .../codeatlas_test）')
  }
  if (!/test/i.test(dbName)) {
    throw new Error(
      `集成测试拒绝在疑似非测试库上运行：目标库 "${dbName}" 的名称不含 "test"。` +
        '请提供一个专用于测试的数据库（如 codeatlas_test）。' +
        '测试只会在同一服务器上创建并删除 <库名>_it_<pid>_<随机> 的独立临时库，不会读写所指向库的数据',
    )
  }
  return { url, dbName }
}

/**
 * PostgreSQL 直连路径（A07）：INTEGRATION_DATABASE_URL 指向一台测试专用的
 * PostgreSQL（pgvector 扩展可用，账号需有 CREATEDB 权限；库名须含 "test"）。
 * 每个测试文件在该服务器上创建独立临时库（应用迁移，结束时 DROP），所指库
 * 自身与业务库的数据全程不被读写；此路径完全不加载 PGlite。
 */
async function createPostgresTestDb(raw: string): Promise<TestDb> {
  const { url, dbName } = parseIntegrationUrl(raw)
  const admin = postgres(url.toString(), { max: 1, prepare: false, connect_timeout: 5 })
  // 临时库名：仅 [a-z0-9_]，总长度远低于 PG 63 字节标识符上限
  const base = dbName.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40) || 'codeatlas'
  const safeBase = /^[a-z_]/.test(base) ? base : `_${base}`
  const testDbName = `${safeBase}_it_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
  await admin.unsafe(`create database "${testDbName}"`)
  const testUrl = new URL(url.toString())
  testUrl.pathname = `/${testDbName}`
  const sql = postgres(testUrl.toString(), { max: 4, prepare: false })
  try {
    await logServerIdentity(sql, 'postgres.js', testDbName)
    await applyMigrations(sql)
  } catch (err) {
    try {
      await sql.end()
    } catch {
      /* ignore */
    }
    try {
      await admin.unsafe(`drop database if exists "${testDbName}" with (force)`)
    } catch {
      /* ignore */
    }
    await admin.end()
    throw err
  }
  return {
    sql,
    url: testUrl.toString(),
    handle: null,
    dispose: async () => {
      await sql.end()
      try {
        await admin.unsafe(`drop database if exists "${testDbName}" with (force)`)
      } finally {
        await admin.end()
      }
    },
  }
}

/**
 * 每个测试文件独立测试库（迁移已应用）：
 * - 默认：临时目录 + 随机端口的 PGlite socket 服务（不触碰开发 .data）；
 * - 显式设置 INTEGRATION_DATABASE_URL：直连真实 PostgreSQL（见 createPostgresTestDb）。
 */
export async function createTestDb(): Promise<TestDb> {
  const integrationUrl = process.env.INTEGRATION_DATABASE_URL?.trim()
  if (integrationUrl) return createPostgresTestDb(integrationUrl)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-test-'))
  let handle: DbServerHandle | null = null
  for (let i = 0; i < 10 && !handle; i++) {
    const port = 25000 + Math.floor(Math.random() * 20000)
    if (!(await isPortFree(port))) continue
    try {
      // 动态导入：PostgreSQL 直连路径不加载 PGlite 及其 socket 服务
      const { startDbServer } = await import('../../scripts/db-server')
      handle = await startDbServer({ dataDir: dir, port, maxConnections: 8 })
    } catch {
      // 端口竞争，重试
    }
  }
  if (!handle) throw new Error('无法为测试分配数据库端口')
  const sql = postgres(handle.url, { max: 4, prepare: false })
  await logServerIdentity(sql, 'pglite-socket', 'codeatlas')
  await applyMigrations(sql)
  return {
    sql,
    url: handle.url,
    handle,
    dispose: async () => {
      await sql.end()
      await handle!.stop()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}
