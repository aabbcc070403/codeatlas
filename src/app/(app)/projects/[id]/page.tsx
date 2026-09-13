import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getDb } from '@/server/db/client'
import { SESSION_COOKIE } from '@/server/auth/session'
import { requireSession } from '@/server/auth/guard'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { UploadSnapshot } from '@/components/projects/upload-snapshot'
import { FileBrowser } from '@/components/projects/file-browser'
import { DeleteProjectButton } from '@/components/projects/delete-project-button'
import { History, ScanSearch, Package, GitCompareArrows } from 'lucide-react'
import { formatTime } from '@/lib/utils'
import type { StructureStats } from '@/server/db/schema'
import { asJson } from '@/server/db/json'
import { ScanLauncher } from '@/components/projects/scan-launcher'

export const dynamic = 'force-dynamic'

interface LatestScan {
  id: string
  status: string
  stage: string
  riskIndex: string | null
  createdAt: string
}

interface SnapshotRow {
  id: string
  content_hash: string
  file_count: number
  skipped_count: number
  created_at: string
  structure_raw: unknown
  latest_scan_raw: unknown
  scan_count: number
}

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  const req = new Request(`http://localhost:3100/api/projects/${id}`, {
    headers: { cookie: token ? `${SESSION_COOKIE}=${token}` : '' },
  })
  const sql = getDb()
  let project: { id: string; name: string; isPreset: boolean }
  try {
    const session = await requireSession(sql, req)
    const rows = await sql`select id, name, is_preset from projects where id = ${id} and (session_id = ${session.id} or is_preset = true)`
    if (rows.length === 0) redirect('/projects')
    const row = rows[0] as { id: string; name: string; is_preset: boolean }
    project = { id: row.id, name: row.name, isPreset: row.is_preset }
  } catch {
    redirect('/login')
  }

  const snapshotsRaw = await sql`
    select s.id, s.content_hash, s.file_count, s.skipped_count, s.created_at,
      s.structure_json as structure_raw,
      (select count(*)::int from scans sc where sc.snapshot_id = s.id) as scan_count,
      (select json_build_object('id', sc.id, 'status', sc.status, 'stage', sc.stage,
              'riskIndex', sc.risk_json->>'riskIndex', 'createdAt', sc.created_at)
       from scans sc where sc.snapshot_id = s.id
       order by sc.created_at desc limit 1) as latest_scan_raw
    from snapshots s where s.project_id = ${id} order by s.created_at desc` as unknown as SnapshotRow[]
  const snapshots = snapshotsRaw.map((s) => ({
    ...s,
    structure: asJson<StructureStats | null>(s.structure_raw),
    latest_scan: asJson<LatestScan | null>(s.latest_scan_raw),
  }))

  const scanCount = snapshots.reduce((acc, s) => acc + s.scan_count, 0)

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{project.name}</h1>
        {project.isPreset && <Badge variant="secondary">预置示例（只读）</Badge>}
        <div className="ml-auto flex items-center gap-2">
          {scanCount >= 2 && (
            <Link href={`/projects/${id}/compare`}>
              <Button variant="outline" size="sm">
                <GitCompareArrows className="h-4 w-4" />
                快照对比
              </Button>
            </Link>
          )}
          {!project.isPreset && (
            <DeleteProjectButton projectId={project.id} projectName={project.name} />
          )}
        </div>
      </div>

      {!project.isPreset && (
        <div className="mb-6">
          <UploadSnapshot projectId={project.id} />
        </div>
      )}

      {snapshots.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <History className="h-10 w-10 text-muted-foreground/40" />
            <p className="font-medium">还没有快照</p>
            <p className="text-sm text-muted-foreground">
              {project.isPreset ? '预置项目暂无快照' : '上传项目 ZIP 生成第一个不可变快照'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {snapshots.map((snap) => (
            <Card key={snap.id}>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <History className="h-4 w-4 text-primary" />
                    快照 {snap.id.slice(0, 8)}
                  </CardTitle>
                  <span className="text-sm text-muted-foreground">
                    {formatTime(snap.created_at)} · {snap.file_count} 个文件
                    {snap.skipped_count > 0 && ` · ${snap.skipped_count} 个跳过`}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    {snap.latest_scan ? (
                      <Link href={`/scans/${snap.latest_scan.id}`}>
                        <Button variant="outline" size="sm">
                          <ScanSearch className="h-4 w-4" />
                          查看最近扫描
                        </Button>
                      </Link>
                    ) : (
                      <span className="text-xs text-muted-foreground">尚未扫描</span>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <StructureSummary structure={snap.structure} />
                {snap.latest_scan && (
                  <p className="text-xs text-muted-foreground">
                    最近扫描：{formatTime(snap.latest_scan.createdAt)} · 状态 {snap.latest_scan.status}
                    {snap.latest_scan.riskIndex !== null && ` · 风险指数 ${snap.latest_scan.riskIndex}`}
                  </p>
                )}
                <ScanLauncher snapshotId={snap.id} hasScan={snap.scan_count > 0} />
                <details>
                  <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                    浏览快照文件（脱敏后）
                  </summary>
                  <div className="mt-3">
                    <FileBrowser snapshotId={snap.id} />
                  </div>
                </details>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

function StructureSummary({ structure }: { structure: StructureStats | null }) {
  if (!structure) return null
  const deps = structure.dependencyFiles.find((d) => d.path === 'package.json')
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {Object.entries(structure.languageCounts).map(([lang, n]) => (
        <Badge key={lang} variant="secondary">
          {lang} × {n}
        </Badge>
      ))}
      <Badge variant="outline">
        <Package className="mr-1 h-3 w-3" />
        依赖 {deps?.declared.length ?? 0} 项
      </Badge>
      <Badge variant="outline">相对导入 {structure.importEdges.length} 条</Badge>
      {structure.unresolvedImports.length > 0 && (
        <Badge variant="warning">未解析导入 {structure.unresolvedImports.length} 条</Badge>
      )}
      {structure.lockFiles.length > 0 ? (
        <Badge variant="muted">锁文件存在（未接入漏洞库）</Badge>
      ) : (
        <Badge variant="muted">无锁文件</Badge>
      )}
    </div>
  )
}
