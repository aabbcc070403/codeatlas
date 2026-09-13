import postgres from 'postgres'
import { completeJob, failJob, assertLease, LeaseLostError, type LeaseInfo } from './jobs'
import { getEmbeddingAdapter, embedWithDailyBudget, type EmbeddingAdapter } from '@/core/knowledge/embeddings'

/** 为文档的未嵌入分块生成向量并更新索引状态（供 worker 与 seed 复用） */
export async function embedDocumentChunks(
  sql: postgres.Sql,
  documentId: string,
  opts?: { adapter?: EmbeddingAdapter | null },
): Promise<{ embedded: number; status: 'ready' | 'lexical_only' | 'failed'; error?: string }> {
  const adapter = opts?.adapter !== undefined ? opts.adapter : getEmbeddingAdapter()
  if (!adapter) {
    await sql`update documents set index_status = 'lexical_only', index_error = null where id = ${documentId}`
    return { embedded: 0, status: 'lexical_only' }
  }
  const chunks = (await sql`select id, text from chunks
    where document_id = ${documentId} and embedding is null`) as unknown as Array<{
    id: string
    text: string
  }>
  if (chunks.length === 0) {
    await sql`update documents set index_status = 'ready', index_error = null where id = ${documentId}`
    return { embedded: 0, status: 'ready' }
  }
  try {
    const BATCH = 64
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH)
      // A03：每批先原子预留日额度，额度耗尽即拒绝（不发起付费 embedding）
      const result = await embedWithDailyBudget(sql, batch.map((c) => c.text), { adapter })
      if (result.status === 'daily_budget_exceeded') {
        const message = 'embedding 日额度已耗尽，本轮降级词法索引（次日恢复或提高限额）'
        await sql`update documents set index_status = 'lexical_only', index_error = ${message} where id = ${documentId}`
        return { embedded: 0, status: 'lexical_only', error: message }
      }
      if (result.status === 'unavailable') {
        await sql`update documents set index_status = 'lexical_only', index_error = null where id = ${documentId}`
        return { embedded: 0, status: 'lexical_only' }
      }
      for (let j = 0; j < batch.length; j++) {
        const vec = `[${result.vectors[j]!.join(',')}]`
        await sql`update chunks set embedding = ${vec}::vector, embedding_model = ${result.model}
          where id = ${batch[j]!.id}`
      }
    }
    await sql`update documents set index_status = 'ready', index_error = null where id = ${documentId}`
    return { embedded: chunks.length, status: 'ready' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await sql`update documents set index_status = 'lexical_only', index_error = ${message.slice(0, 300)} where id = ${documentId}`
    return { embedded: 0, status: 'lexical_only', error: message }
  }
}

/** document_index 任务：嵌入文档分块；长批处理期间确认租约，失租即停止 */
export async function processDocumentIndexJob(
  sql: postgres.Sql,
  opts: { documentId: string; job: LeaseInfo },
): Promise<void> {
  const { documentId, job } = opts
  const rows = await sql`select id from documents where id = ${documentId}`
  if (rows.length === 0) {
    await completeJob(sql, job)
    return
  }
  const result = await embedDocumentChunks(sql, documentId)
  // 批处理后确认租约：失租的写入不落最终状态，交由接管方重跑（嵌入幂等）
  if (!(await assertLease(sql, job))) {
    throw new LeaseLostError()
  }
  if (result.status === 'failed') {
    await failJob(
      sql,
      { ...job, kind: 'document_index', target_id: documentId },
      result.error ?? 'embedding 失败',
    )
    return
  }
  await completeJob(sql, job)
}
