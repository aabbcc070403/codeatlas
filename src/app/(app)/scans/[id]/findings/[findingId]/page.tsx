import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { getDb } from '@/server/db/client'
import { SESSION_COOKIE } from '@/server/auth/session'
import { assertUuid, requireReadableScan, requireSession } from '@/server/auth/guard'
import {
  getFindingDetail,
  loadScanDetail,
  readSnapshotFileDetail,
  type FindingDetailRow,
  type SnapshotFileContent,
} from '@/server/queries/scans'
import { FindingDetail } from '@/components/review/finding-detail'
import type { GuidelineCitationInfo } from '@/components/review/evidence-panel'
import type { RiskInfo } from '@/core/contracts/scan'

export const dynamic = 'force-dynamic'

/**
 * 问题详情页（R02）：服务端校验归属（跨会话一律 404），
 * 预取问题详情、扫描风险与主引用文件内容；代码定位与反馈由客户端完成。
 */
export default async function FindingPage({
  params,
}: {
  params: Promise<{ id: string; findingId: string }>
}) {
  const { id, findingId } = await params
  assertUuid(findingId, '问题')

  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  const req = new Request(`http://localhost:3100/api/findings/${findingId}`, {
    headers: { cookie: token ? `${SESSION_COOKIE}=${token}` : '' },
  })
  const sql = getDb()

  let projectId: string
  let projectName: string
  try {
    const session = await requireSession(sql, req)
    const ref = await requireReadableScan(sql, session, id)
    const row = await getFindingDetail(sql, findingId)
    // 问题必须属于当前扫描
    if (row.scanId !== id) notFound()
    projectId = ref.projectId
    const projectRows = (await sql`select name from projects where id = ${ref.projectId} limit 1`) as unknown as Array<{ name: string }>
    projectName = projectRows[0]?.name ?? '未知项目'

    const scan = await loadScanDetail(sql, row.scanId, ref.snapshotId)
    // 主引用文件内容预取（文件不在快照/被清理时为 null，客户端显示明确错误状态）
    let file: SnapshotFileContent | null = null
    try {
      file = await readSnapshotFileDetail(sql, projectId, ref.snapshotId, row.draft.primary.path)
    } catch {
      file = null
    }

    const risk: RiskInfo | null = scan.scan.risk
    const finding: FindingDetailRow = row
    // 规范引用快照（scan_citations）：证据面板的标题/版本/来源唯一可信来源
    const chunkIds = [...new Set(finding.draft.guidelineChunkIds)]
    let guidelineCitations: GuidelineCitationInfo[] = []
    if (chunkIds.length > 0) {
      const citeRows = (await sql`select chunk_id, title, version, source_url
        from scan_citations
        where scan_id = ${row.scanId} and chunk_id is not null`) as unknown as Array<{
        chunk_id: string
        title: string
        version: number
        source_url: string | null
      }>
      guidelineCitations = citeRows
        .filter((c) => chunkIds.includes(c.chunk_id))
        .map((c) => ({ chunkId: c.chunk_id, title: c.title, version: c.version, sourceUrl: c.source_url }))
    }
    return (
      <FindingDetail
        key={finding.id}
        findingId={finding.id}
        scanId={row.scanId}
        projectName={projectName}
        initialFinding={finding}
        initialSnapshotId={ref.snapshotId}
        initialFile={file}
        initialRisk={risk}
        initialGuidelineCitations={guidelineCitations}
      />
    )
  } catch {
    notFound()
  }
}
