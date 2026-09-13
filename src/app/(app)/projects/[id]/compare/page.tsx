import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { getDb } from '@/server/db/client'
import { SESSION_COOKIE } from '@/server/auth/session'
import { requireSession, requireReadableProject } from '@/server/auth/guard'
import { CompareClient, type CompareScanOption } from '@/components/projects/compare-client'

export const dynamic = 'force-dynamic'

/**
 * 快照对比页（R07，规格 F10 / 第 5 节 /projects/[id]/compare 行）。
 * 服务端做会话与项目归属校验（跨会话 notFound），加载项目内扫描列表供选择器使用；
 * 对比结果由客户端调用 GET /api/projects/:id/compare 获取（与导出共享同一核心）。
 */
export default async function ComparePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  const req = new Request(`http://localhost:3100/api/projects/${id}/compare`, {
    headers: { cookie: token ? `${SESSION_COOKIE}=${token}` : '' },
  })
  const sql = getDb()

  let projectName: string
  try {
    const session = await requireSession(sql, req)
    const project = await requireReadableProject(sql, session, id)
    projectName = project.name
  } catch {
    notFound()
  }

  const rows = (await sql`
    select sc.id, sc.status, sc.created_at, sc.model_id, sc.rule_version,
      sc.risk_json->>'riskIndex' as risk_index, s.created_at as snapshot_created_at
    from scans sc
    join snapshots s on s.id = sc.snapshot_id
    where s.project_id = ${id}
    order by sc.created_at asc`) as unknown as Array<{
    id: string
    status: string
    created_at: unknown
    model_id: string | null
    rule_version: string
    risk_index: string | null
    snapshot_created_at: unknown
  }>

  const scans: CompareScanOption[] = rows.map((r) => ({
    id: r.id,
    status: r.status,
    riskIndex: r.risk_index,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    snapshotCreatedAt:
      r.snapshot_created_at instanceof Date
        ? r.snapshot_created_at.toISOString()
        : String(r.snapshot_created_at),
    modelId: r.model_id,
    ruleVersion: r.rule_version,
  }))

  return <CompareClient projectId={id} projectName={projectName} scans={scans} />
}
