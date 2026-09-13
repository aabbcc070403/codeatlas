import postgres from 'postgres'
import { env } from '../src/server/env'
import { seedAll } from '../src/server/db/seed'

async function main() {
  const sql = postgres(env.DATABASE_URL, { max: 1, prepare: false })
  try {
    await seedAll(sql)
  } finally {
    await sql.end()
  }
}

main().catch((err) => {
  console.error('[seed] 失败:', err)
  process.exit(1)
})
