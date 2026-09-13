import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/server/db/client'
import { assertSameOrigin, jsonError, jsonOk, toErrorResponse, HttpError } from '@/server/api/http'
import { assertUuid, requireReadableScan, requireSession } from '@/server/auth/guard'
import { computeRisk } from '@/core/report/risk'
import { asPgJson } from '@/server/db/json'

type Params = { params: Promise<{ id: string }> }

const bodySchema = z.object({
  feedback: z.enum(['confirmed', 'false_positive', 'unreviewed']),
})

export const runtime = 'nodejs'

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    assertSameOrigin(req)
    const { id } = await params
    const sql = getDb()
    const session = await requireSession(sql, req)
    assertUuid(id, '问题')
    const parsed = bodySchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return jsonError(400, 'invalid_request', 'feedback 必须是 confirmed/false_positive/unreviewed')
    }
    const rows = await sql`select id, scan_id from findings where id = ${id} limit 1`
    if (rows.length === 0) throw new HttpError(404, 'not_found', '问题不存在')
    const scanId = (rows[0] as { scan_id: string }).scan_id
    await requireReadableScan(sql, session, scanId)

    await sql`update findings set feedback = ${parsed.data.feedback} where id = ${id}`
    // 反馈影响风险指标：重算并更新（条件：非终态不覆盖已有报告？风险随反馈实时更新更诚实）
    const allFindings = (await sql`select (draft_json->>'severity') as severity,
      evidence_status as "evidenceStatus", feedback
      from findings where scan_id = ${scanId}`) as unknown as Array<{
      severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
      evidenceStatus: 'valid' | 'needs_review'
      feedback: 'unreviewed' | 'confirmed' | 'false_positive'
    }>
    const risk = computeRisk(allFindings)
    await sql`update scans set risk_json = ${sql.json(asPgJson(risk))} where id = ${scanId}`
    return jsonOk({ id, feedback: parsed.data.feedback, risk })
  } catch (err) {
    return toErrorResponse(err)
  }
}
