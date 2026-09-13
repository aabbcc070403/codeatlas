import { cookies } from 'next/headers'
import { createHash } from 'node:crypto'
import { getDb } from '@/server/db/client'
import { SESSION_COOKIE } from '@/server/auth/session'
import { readDatasetInfo, resolveFixturesDir } from '@/core/evaluation/dataset'
import { EvaluationClient, type EvaluationRunItem } from '@/components/evaluation/evaluation-client'
import { Gauge } from 'lucide-react'

export const dynamic = 'force-dynamic'

/**
 * 评测中心页（规格 5 / F11 / R08）：评测配置、运行列表、指标与消融对比。
 * 未运行/进行中/部分失败状态齐全；尚未实测的数据为空态；
 * 小样本口径与真实模型状态如实展示。
 */
export default async function EvaluationPage() {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  const tokenHash = createHash('sha256').update(token ?? '').digest('hex')
  const sql = getDb()
  const sessionRows = await sql`select id, role from sessions
    where token_hash = ${tokenHash} and expires_at > now() limit 1`
  const session = sessionRows[0] as { id: string; role: 'demo' | 'admin' } | undefined
  const role = session?.role ?? 'demo'

  const runRows = (await sql`
    select id, dataset_version as "datasetVersion", config_json as "configJson", status,
      metrics_json as "metricsJson", error_text as "errorText",
      created_at as "createdAt", completed_at as "completedAt"
    from evaluations order by created_at desc limit 50`) as unknown as Array<{
    id: string
    datasetVersion: string
    configJson: unknown
    status: string
    metricsJson: unknown
    errorText: string | null
    createdAt: Date
    completedAt: Date | null
  }>

  const runs: EvaluationRunItem[] = runRows.map((r) => ({
    id: r.id,
    datasetVersion: r.datasetVersion,
    configJson: (r.configJson ?? null) as EvaluationRunItem['configJson'],
    status: r.status,
    metricsJson: (r.metricsJson ?? null) as EvaluationRunItem['metricsJson'],
    errorText: r.errorText,
    createdAt: new Date(r.createdAt).toISOString(),
    completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
  }))

  const dataset = readDatasetInfo(resolveFixturesDir())

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Gauge className="h-6 w-6 text-primary" />
          评测中心
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          在 24 个人工标注样例项目（12 缺陷 + 12 对照，开发/保留集 16/8 划分）上运行三模式评测，
          展示 Precision / Recall / F1、证据有效率、延迟与 token 用量。
        </p>
      </div>
      <EvaluationClient
        role={role}
        dataset={
          dataset
            ? {
                version: dataset.version,
                revision: dataset.revision,
                projectCount: dataset.projectCount,
                defectCount: dataset.defectCount,
                controlCount: dataset.controlCount,
                devCount: dataset.split.dev.length,
                holdoutCount: dataset.split.holdout.length,
                categories: dataset.categories,
              }
            : null
        }
        initialRuns={runs}
      />
    </div>
  )
}
