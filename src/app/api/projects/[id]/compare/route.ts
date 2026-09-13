import { type NextRequest } from 'next/server'
import { getDb } from '@/server/db/client'
import { jsonError, jsonOk, HttpError, toErrorResponse } from '@/server/api/http'
import { assertUuid, requireReadableProject, requireSession } from '@/server/auth/guard'
import { buildCompareScanInput } from '@/core/report/model'
import { compareScans } from '@/core/report/compare'

type Params = { params: Promise<{ id: string }> }

export const runtime = 'nodejs'

/**
 * GET /api/projects/:id/compare?baseScanId&targetScanId（规格 11 / F10）。
 * 归属校验：项目须属于当前会话（预置只读可看），两个 scan 都必须属于该项目，
 * 跨会话/跨项目/不存在一律 404（不泄露存在性）。
 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const baseScanId = req.nextUrl.searchParams.get('baseScanId') ?? ''
    const targetScanId = req.nextUrl.searchParams.get('targetScanId') ?? ''
    if (!baseScanId || !targetScanId) {
      return jsonError(400, 'invalid_request', '缺少 baseScanId 或 targetScanId 参数')
    }
    const sql = getDb()
    const session = await requireSession(sql, req)
    const project = await requireReadableProject(sql, session, id)
    assertUuid(baseScanId, '扫描')
    assertUuid(targetScanId, '扫描')

    const rows = (await sql`
      select sc.id
      from scans sc
      join snapshots s on s.id = sc.snapshot_id
      where s.project_id = ${project.id}
        and (sc.id = ${baseScanId} or sc.id = ${targetScanId})`) as unknown as Array<{ id: string }>
    const found = new Set(rows.map((r) => r.id))
    if (!found.has(baseScanId) || !found.has(targetScanId)) {
      throw new HttpError(404, 'not_found', '扫描不存在或不属于该项目')
    }

    const [base, target] = await Promise.all([
      buildCompareScanInput(sql, baseScanId),
      buildCompareScanInput(sql, targetScanId),
    ])
    return jsonOk(compareScans(base, target))
  } catch (err) {
    return toErrorResponse(err)
  }
}
