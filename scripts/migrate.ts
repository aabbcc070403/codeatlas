import postgres from 'postgres'
import { env } from '../src/server/env'
import { applyMigrations } from '../src/server/db/migrate'

async function main() {
  const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false })
  try {
    const applied = await applyMigrations(sql)
    if (applied.length === 0) {
      console.log('[migrate] 无新迁移（已是最新）')
    } else {
      for (const tag of applied) console.log(`[migrate] 已应用 ${tag}`)
    }
  } finally {
    await sql.end()
  }
}

main().catch((err) => {
  console.error('[migrate] 失败:', err)
  process.exit(1)
})
