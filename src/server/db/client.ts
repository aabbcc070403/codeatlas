import postgres from 'postgres'
import { env } from '../env'

let cached: postgres.Sql | null = null

/** 共享数据库连接（web 进程）。worker 与测试请自建连接以控制生命周期。 */
export function getDb(): postgres.Sql {
  if (!cached) {
    // process.env 优先，便于集成测试注入测试库
    cached = postgres(process.env.DATABASE_URL ?? env.DATABASE_URL, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
    })
  }
  return cached
}

/** 用于测试：重置共享连接 */
export async function resetDb(): Promise<void> {
  if (cached) {
    await cached.end()
    cached = null
  }
}
