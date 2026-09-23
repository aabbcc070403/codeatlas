import postgres from 'postgres'
import { env } from '../src/server/env'
import { getEmbeddingAdapter } from '../src/core/knowledge/embeddings'
import { embedDocumentChunks } from '../src/worker/document-index'

/**
 * 重建向量索引：清空全部 chunks.embedding 并按当前 AI_EMBEDDING_MODEL 重新嵌入。
 * 用途：更换嵌入模型或维度后（维度/模型不同会混向量，检索按 embedding_model 过滤）。
 * 用法：pnpm reindex（需先 pnpm db:dev 与迁移就绪）
 */
async function main(): Promise<void> {
  const sql = postgres(env.DATABASE_URL, { max: 2, prepare: false })
  try {
    const adapter = getEmbeddingAdapter()
    if (!adapter) {
      console.log('[reindex] 未配置嵌入模型（AI_EMBEDDING_MODEL）：向量路保持关闭（词法检索）')
      return
    }
    console.log(
      `[reindex] 模型=${adapter.model} dim=${adapter.dim} 本地=${adapter.isLocal === true ? '是' : '否'}`,
    )
    await sql`update chunks set embedding = null, embedding_model = null`
    await sql`update documents set index_status = 'lexical_only', index_error = null`
    const docs = (await sql`select id, title from documents order by created_at`) as unknown as Array<{
      id: string
      title: string
    }>
    let total = 0
    for (const d of docs) {
      const r = await embedDocumentChunks(sql, d.id, { adapter })
      total += r.embedded
      console.log(
        `[reindex] ${d.title}: ${r.embedded} 块 → ${r.status}${r.error ? `（${r.error}）` : ''}`,
      )
    }
    console.log(`[reindex] 完成：${total} 块已嵌入，${docs.length} 个文档`)
  } finally {
    await sql.end()
  }
}

main().catch((err) => {
  console.error('[reindex] 失败:', err)
  process.exit(1)
})
