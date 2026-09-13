import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb, type TestDb } from '../helpers/db'
import { embedDocumentChunks } from '../../src/worker/document-index'
import { embedWithDailyBudget, type EmbeddingAdapter } from '../../src/core/knowledge/embeddings'
import { Budget } from '../../src/core/review/budget'

/**
 * A03 embedding 日额度：付费 embedding 先原子预留再调用；额度耗尽直接拒绝
 * （不发起付费请求）；成功按实测/估算结算；失败释放预留。
 * 全部使用注入的受控 adapter，不调用真实 embedding。
 */

let db: TestDb
let docId: string
let docIdEmpty: string

function fakeAdapter(behavior?: { usageTokens?: number | null; fail?: boolean }): EmbeddingAdapter {
  // 1536 维：与 chunks.embedding 列类型 vector(1536) 一致
  const vec = Array.from({ length: 1536 }, (_, i) => (i % 2 === 0 ? 0.1 : 0.2))
  return {
    model: 'fake-embed',
    dim: 1536,
    embed: async (texts: string[]) => {
      if (behavior?.fail) throw new Error('embedding failed')
      return {
        vectors: texts.map(() => vec),
        model: 'fake-embed',
        dim: 1536,
        usageTokens: behavior?.usageTokens !== undefined ? behavior.usageTokens : null,
      }
    },
  }
}

async function createDocWithChunks(texts: string[]): Promise<string> {
  const proj = (await db.sql`insert into projects (name) values ('嵌入额度测试') returning id`)[0] as unknown as { id: string }
  const doc = (await db.sql`insert into documents (project_id, version, content_hash, title, category, is_builtin, index_status)
    values (${proj.id}, 1, ${'hash-' + Math.random().toString(36).slice(2, 8)}, '测试规范', 'maintainability', false, 'pending')
    returning id`)[0] as unknown as { id: string }
  for (const [i, text] of texts.entries()) {
    await db.sql`insert into chunks (document_id, text, heading, start_line, end_line, index_version, content_hash)
      values (${doc.id}, ${text}, 'h', ${i + 1}, ${i + 1}, 1, ${'ch-' + i})`
  }
  return doc.id
}

async function todayUsage(): Promise<{
  input_tokens: number
  output_tokens: number
  reserved_tokens: number
  requests: number
}> {
  const rows = (await db.sql`select input_tokens, output_tokens, reserved_tokens, requests from daily_usage
    where day = to_char(now() at time zone 'UTC', 'YYYY-MM-DD')`) as unknown as Array<{
    input_tokens: number
    output_tokens: number
    reserved_tokens: number
    requests: number
  }>
  return rows[0] ?? { input_tokens: 0, output_tokens: 0, reserved_tokens: 0, requests: 0 }
}

beforeAll(async () => {
  db = await createTestDb()
  process.env.DATABASE_URL = db.url
  docId = await createDocWithChunks(['aaaa', 'bbbb'])
  docIdEmpty = await createDocWithChunks([])
})

afterAll(async () => {
  await db.dispose()
})

describe('A03 embedding 日额度', () => {
  it('额度充足：嵌入成功并结算（无实测时按保守估算，不按零计费）', async () => {
    await db.sql`delete from daily_usage`
    const result = await embedDocumentChunks(db.sql, docId, { adapter: fakeAdapter() })
    expect(result.status).toBe('ready')
    expect(result.embedded).toBe(2)
    const usage = await todayUsage()
    expect(usage.reserved_tokens).toBe(0) // 预留已结算释放
    expect(usage.requests).toBe(1)
    expect(usage.input_tokens).toBe(Budget.estimate('aaaa\nbbbb')) // 未知消耗回退估算
    // 向量与模型落库
    const chunks = (await db.sql`select embedding is not null as has_vec, embedding_model from chunks where document_id = ${docId}`) as unknown as Array<{ has_vec: boolean; embedding_model: string }>
    expect(chunks.every((c) => c.has_vec && c.embedding_model === 'fake-embed')).toBe(true)
    await db.sql`delete from daily_usage`
  })

  it('实测优先：adapter 返回 usage 时按实测结算', async () => {
    await db.sql`delete from daily_usage`
    const result = await embedWithDailyBudget(db.sql, ['hello world'], {
      adapter: fakeAdapter({ usageTokens: 7 }),
    })
    expect(result.status).toBe('ok')
    const usage = await todayUsage()
    expect(usage.input_tokens).toBe(7)
    expect(usage.reserved_tokens).toBe(0)
    await db.sql`delete from daily_usage`
  })

  it('日额度耗尽：拒绝嵌入（不发起付费请求），文档降级 lexical_only', async () => {
    await db.sql`delete from daily_usage`
    await db.sql`insert into daily_usage (day, input_tokens) values (to_char(now() at time zone 'UTC', 'YYYY-MM-DD'), 300000)`
    let called = 0
    const adapter: EmbeddingAdapter = {
      model: 'fake-embed',
      dim: 1536,
      embed: async (texts: string[]) => {
        called++
        return {
          vectors: texts.map(() => Array.from({ length: 1536 }, (_, i) => (i % 2 === 0 ? 0.1 : 0.2))),
          model: 'fake-embed',
          dim: 1536,
          usageTokens: null,
        }
      },
    }
    const doc2 = await createDocWithChunks(['cccc'])
    const result = await embedDocumentChunks(db.sql, doc2, { adapter })
    expect(result.status).toBe('lexical_only')
    expect(result.error).toContain('日额度')
    expect(called).toBe(0) // 未发起付费 embedding
    const chunks = (await db.sql`select embedding is null as no_vec from chunks where document_id = ${doc2}`) as unknown as Array<{ no_vec: boolean }>
    expect(chunks.every((c) => c.no_vec)).toBe(true)
    const usage = await todayUsage()
    expect(usage.input_tokens).toBe(300000) // 未新增记账
    expect(usage.requests).toBe(0)
    await db.sql`delete from daily_usage`
  })

  it('嵌入失败：释放预留（不记账、不计数）', async () => {
    await db.sql`delete from daily_usage`
    const doc3 = await createDocWithChunks(['dddd'])
    const result = await embedDocumentChunks(db.sql, doc3, {
      adapter: fakeAdapter({ fail: true }),
    })
    expect(result.status).toBe('lexical_only')
    expect(result.error).toContain('embedding failed')
    const usage = await todayUsage()
    expect(usage).toEqual({ input_tokens: 0, output_tokens: 0, reserved_tokens: 0, requests: 0 })
    await db.sql`delete from daily_usage`
  })

  it('无待嵌入分块：不消耗日额度', async () => {
    await db.sql`delete from daily_usage`
    const result = await embedDocumentChunks(db.sql, docIdEmpty, { adapter: fakeAdapter() })
    expect(result.status).toBe('ready')
    const rows = (await db.sql`select count(*)::int as c from daily_usage`) as unknown as Array<{ c: number }>
    expect(rows[0]!.c).toBe(0)
  })
})
