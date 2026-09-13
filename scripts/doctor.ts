import postgres from 'postgres'
import fs from 'node:fs'
import path from 'node:path'
import { env, aiProviderStatus } from '../src/server/env'
import { migrationFileCount } from '../src/server/db/migrate'

/**
 * 启动自检：数据库、pgvector、迁移、存储、AI 配置。
 * 不输出任何密钥值。退出码非 0 表示存在阻断性问题。
 */
async function main() {
  let failed = false

  // 1. 配置概览
  const ai = aiProviderStatus()
  console.log('== CodeAtlas doctor ==')
  console.log(`AI provider: ${ai.provider}${ai.provider === 'mock' ? '（Mock，未接入真实模型）' : ''}`)
  if (ai.provider === 'openai') {
    if (ai.ready) {
      console.log(`chat model: ${ai.chatModel}`)
      console.log(`embedding model: ${ai.embeddingModel ?? '(未配置，检索将降级为词法)'} (dim=${env.EMBEDDING_DIM})`)
    } else {
      console.log(`AI 配置缺失: ${ai.missing.join(', ')}（真实调用不可用）`)
    }
  }
  console.log(`日 token 预算: ${env.AI_DAILY_TOKEN_LIMIT}`)
  console.log(`数据 TTL: ${env.DATA_TTL_HOURS} 小时`)

  // 2. 数据库
  const sql = postgres(env.DATABASE_URL, { max: 1, connect_timeout: 5, prepare: false })
  try {
    const versionRows = await sql`select version() as v`
    console.log(`数据库: ${(versionRows[0] as { v: string }).v.split(',')[0]}`)
    const ext = await sql`select extname from pg_extension where extname = 'vector'`
    if (ext.length > 0) {
      console.log('pgvector: 已启用')
    } else {
      console.log('pgvector: 未启用（向量检索不可用）')
      failed = true
    }
    const applied = await sql`select count(*)::int as c from __drizzle_migrations`
    const appliedCount = (applied[0] as { c: number }).c
    const expected = migrationFileCount()
    console.log(`迁移: 已应用 ${appliedCount}/${expected}`)
    if (appliedCount < expected) {
      console.log('  → 存在未应用迁移，请运行 pnpm db:migrate')
      failed = true
    }
    const docs = await sql`select count(*)::int as c from documents where is_builtin = true`
    console.log(`预置规范: ${(docs[0] as { c: number }).c} 条（预期见 src/core/knowledge/builtin.ts）`)
  } catch (err) {
    console.error(`数据库连接失败: ${err instanceof Error ? err.message : err}`)
    console.error('请确认已启动: pnpm db:dev')
    failed = true
  } finally {
    try {
      await sql.end()
    } catch {
      /* 连接失败时 end 可能抛错，忽略 */
    }
  }

  // 3. 存储目录可写
  try {
    const root = env.storageRoot
    fs.mkdirSync(root, { recursive: true })
    const probe = path.join(root, '.doctor-probe')
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe)
    console.log(`存储目录可写: ${root}`)
  } catch (err) {
    console.error(`存储目录不可写: ${err instanceof Error ? err.message : err}`)
    failed = true
  }

  if (failed) {
    console.log('doctor 结果: 存在问题（见上）')
    process.exit(1)
  }
  console.log('doctor 结果: 通过')
}

main()
