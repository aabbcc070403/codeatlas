import { type NextRequest } from 'next/server'
import { createHash } from 'node:crypto'
import { getDb } from '@/server/db/client'
import { assertSameOrigin, jsonError, jsonOk, toErrorResponse } from '@/server/api/http'
import { requireOwnedProject, requireSession } from '@/server/auth/guard'
import { chunkMarkdown } from '@/core/knowledge/chunk'
import { getEmbeddingAdapter } from '@/core/knowledge/embeddings'

type Params = { params: Promise<{ id: string }> }

export const runtime = 'nodejs'

const MAX_FILES_PER_PROJECT = 10
const MAX_TOTAL_BYTES = 1024 * 1024 // 1MiB

export async function POST(req: NextRequest, { params }: Params) {
  try {
    assertSameOrigin(req)
    const { id } = await params
    const sql = getDb()
    const session = await requireSession(sql, req)
    const project = await requireOwnedProject(sql, session, id)

    const contentType = req.headers.get('content-type') ?? ''
    if (!contentType.includes('multipart/form-data')) {
      return jsonError(415, 'unsupported_media_type', '请使用 multipart/form-data 上传 Markdown')
    }
    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return jsonError(400, 'invalid_request', '缺少 file 字段')
    }
    if (!/\.(md|markdown)$/i.test(file.name)) {
      return jsonError(415, 'unsupported_media_type', '仅支持 .md / .markdown 文件')
    }
    const content = await file.text()

    // 项目规范限额：最多 10 个文件、总计 1MiB
    const stats = (await sql`select count(*)::int as files,
      coalesce(sum(octet_length(c.text)), 0)::bigint as total_bytes
      from documents d join chunks c on c.document_id = d.id
      where d.project_id = ${project.id}`)[0] as unknown as {
      files: number
      total_bytes: string | number
    }
    if (stats.files >= MAX_FILES_PER_PROJECT) {
      return jsonError(413, 'payload_too_large', `项目规范最多 ${MAX_FILES_PER_PROJECT} 个文件`)
    }
    if (Number(stats.total_bytes) + Buffer.byteLength(content, 'utf8') > MAX_TOTAL_BYTES) {
      return jsonError(413, 'payload_too_large', '项目规范总量超过 1MiB 限制')
    }

    // 标题：首个一级标题或文件名
    const titleMatch = content.match(/^#\s+(.+)$/m)
    const title = (titleMatch?.[1] ?? file.name.replace(/\.(md|markdown)$/i, '')).slice(0, 120)

    const chunks = chunkMarkdown(content)
    if (chunks.length === 0) {
      return jsonError(422, 'invalid_request', '文档内容为空，无法建立索引')
    }
    const contentHash = createHash('sha256').update(content).digest('hex')
    const adapter = getEmbeddingAdapter()

    const documentId = await sql.begin(async (tx) => {
      const inserted = await tx`insert into documents
        (project_id, version, content_hash, title, category, is_builtin, index_status)
        values (${project.id}, 1, ${contentHash}, ${title}, 'maintainability', false,
          ${adapter ? 'pending' : 'lexical_only'})
        returning id`
      const docId = (inserted[0] as { id: string }).id
      for (const chunk of chunks) {
        await tx`insert into chunks (document_id, text, heading, start_line, end_line, index_version, content_hash)
          values (${docId}, ${chunk.text}, ${chunk.heading}, ${chunk.startLine}, ${chunk.endLine}, 1, ${chunk.contentHash})`
      }
      if (adapter) {
        await tx`insert into jobs (kind, target_id) values ('document_index', ${docId})
          on conflict (kind, target_id) do nothing`
      }
      return docId
    })

    return jsonOk(
      {
        document: {
          id: documentId,
          title,
          chunkCount: chunks.length,
          indexStatus: adapter ? 'pending' : 'lexical_only',
          embeddingModel: adapter?.model ?? null,
        },
      },
      201,
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}
