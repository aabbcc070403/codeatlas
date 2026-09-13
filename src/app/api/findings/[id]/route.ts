import { type NextRequest } from 'next/server'
import { getDb } from '@/server/db/client'
import { jsonOk, toErrorResponse } from '@/server/api/http'
import { assertUuid, requireReadableScan, requireSession } from '@/server/auth/guard'
import { getFindingDetail } from '@/server/queries/scans'

type Params = { params: Promise<{ id: string }> }

export const runtime = 'nodejs'

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const sql = getDb()
    const session = await requireSession(sql, req)
    assertUuid(id, '问题')
    const row = await getFindingDetail(sql, id)
    // 权限校验：扫描必须对当前会话可读
    await requireReadableScan(sql, session, row.scanId)
    return jsonOk(row)
  } catch (err) {
    return toErrorResponse(err)
  }
}
