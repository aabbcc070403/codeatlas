import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/db'
import { applyMigrations } from '../../src/server/db/migrate'
import { seedAll } from '../../src/server/db/seed'
import { BUILTIN_GUIDELINES } from '../../src/core/knowledge/builtin'

let db: TestDb

beforeAll(async () => {
  db = await createTestDb()
})

afterAll(async () => {
  await db.dispose()
})

describe('T01 数据基础', () => {
  it('迁移幂等：重复应用不产生新记录', async () => {
    const applied = await applyMigrations(db.sql)
    expect(applied).toEqual([])
    // 已应用条数 = journal 条目数（随迁移演进，不硬编码）
    const expected = await import('node:fs').then((fs) => {
      const journal = JSON.parse(
        fs.readFileSync('src/server/db/migrations/meta/_journal.json', 'utf8'),
      ) as { entries: unknown[] }
      return journal.entries.length
    })
    const count = await db.sql`select count(*)::int as c from __drizzle_migrations`
    expect((count[0] as { c: number }).c).toBe(expected)
  })

  it('seed 幂等：重复运行不创建重复规范', async () => {
    await seedAll(db.sql)
    await seedAll(db.sql)
    const rows = await db.sql`select count(*)::int as c from documents where is_builtin = true`
    expect((rows[0] as { c: number }).c).toBe(BUILTIN_GUIDELINES.length)
    const chunks = await db.sql`select count(*)::int as c from chunks`
    expect((chunks[0] as { c: number }).c).toBe(BUILTIN_GUIDELINES.length)
  })

  it('files(snapshotId, path) 唯一约束阻止重复路径', async () => {
    const project = await db.sql`insert into projects (name) values ('t') returning id`
    const projectId = (project[0] as { id: string }).id
    const snapshot = await db.sql`insert into snapshots (project_id, content_hash) values (${projectId}, 'h1') returning id`
    const snapshotId = (snapshot[0] as { id: string }).id
    await db.sql`insert into files (snapshot_id, path, content_hash, storage_key, language) values (${snapshotId}, 'src/a.ts', 'ch', 'k', 'ts')`
    await expect(
      db.sql`insert into files (snapshot_id, path, content_hash, storage_key, language) values (${snapshotId}, 'src/a.ts', 'ch2', 'k2', 'ts')`,
    ).rejects.toThrow(/duplicate key|unique/i)
  })

  it('jobs(kind, targetId) 唯一约束阻止重复任务', async () => {
    const project = await db.sql`insert into projects (name) values ('t2') returning id`
    const projectId = (project[0] as { id: string }).id
    const snapshot = await db.sql`insert into snapshots (project_id, content_hash) values (${projectId}, 'h2') returning id`
    const scan = await db.sql`insert into scans (snapshot_id, idempotency_key, config_json, rule_version, prompt_version) values (${(snapshot[0] as { id: string }).id}, 'k1', '{}'::jsonb, 'v', 'v') returning id`
    const scanId = (scan[0] as { id: string }).id
    await db.sql`insert into jobs (kind, target_id) values ('scan', ${scanId})`
    await expect(
      db.sql`insert into jobs (kind, target_id) values ('scan', ${scanId})`,
    ).rejects.toThrow(/duplicate key|unique/i)
  })

  it('向量列可用：pgvector 余弦距离查询', async () => {
    const result = await db.sql`select '[1,2,3]'::vector <=> '[3,1,2]'::vector as d`
    expect(Number((result[0] as { d: string }).d)).toBeGreaterThan(0)
  })

  it('scans(snapshotId, idempotencyKey) 唯一约束生效', async () => {
    const project = await db.sql`insert into projects (name) values ('t3') returning id`
    const projectId = (project[0] as { id: string }).id
    const snapshot = await db.sql`insert into snapshots (project_id, content_hash) values (${projectId}, 'h3') returning id`
    const snapshotId = (snapshot[0] as { id: string }).id
    await db.sql`insert into scans (snapshot_id, idempotency_key, config_json, rule_version, prompt_version) values (${snapshotId}, 'idem-1', '{}'::jsonb, 'v', 'v')`
    await expect(
      db.sql`insert into scans (snapshot_id, idempotency_key, config_json, rule_version, prompt_version) values (${snapshotId}, 'idem-1', '{}'::jsonb, 'v', 'v')`,
    ).rejects.toThrow(/duplicate key|unique/i)
  })
})
