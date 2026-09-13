import postgres from 'postgres'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'src/server/db/migrations')

interface JournalEntry {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}

/**
 * 应用 drizzle-kit 生成的迁移。幂等：按内容哈希记录已应用迁移。
 * 整体在单个事务 + advisory 锁内执行，防止并发迁移。
 */
export async function applyMigrations(sql: postgres.Sql): Promise<string[]> {
  const journalPath = path.join(MIGRATIONS_DIR, 'meta', '_journal.json')
  if (!fs.existsSync(journalPath)) {
    throw new Error(`迁移目录不存在: ${MIGRATIONS_DIR}（先运行 pnpm db:generate）`)
  }
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
    entries: JournalEntry[]
  }

  await sql`create table if not exists __drizzle_migrations (
    id serial primary key,
    hash text not null unique,
    created_at bigint not null
  )`

  const applied: string[] = []
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(715239)`
    // pgvector 扩展：PGlite 已内置加载；Docker 部署使用 pgvector 镜像
    await tx`create extension if not exists vector`
    for (const entry of journal.entries) {
      const file = path.join(MIGRATIONS_DIR, `${entry.tag}.sql`)
      if (!fs.existsSync(file)) {
        throw new Error(`迁移文件缺失: ${entry.tag}.sql`)
      }
      const content = fs.readFileSync(file, 'utf8')
      const hash = createHash('sha256').update(content).digest('hex')
      const existing = await tx`select id from __drizzle_migrations where hash = ${hash}`
      if (existing.length > 0) continue
      const statements = content
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean)
      for (const stmt of statements) {
        await tx.unsafe(stmt)
      }
      await tx`insert into __drizzle_migrations (hash, created_at) values (${hash}, ${Date.now()})`
      applied.push(entry.tag)
    }
  })
  return applied
}

export function migrationFileCount(): number {
  const journalPath = path.join(MIGRATIONS_DIR, 'meta', '_journal.json')
  if (!fs.existsSync(journalPath)) return 0
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
    entries: JournalEntry[]
  }
  return journal.entries.length
}
