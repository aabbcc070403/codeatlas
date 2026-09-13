import { type NextRequest } from 'next/server'
import { getDb } from '@/server/db/client'
import { assertUuid, requireSession } from '@/server/auth/guard'
import { jsonOk, toErrorResponse, HttpError } from '@/server/api/http'

export const runtime = 'nodejs'

/** 评测详情（规格 11）：配置与实际指标；已登录会话可读（评测素材只读公开） */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const sql = getDb()
    await requireSession(sql, req)
    assertUuid(id, '评测记录')
    const rows = (await sql`
      select id, dataset_version as "datasetVersion", config_json as "configJson", status,
        metrics_json as "metricsJson", error_text as "errorText",
        created_at as "createdAt", completed_at as "completedAt"
      from evaluations where id = ${id}`) as unknown as Array<{
      id: string
      datasetVersion: string
      configJson: unknown
      status: string
      metricsJson: unknown
      errorText: string | null
      createdAt: string
      completedAt: string | null
    }>
    if (rows.length === 0) {
      throw new HttpError(404, 'not_found', '评测记录不存在')
    }
    return jsonOk({ evaluation: rows[0] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
