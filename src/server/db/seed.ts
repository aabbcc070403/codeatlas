import postgres from 'postgres'
import { createHash } from 'node:crypto'
import { BUILTIN_GUIDELINES } from '@/core/knowledge/builtin'

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 幂等 seed：预置规范按 builtinKey + contentHash 去重，
 * 内容变化时版本号 +1 并重建分块（向量在 T06 检索模块按索引版本重建）。
 */
export async function seedBuiltinKnowledge(sql: postgres.Sql): Promise<{
  created: number
  updated: number
  unchanged: number
}> {
  let created = 0
  let updated = 0
  let unchanged = 0

  for (const g of BUILTIN_GUIDELINES) {
    const contentHash = sha256(`${g.title}\n${g.body}\n${g.sourceUrl}`)
    const existing = await sql`select id, content_hash, version from documents where builtin_key = ${g.key}`
    let documentId: string
    if (existing.length > 0) {
      const row = existing[0] as { id: string; content_hash: string; version: number }
      documentId = row.id
      if (row.content_hash === contentHash) {
        const chunkCount = await sql`select count(*)::int as c from chunks where document_id = ${documentId}`
        if ((chunkCount[0] as { c: number }).c > 0) {
          unchanged++
          continue
        }
      } else {
        // 内容更新：版本 +1，重建分块
        await sql`update documents set content_hash = ${contentHash}, version = ${row.version + 1}, title = ${g.title}, category = ${g.category}, source_url = ${g.sourceUrl} where id = ${documentId}`
        await sql`delete from chunks where document_id = ${documentId}`
        updated++
      }
    } else {
      const inserted = await sql`insert into documents (builtin_key, content_hash, source_url, title, category, is_builtin, index_status, version)
        values (${g.key}, ${contentHash}, ${g.sourceUrl}, ${g.title}, ${g.category}, true, 'lexical_only', 1)
        returning id`
      documentId = (inserted[0] as { id: string }).id
      created++
    }
    const lineCount = g.body.split('\n').length
    const chunkHash = sha256(g.body)
    await sql`insert into chunks (document_id, text, heading, start_line, end_line, index_version, content_hash, embedding)
      values (${documentId}, ${g.body}, ${g.title}, 1, ${lineCount}, 1, ${chunkHash}, null)`
  }
  return { created, updated, unchanged }
}

export async function seedAll(sql: postgres.Sql): Promise<void> {
  const result = await seedBuiltinKnowledge(sql)
  console.log(
    `[seed] 预置规范: 新建 ${result.created}，更新 ${result.updated}，未变化 ${result.unchanged}`,
  )
}
