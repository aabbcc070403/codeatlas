import { type NextRequest } from 'next/server'
import { getDb } from '@/server/db/client'
import { assertSameOrigin, jsonOk, toErrorResponse } from '@/server/api/http'
import { requireReadableScan, requireSession } from '@/server/auth/guard'

type Params = { params: Promise<{ id: string }> }

export const runtime = 'nodejs'

export async function POST(req: NextRequest, { params }: Params) {
  try {
    assertSameOrigin(req)
    const { id } = await params
    const sql = getDb()
    const session = await requireSession(sql, req)
    const ref = await requireReadableScan(sql, session, id)

    const rows = await sql`select status from scans where id = ${ref.scanId}`
    const status = (rows[0] as { status: string }).status
    if (['completed', 'partial', 'failed', 'cancelled'].includes(status)) {
      return jsonOk({ status: 'already_terminal', scanStatus: status }, 202)
    }

    if (status === 'queued') {
      // 尚未被 worker 领取：直接终态化
      await sql.begin(async (tx) => {
        await tx`update scans set status = 'cancelled', completed_at = now()
          where id = ${ref.scanId} and status = 'queued'`
        await tx`update jobs set state = 'cancelled', cancel_requested_at = now()
          where kind = 'scan' and target_id = ${ref.scanId} and state = 'queued'`
        await tx`insert into scan_events (scan_id, event_type, payload_json)
          values (${ref.scanId}, 'scan.finished', '{"status":"cancelled"}'::jsonb)`
      })
      return jsonOk({ status: 'cancelled' }, 202)
    }

    // running：请求取消，worker 在阶段/工具边界落实
    await sql`update jobs set cancel_requested_at = now()
      where kind = 'scan' and target_id = ${ref.scanId} and state = 'running'`
    return jsonOk({ status: 'cancellation_requested' }, 202)
  } catch (err) {
    return toErrorResponse(err)
  }
}
