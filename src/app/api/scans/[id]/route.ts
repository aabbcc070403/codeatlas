import { type NextRequest } from 'next/server'
import { getDb } from '@/server/db/client'
import { jsonOk, toErrorResponse } from '@/server/api/http'
import { requireReadableScan, requireSession } from '@/server/auth/guard'
import { loadScanDetail } from '@/server/queries/scans'

type Params = { params: Promise<{ id: string }> }

export const runtime = 'nodejs'

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const sql = getDb()
    const session = await requireSession(sql, req)
    const ref = await requireReadableScan(sql, session, id)

    const body = await loadScanDetail(sql, ref.scanId, ref.snapshotId)
    return jsonOk({
      ...body,
      findingsHref: `/api/scans/${ref.scanId}/findings`,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
