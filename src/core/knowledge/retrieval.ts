import postgres from 'postgres'
import { lexicalTopN } from './lexical'
import { embedWithDailyBudget, getEmbeddingAdapter } from './embeddings'

/**
 * 规范混合检索（规格 9.4）：pgvector 余弦 Top10 + 字符二元组词法 Top10，
 * RRF（k=60）融合取前 5。候选限定为预置规范 + 当前项目规范。
 */

export interface RetrievedChunk {
  chunkId: string
  documentId: string
  title: string
  heading: string
  text: string
  startLine: number
  endLine: number
  sourceUrl: string | null
  version: number
  via: Array<'vector' | 'lexical'>
  rrfScore: number
}

export interface RetrievalResult {
  chunks: RetrievedChunk[]
  mode: 'hybrid' | 'lexical_only'
  note: string
}

const RRF_K = 60
const CANDIDATE_LIMIT = 10
const TOP_K = 5

export async function retrieveGuidelines(
  sql: postgres.Sql,
  opts: {
    query: string
    projectId?: string | null
    topK?: number
    /** 测试注入的查询嵌入（生产走 getEmbeddingAdapter） */
    embedQuery?: (text: string) => Promise<number[] | null>
  },
): Promise<RetrievalResult> {
  const topK = Math.min(8, opts.topK ?? TOP_K)
  // 候选文档：预置 + 当前项目（会话隔离由调用方保证 projectId 归属）
  const candidates = (await sql`
    select c.id, c.document_id, c.text, c.heading, c.start_line, c.end_line,
      d.title, d.source_url, d.version,
      case when c.embedding is null then 0 else 1 end as has_embedding
    from chunks c
    join documents d on d.id = c.document_id
    where d.is_builtin = true
      ${opts.projectId ? sql`or d.project_id = ${opts.projectId}` : sql``}
  `) as unknown as Array<{
    id: string
    document_id: string
    text: string
    heading: string
    start_line: number
    end_line: number
    title: string
    source_url: string | null
    version: number
    has_embedding: number
  }>

  if (candidates.length === 0) {
    return {
      chunks: [],
      mode: 'lexical_only',
      note: '知识库为空',
    }
  }

  // 词法 Top10
  const lexicalMatches = lexicalTopN(
    opts.query,
    candidates.map((c) => ({ id: c.id, text: `${c.title} ${c.heading} ${c.text}` })),
    CANDIDATE_LIMIT,
  )

  // 向量 Top10（真实 embedding 可用且存在已嵌入块时）
  let vectorMatches: Array<{ id: string }> = []
  let mode: 'hybrid' | 'lexical_only' = 'lexical_only'
  const adapter = getEmbeddingAdapter()
  // A03：默认查询嵌入走日额度包装（先预留再调用，额度耗尽不发起付费请求）；
  // 测试注入的 embedQuery 不经过日额度（受控路径）
  const embedQuery =
    opts.embedQuery ??
    (adapter
      ? (text: string) =>
          embedWithDailyBudget(sql, [text], { adapter }).then((r) =>
            r.status === 'ok' ? (r.vectors[0] ?? null) : null,
          )
      : undefined)
  if (embedQuery && candidates.some((c) => c.has_embedding === 1)) {
    try {
      const queryVec = await embedQuery(opts.query)
      if (queryVec && queryVec.length > 0) {
        const vecLiteral = `[${queryVec.join(',')}]`
        // 一致性筛选（R04）：只用与当前查询模型一致的向量，不同模型/维度的
        // 旧向量不参与余弦比较（避免语义空间混用）
        const embeddingModel = adapter?.model ?? null
        const rows = (await sql`
          select c.id, 1 - (c.embedding <=> ${vecLiteral}::vector) as score
          from chunks c
          join documents d on d.id = c.document_id
          where c.embedding is not null
            ${embeddingModel ? sql`and c.embedding_model = ${embeddingModel}` : sql``}
            and (d.is_builtin = true ${opts.projectId ? sql`or d.project_id = ${opts.projectId}` : sql``})
          order by c.embedding <=> ${vecLiteral}::vector
          limit ${CANDIDATE_LIMIT}
        `) as unknown as Array<{ id: string }>
        vectorMatches = rows
        mode = 'hybrid'
      }
    } catch (err) {
      // 嵌入超时/失败：降级词法，不编造结果
      console.warn('[retrieval] 向量检索失败，降级词法:', err instanceof Error ? err.message : err)
      mode = 'lexical_only'
    }
  }

  // RRF 融合
  const rrf = new Map<string, { score: number; via: Set<'vector' | 'lexical'> }>()
  for (const [rank, m] of lexicalMatches.entries()) {
    const entry = rrf.get(m.id) ?? { score: 0, via: new Set<'vector' | 'lexical'>() }
    entry.score += 1 / (RRF_K + rank + 1)
    entry.via.add('lexical')
    rrf.set(m.id, entry)
  }
  for (const [rank, m] of vectorMatches.entries()) {
    const entry = rrf.get(m.id) ?? { score: 0, via: new Set<'vector' | 'lexical'>() }
    entry.score += 1 / (RRF_K + rank + 1)
    entry.via.add('vector')
    rrf.set(m.id, entry)
  }

  const byId = new Map(candidates.map((c) => [c.id, c]))
  const chunks: RetrievedChunk[] = [...rrf.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, topK)
    .map(([chunkId, info]) => {
      const c = byId.get(chunkId)!
      return {
        chunkId,
        documentId: c.document_id,
        title: c.title,
        heading: c.heading,
        text: c.text,
        startLine: c.start_line,
        endLine: c.end_line,
        sourceUrl: c.source_url,
        version: c.version,
        via: [...info.via],
        rrfScore: Number(info.score.toFixed(6)),
      }
    })

  return {
    chunks,
    mode,
    note:
      mode === 'hybrid'
        ? '向量（pgvector 余弦）+ 词法（字符二元组）两路检索，RRF k=60 融合'
        : '嵌入不可用，仅词法（字符二元组）检索',
  }
}
