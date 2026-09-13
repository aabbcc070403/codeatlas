import { NextResponse, type NextRequest } from 'next/server'
import { getDb } from '@/server/db/client'
import { assertSameOrigin, toErrorResponse } from '@/server/api/http'
import { requireOwnedProject, requireReadableProject, requireSession } from '@/server/auth/guard'
import { markProjectDeleting, cleanupDeletingProjects } from '@/worker/cleanup'

type Params = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params
    const sql = getDb()
    const session = await requireSession(sql, req)
    const project = await requireReadableProject(sql, session, id)
    const snapshots = await sql`
      select s.id, s.status, s.file_count, s.skipped_count, s.created_at,
        (select json_build_object('id', sc.id, 'status', sc.status, 'stage', sc.stage,
                'riskIndex', sc.risk_json->>'riskIndex', 'createdAt', sc.created_at)
         from scans sc where sc.snapshot_id = s.id
         order by sc.created_at desc limit 1) as latest_scan
      from snapshots s where s.project_id = ${id} order by s.created_at desc`
    return NextResponse.json({
      project: {
        id: project.id,
        name: project.name,
        isPreset: project.isPreset,
        deleting: (
          (await sql`select deleting_at is not null as deleting from projects where id = ${id}`)[0] as unknown as {
            deleting: boolean
          }
        ).deleting,
        createdAt: await sql`select created_at from projects where id = ${id}`.then(
          (r) => (r[0] as { created_at: string }).created_at,
        ),
      },
      snapshots,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * 删除项目（R03）：先请求取消相关任务并标记 deleting_at。
 * - 无活动租约：立即走清理服务（先删存储、再删 DB 行），返回 204；
 * - 有活动租约或清理被阻塞：返回 202，由 worker 清理服务在任务退出/到期后完成。
 */
export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    assertSameOrigin(req)
    const { id } = await params
    const sql = getDb()
    const session = await requireSession(sql, req)
    await requireOwnedProject(sql, session, id)
    const hasActive = await markProjectDeleting(sql, id)
    if (!hasActive) {
      // 无活动任务：立即清理（与清理服务同一路径，保证存储→DB 顺序一致）
      await cleanupDeletingProjects(sql)
      const left = await sql`select 1 from projects where id = ${id} limit 1`
      if (left.length === 0) {
        return new NextResponse(null, { status: 204 })
      }
    }
    return NextResponse.json({ deleting: true }, { status: 202 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
