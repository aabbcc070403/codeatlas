import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/db'
import { seedAll } from '../../src/server/db/seed'
import { retrieveGuidelines } from '../../src/core/knowledge/retrieval'
import { chunkMarkdown } from '../../src/core/knowledge/chunk'

let db: TestDb

beforeAll(async () => {
  db = await createTestDb()
  process.env.DATABASE_URL = db.url
  await seedAll(db.sql)
})

afterAll(async () => {
  await db.dispose()
})

describe('T06 规范知识库与混合检索', () => {
  it('固定查询命中人工预期规范（词法模式）', async () => {
    const r = await retrieveGuidelines(db.sql, { query: 'innerHTML 注入 XSS 转义防护' })
    expect(r.mode).toBe('lexical_only')
    expect(r.chunks.length).toBeGreaterThan(0)
    expect(
      r.chunks.slice(0, 2).some((c) => c.title.includes('innerHTML') || c.title.includes('XSS')),
    ).toBe(true)

    const r2 = await retrieveGuidelines(db.sql, { query: 'React 列表渲染缺少 key' })
    expect(
      r2.chunks.some((c) => c.title.includes('列表') || c.title.includes('key')),
    ).toBe(true)

    const r3 = await retrieveGuidelines(db.sql, { query: 'postMessage targetOrigin 消息来源' })
    expect(r3.chunks.some((c) => c.title.includes('postMessage'))).toBe(true)
  })

  it('无命中时不编造规范', async () => {
    const r = await retrieveGuidelines(db.sql, { query: '量子纠缠薛定谔猫态' })
    expect(r.chunks.length).toBe(0)
  })

  it('项目规范纳入检索范围且跨项目隔离', async () => {
    // 建两个项目，各导入一份规范
    const projA = (await db.sql`insert into projects (name) values ('项目A') returning id`)[0] as unknown as { id: string }
    const projB = (await db.sql`insert into projects (name) values ('项目B') returning id`)[0] as unknown as { id: string }
    for (const [proj, keyword] of [
      [projA.id, '团队内部要求所有接口必须走 HTTPS'],
      [projB.id, '团队内部要求所有图标必须使用图标库'],
    ] as Array<[string, string]>) {
      const md = `# 项目规范\n\n${keyword}\n\n补充说明：本规范适用于本项目全部代码。`
      const chunks = chunkMarkdown(md)
      const doc = (await db.sql`insert into documents (project_id, version, content_hash, title, category, is_builtin, index_status)
        values (${proj}, 1, ${'hash-' + proj}, '项目规范', 'maintainability', false, 'lexical_only') returning id`)[0] as unknown as { id: string }
      for (const c of chunks) {
        await db.sql`insert into chunks (document_id, text, heading, start_line, end_line, index_version, content_hash)
          values (${doc.id}, ${c.text}, ${c.heading}, ${c.startLine}, ${c.endLine}, 1, ${c.contentHash})`
      }
    }

    const rA = await retrieveGuidelines(db.sql, {
      query: '接口必须走 HTTPS 传输',
      projectId: projA.id,
    })
    expect(rA.chunks.some((c) => c.text.includes('HTTPS'))).toBe(true)

    // 项目 B 的规范不在 A 的检索范围
    const rB = await retrieveGuidelines(db.sql, {
      query: '图标必须使用图标库',
      projectId: projA.id,
    })
    expect(rB.chunks.some((c) => c.text.includes('图标'))).toBe(false)
  })

  it('向量路径：注入查询嵌入 → 混合模式 + RRF 融合', async () => {
    // 构造 1536 维正交单位向量：e1 命中目标块，e2 命中无关块
    const DIM = 1536
    const e1 = Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0))
    const e2 = Array.from({ length: DIM }, (_, i) => (i === 1 ? 1 : 0))

    // 给预置规范中两块写入手工向量（模拟已嵌入）
    const twoChunks = (await db.sql`select c.id from chunks c
      join documents d on d.id = c.document_id
      where d.builtin_key in ('SEC-002', 'PRF-001') limit 2`) as unknown as Array<{ id: string }>
    expect(twoChunks.length).toBe(2)
    await db.sql`update chunks set embedding = ${`[${e1.join(',')}]`}::vector, embedding_model = 'test-manual'
      where id = ${twoChunks[0]!.id}`
    await db.sql`update chunks set embedding = ${`[${e2.join(',')}]`}::vector, embedding_model = 'test-manual'
      where id = ${twoChunks[1]!.id}`

    const r = await retrieveGuidelines(db.sql, {
      query: 'XSS 防护转义',
      embedQuery: async () => e1,
    })
    expect(r.mode).toBe('hybrid')
    expect(r.chunks.some((c) => c.chunkId === twoChunks[0]!.id)).toBe(true)
    const target = r.chunks.find((c) => c.chunkId === twoChunks[0]!.id)!
    // 目标块同时被词法命中（XSS 转义查询 vs SEC-002 XSS 防护规范）→ via 双路
    expect(target.via).toContain('vector')
  })

  it('嵌入失败 → 降级词法并标记', async () => {
    const r = await retrieveGuidelines(db.sql, {
      query: 'XSS 防护',
      embedQuery: async () => {
        throw new Error('embedding timeout')
      },
    })
    expect(r.mode).toBe('lexical_only')
    expect(r.note).toContain('词法')
  })
})
