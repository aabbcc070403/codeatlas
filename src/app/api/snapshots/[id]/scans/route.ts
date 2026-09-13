import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { getDb } from '@/server/db/client'
import { assertSameOrigin, jsonError, jsonOk, toErrorResponse, HttpError } from '@/server/api/http'
import { requireReadableSnapshot, requireSession } from '@/server/auth/guard'
import { asPgJson } from '@/server/db/json'

type Params = { params: Promise<{ id: string }> }

const bodySchema = z.object({
  enableCloudAI: z.boolean().default(false),
  mode: z.literal('standard').default('standard'),
})

export const runtime = 'nodejs'

export async function POST(req: NextRequest, { params }: Params) {
  try {
    assertSameOrigin(req)
    const { id } = await params
    const sql = getDb()
    const session = await requireSession(sql, req)
    const ref = await requireReadableSnapshot(sql, session, id)

    const idempotencyKey = req.headers.get('idempotency-key')
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      return jsonError(400, 'invalid_request', '缺少有效的 Idempotency-Key 请求头')
    }
    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})))
    if (!parsed.success) {
      return jsonError(400, 'invalid_request', '请求体无效')
    }
    const config = parsed.data

    // 每会话最多一个活动扫描（本人项目范围）
    const active = await sql`
      select sc.id from scans sc
      join snapshots sn on sn.id = sc.snapshot_id
      join projects p on p.id = sn.project_id
      where p.session_id = ${session.id} and sc.status in ('queued', 'running')
      limit 1`
    if (active.length > 0) {
      throw new HttpError(409, 'conflict', '当前会话已有进行中的扫描，请等待完成或取消后再试')
    }

    // 幂等创建：同一 (snapshot, idempotencyKey) 只产生一次扫描
    const inserted = await sql`
      insert into scans (snapshot_id, idempotency_key, status, stage, config_json, rule_version, prompt_version)
      values (${ref.snapshotId}, ${idempotencyKey}, 'queued', 'ingest', ${sql.json(asPgJson(config))}, 'static-rules-v1', 'review-prompt-v1')
      on conflict (snapshot_id, idempotency_key) do nothing
      returning id, status, created_at`
    let scanId: string
    let duplicate = false
    if (inserted.length === 0) {
      const existing = await sql`select id, status, created_at from scans
        where snapshot_id = ${ref.snapshotId} and idempotency_key = ${idempotencyKey}`
      scanId = (existing[0] as { id: string }).id
      duplicate = true
    } else {
      scanId = (inserted[0] as { id: string }).id
      await sql`insert into jobs (kind, target_id) values ('scan', ${scanId})
        on conflict (kind, target_id) do nothing`
    }
    const scan = await sql`select id, status, stage, created_at from scans where id = ${scanId}`
    return jsonOk({ scan: scan[0], duplicate }, 202)
  } catch (err) {
    return toErrorResponse(err)
  }
}
