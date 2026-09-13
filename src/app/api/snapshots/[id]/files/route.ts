import { type NextRequest } from 'next/server'
import { getDb } from '@/server/db/client'
import { jsonOk, toErrorResponse } from '@/server/api/http'
import { requireReadableSnapshot, requireSession } from '@/server/auth/guard'
import { readSnapshotFileDetail } from '@/server/queries/scans'

type Params = { params: Promise<{ id: string }> }

export const runtime = 'nodejs'

/** 文件树（无 path）或单文件内容（?path=...）。所有访问通过 snapshotId + 规范化路径定位。 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const sql = getDb()
    const session = await requireSession(sql, req)
    const ref = await requireReadableSnapshot(sql, session, id)

    const path = new URL(req.url).searchParams.get('path')
    if (!path) {
      const files = await sql`select path, language, line_count, parse_status
        from files where snapshot_id = ${ref.snapshotId} order by path asc`
      return jsonOk({ snapshotId: ref.snapshotId, files })
    }

    const file = await readSnapshotFileDetail(sql, ref.projectId, ref.snapshotId, path)
    return jsonOk(file)
  } catch (err) {
    return toErrorResponse(err)
  }
}
