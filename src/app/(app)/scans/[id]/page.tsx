import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { getDb } from '@/server/db/client'
import { SESSION_COOKIE } from '@/server/auth/session'
import { requireSession, requireReadableScan } from '@/server/auth/guard'
import { loadScanDetail, listFindings } from '@/server/queries/scans'
import { ScanWorkbench, type ScanApiBody } from '@/components/review/scan-workbench'

export const dynamic = 'force-dynamic'

/**
 * 扫描工作台入口（R02）：服务端做会话与归属校验并预取首屏数据
 * （扫描状态、风险、覆盖、工具轨迹、问题首屏），实时性由客户端 SSE/轮询负责；
 * 浏览器刷新从持久化结果恢复，不依赖内存事件。
 */
export default async function ScanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  const req = new Request(`http://localhost:3100/api/scans/${id}`, {
    headers: { cookie: token ? `${SESSION_COOKIE}=${token}` : '' },
  })
  const sql = getDb()

  let scanId: string
  let projectId: string
  let projectName: string
  let snapshotId: string
  try {
    const session = await requireSession(sql, req)
    const ref = await requireReadableScan(sql, session, id)
    scanId = ref.scanId
    projectId = ref.projectId
    snapshotId = ref.snapshotId
    const projectRows = await sql`select name from projects where id = ${ref.projectId} limit 1`
    projectName = (projectRows[0] as { name: string } | undefined)?.name ?? '未知项目'
  } catch {
    notFound()
  }

  // 首屏数据（与 GET /api/scans/:id、/findings 共用查询）
  let initial: ScanApiBody
  let initialFindings: Awaited<ReturnType<typeof listFindings>>['items']
  try {
    const detail = await loadScanDetail(sql, scanId, snapshotId)
    initial = { ...detail, project: null }
    initialFindings = (await listFindings(sql, scanId, { limit: 100 })).items
  } catch {
    notFound()
  }

  return (
    <ScanWorkbench
      scanId={scanId}
      projectId={projectId}
      projectName={projectName}
      initial={initial}
      initialFindings={initialFindings}
    />
  )
}
