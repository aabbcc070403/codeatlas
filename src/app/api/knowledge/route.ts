import { type NextRequest } from 'next/server'
import { getDb } from '@/server/db/client'
import { jsonOk, toErrorResponse } from '@/server/api/http'
import { requireSession, requireReadableProject } from '@/server/auth/guard'
import { retrieveGuidelines } from '@/core/knowledge/retrieval'

export const runtime = 'nodejs'

/** 可访问规范与索引状态（预置 + 指定项目）；q 参数触发检索测试 */
export async function GET(req: NextRequest) {
  try {
    const sql = getDb()
    const session = await requireSession(sql, req)
    const url = new URL(req.url)
    const projectId = url.searchParams.get('projectId')
    const q = url.searchParams.get('q')

    let project: { id: string; name: string } | null = null
    if (projectId) {
      const row = await requireReadableProject(sql, session, projectId)
      project = { id: row.id, name: row.name }
    }

    const builtin = await sql`
      select d.id, d.builtin_key, d.title, d.category, d.version, d.source_url, d.index_status,
        (select count(*)::int from chunks c where c.document_id = d.id) as chunk_count
      from documents d where d.is_builtin = true order by d.builtin_key asc`
    const projectDocs = project
      ? await sql`
          select d.id, d.title, d.version, d.index_status, d.index_error, d.created_at,
            (select count(*)::int from chunks c where c.document_id = d.id) as chunk_count
          from documents d where d.project_id = ${project.id} order by d.created_at desc`
      : []

    let search: Awaited<ReturnType<typeof retrieveGuidelines>> | null = null
    if (q && q.trim().length > 0) {
      search = await retrieveGuidelines(sql, {
        query: q.trim(),
        projectId: project?.id ?? null,
      })
    }

    return jsonOk({
      builtin,
      project,
      projectDocs,
      search,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
