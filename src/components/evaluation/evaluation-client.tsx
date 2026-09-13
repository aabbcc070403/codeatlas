'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AlertTriangle, FlaskConical, Info, Play } from 'lucide-react'
import { EVALUATION_DISCLAIMER } from '@/core/contracts/evaluation'
import type { EvaluationMetricsJson, EvaluationMode, EvaluationSplit } from '@/core/contracts/evaluation'

/**
 * 评测中心客户端（R08）：配置表单、运行列表、指标/消融展示。
 * 全部纯文本渲染；数字均来自 evaluations.metrics_json（可回溯到逐项目 scanId）。
 */

export interface EvaluationDatasetInfo {
  version: string
  revision: number
  projectCount: number
  defectCount: number
  controlCount: number
  devCount: number
  holdoutCount: number
  categories: Array<{ key: string; label: string }>
}

export interface EvaluationRunItem {
  id: string
  datasetVersion: string
  configJson: { mode?: string; split?: string; executor?: string; requestedAt?: string } | null
  status: string
  metricsJson: EvaluationMetricsJson | null
  errorText: string | null
  createdAt: string
  completedAt: string | null
}

const STATUS_LABEL: Record<string, string> = {
  pending: '排队中（未运行）',
  running: '进行中',
  completed: '已完成',
  partial: '部分失败',
  failed: '失败',
  cancelled: '已取消',
}

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'warning' | 'destructive' | 'success' | 'muted' | 'info'> = {
  pending: 'muted',
  running: 'info',
  completed: 'success',
  partial: 'warning',
  failed: 'destructive',
  cancelled: 'muted',
}

const TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled'])

function pct(value: number | null): string {
  if (value === null) return 'N/A（分母为零）'
  return value.toFixed(3)
}

function fmtMs(value: number | null): string {
  if (value === null) return '—'
  return `${Math.round(value)} ms`
}

function fmtTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19)
}

export function EvaluationClient(props: {
  role: 'demo' | 'admin'
  dataset: EvaluationDatasetInfo | null
  initialRuns: EvaluationRunItem[]
}) {
  const [runs, setRuns] = useState<EvaluationRunItem[]>(props.initialRuns)
  const [mode, setMode] = useState<EvaluationMode>('static_only')
  const [split, setSplit] = useState<EvaluationSplit>('dev')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(
    props.initialRuns.find((r) => TERMINAL_STATUSES.has(r.status))?.id ?? props.initialRuns[0]?.id ?? null,
  )
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current)
    }
  }, [])

  const refreshList = useCallback(async (): Promise<EvaluationRunItem[]> => {
    const res = await fetch('/api/evaluations?limit=50', { cache: 'no-store' })
    if (!res.ok) return []
    const body = (await res.json()) as { items: EvaluationRunItem[] }
    setRuns(body.items ?? [])
    return body.items ?? []
  }, [])

  const pollRun = useCallback(
    (id: string) => {
      if (pollTimer.current) clearTimeout(pollTimer.current)
      const tick = async () => {
        try {
          const res = await fetch(`/api/evaluations/${id}`, { cache: 'no-store' })
          if (res.ok) {
            const body = (await res.json()) as { evaluation: EvaluationRunItem }
            const updated = body.evaluation
            setRuns((prev) => prev.map((r) => (r.id === id ? updated : r)))
            if (TERMINAL_STATUSES.has(updated.status)) {
              await refreshList()
              return
            }
          }
        } catch {
          // 网络抖动：下一轮继续
        }
        pollTimer.current = setTimeout(tick, 2000)
      }
      pollTimer.current = setTimeout(tick, 1500)
    },
    [refreshList],
  )

  const submit = async () => {
    if (!props.dataset || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/evaluations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetVersion: props.dataset.version, mode, split }),
      })
      if (res.status === 202) {
        const body = (await res.json()) as { id: string }
        setSelectedId(body.id)
        setRuns((prev) => [
          {
            id: body.id,
            datasetVersion: props.dataset!.version,
            configJson: { mode, split, executor: 'worker', requestedAt: new Date().toISOString() },
            status: 'pending',
            metricsJson: null,
            errorText: null,
            createdAt: new Date().toISOString(),
            completedAt: null,
          },
          ...prev,
        ])
        pollRun(body.id)
      } else {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
        setError(
          body?.error?.message ??
            `评测请求失败（HTTP ${res.status}）`,
        )
      }
    } catch {
      setError('评测请求发送失败：网络错误')
    } finally {
      setSubmitting(false)
    }
  }

  const selected = runs.find((r) => r.id === selectedId) ?? null
  const selectedMetrics = selected?.metricsJson ?? null

  // 消融对比：同数据集 + 同划分下，每个模式取最近一次有指标的运行
  const ablationBase = selectedMetrics?.config
  const ablationRows = ablationBase
    ? (['static_only', 'llm_no_rag', 'hybrid_rag'] as EvaluationMode[])
        .map((m) =>
          runs.find(
            (r) =>
              r.metricsJson !== null &&
              r.metricsJson.config.datasetVersion === ablationBase.datasetVersion &&
              r.metricsJson.config.split === ablationBase.split &&
              r.metricsJson.config.mode === m,
          ),
        )
        .filter((r): r is EvaluationRunItem => r !== undefined && r.metricsJson !== null)
    : []

  return (
    <div className="flex flex-col gap-6">
      {/* 数据集概况 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">评测数据集</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {props.dataset ? (
            <div className="flex flex-wrap items-center gap-2" data-testid="dataset-info">
              <Badge variant="secondary">版本 {props.dataset.version}</Badge>
              <Badge variant="outline">{props.dataset.projectCount} 项目</Badge>
              <Badge variant="outline">{props.dataset.defectCount} 缺陷 + {props.dataset.controlCount} 对照</Badge>
              <Badge variant="outline">开发集 {props.dataset.devCount} / 保留集 {props.dataset.holdoutCount}</Badge>
              <span className="text-xs text-muted-foreground">
                {props.dataset.categories.map((c) => c.label).join(' · ')}
              </span>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="dataset-missing">
              数据集未生成：请先在项目根目录运行 <code>pnpm fixtures:generate</code> 生成 fixtures/。
            </p>
          )}
          <p className="mt-2 text-xs text-muted-foreground" data-testid="eval-disclaimer">
            {EVALUATION_DISCLAIMER}
          </p>
          <p className="mt-1 text-xs text-muted-foreground" data-testid="real-model-note">
            真实模型评测未执行（本地无模型凭证）：llm 模式的运行将使用受控 Mock 管线并明确标注 provider=mock，
            保留集重复 3 次的真实模型评测未执行。
          </p>
        </CardContent>
      </Card>

      {/* 运行配置 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">运行评测</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              模式（消融仅切换规范检索）
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as EvaluationMode)}
                className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
                data-testid="eval-mode"
              >
                <option value="static_only">static_only · 仅静态规则</option>
                <option value="llm_no_rag">llm_no_rag · AI 无规范检索</option>
                <option value="hybrid_rag">hybrid_rag · AI 混合 RAG</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              划分
              <select
                value={split}
                onChange={(e) => setSplit(e.target.value as EvaluationSplit)}
                className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
                data-testid="eval-split"
              >
                <option value="dev">开发集（16）</option>
                <option value="holdout">保留集（8）</option>
                <option value="all">全部（24）</option>
              </select>
            </label>
            <Button onClick={submit} disabled={!props.dataset || submitting} data-testid="eval-run">
              <Play className="mr-1 h-4 w-4" />
              {submitting ? '提交中…' : '运行评测'}
            </Button>
          </div>
          {props.role !== 'admin' && (
            <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5" />
              运行评测需要管理员访问码会话；demo 会话触发将被服务端拒绝（403）。
            </p>
          )}
          {error && (
            <p className="mt-2 flex items-center gap-1 text-sm text-destructive" data-testid="eval-error" role="alert">
              <AlertTriangle className="h-4 w-4" />
              {error}
            </p>
          )}
        </CardContent>
      </Card>

      {/* 运行列表 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">运行记录</CardTitle>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground" data-testid="eval-empty">
              尚未运行评测：选择模式后点击「运行评测」，结果将展示在这里。
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm" data-testid="eval-run-table">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">时间</th>
                    <th className="py-2 pr-3 font-medium">模式</th>
                    <th className="py-2 pr-3 font-medium">划分</th>
                    <th className="py-2 pr-3 font-medium">数据集</th>
                    <th className="py-2 pr-3 font-medium">状态</th>
                    <th className="py-2 pr-3 font-medium">P / R / F1</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => {
                    const m = run.metricsJson?.totals ?? null
                    return (
                      <tr key={run.id} className="border-b last:border-0" data-testid="eval-run-row">
                        <td className="py-2 pr-3 font-mono text-xs">{fmtTime(run.createdAt)}</td>
                        <td className="py-2 pr-3">
                          <span className="mr-1">{run.metricsJson?.config.modeLabel ?? run.configJson?.mode ?? '—'}</span>
                          {run.metricsJson?.config.mode !== 'static_only' && (
                            <Badge variant={run.metricsJson?.config.providerIsMock === false ? 'ai' : 'muted'}>
                              {run.metricsJson?.config.providerIsMock === false ? '真实模型' : 'Mock'}
                            </Badge>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-xs">{run.metricsJson?.config.split ?? run.configJson?.split ?? '—'}</td>
                        <td className="py-2 pr-3 font-mono text-xs">{run.datasetVersion}</td>
                        <td className="py-2 pr-3">
                          <Badge variant={STATUS_VARIANT[run.status] ?? 'muted'}>
                            {STATUS_LABEL[run.status] ?? run.status}
                          </Badge>
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs">
                          {m ? `${pct(m.precision)} / ${pct(m.recall)} / ${pct(m.f1)}` : '—'}
                        </td>
                        <td className="py-2">
                          <button
                            type="button"
                            className="text-primary hover:underline"
                            onClick={() => setSelectedId(run.id)}
                          >
                            {selectedId === run.id ? '查看中' : '查看'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 选中运行详情 */}
      {selected && (
        <Card data-testid="eval-detail">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              运行详情 · {STATUS_LABEL[selected.status] ?? selected.status}
              {selected.status === 'running' || selected.status === 'pending' ? '（每 2 秒自动刷新）' : ''}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            {selected.errorText && (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                {selected.errorText}
              </p>
            )}
            {selectedMetrics ? (
              <>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground" data-testid="eval-config">
                  <Badge variant="secondary">数据集 {selectedMetrics.config.datasetVersion}</Badge>
                  <Badge variant="outline">{selectedMetrics.config.modeLabel}</Badge>
                  <Badge variant="outline">划分 {selectedMetrics.config.split}</Badge>
                  <Badge variant="outline">规则 {selectedMetrics.config.ruleVersion}</Badge>
                  <Badge variant="outline">提示词 {selectedMetrics.config.promptVersion}</Badge>
                  {selectedMetrics.config.modelId && <Badge variant="outline">模型 {selectedMetrics.config.modelId}</Badge>}
                  {selectedMetrics.config.mode !== 'static_only' && (
                    <Badge variant={selectedMetrics.config.providerIsMock ? 'muted' : 'ai'}>
                      {selectedMetrics.config.providerIsMock
                        ? 'provider=mock（非真实模型）'
                        : `provider=${selectedMetrics.config.provider}`}
                    </Badge>
                  )}
                  {selectedMetrics.config.cancelled && <Badge variant="warning">中途取消</Badge>}
                  {selectedMetrics.config.projectLimit !== null && (
                    <Badge variant="outline">项目数限制 {selectedMetrics.config.projectLimit}</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{selectedMetrics.config.note}</p>

                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <MetricCard testId="metric-precision" label="Precision" value={pct(selectedMetrics.totals.precision)} hint={`TP ${selectedMetrics.totals.tp} / (TP+FP ${selectedMetrics.totals.tp + selectedMetrics.totals.fp})`} />
                  <MetricCard testId="metric-recall" label="Recall" value={pct(selectedMetrics.totals.recall)} hint={`TP ${selectedMetrics.totals.tp} / (TP+FN ${selectedMetrics.totals.tp + selectedMetrics.totals.fn})`} />
                  <MetricCard testId="metric-f1" label="F1" value={pct(selectedMetrics.totals.f1)} hint="P 与 R 的调和平均" />
                  <MetricCard
                    testId="metric-evidence-valid"
                    label="证据有效率"
                    value={
                      selectedMetrics.totals.evidenceValidRate === null
                        ? '—（无候选）'
                        : `${(selectedMetrics.totals.evidenceValidRate * 100).toFixed(1)}%`
                    }
                    hint={`无效引用 ${selectedMetrics.totals.invalidCitations}（计入 FP）`}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <MetricCard testId="metric-p50" label="延迟 p50" value={fmtMs(selectedMetrics.latency.p50Ms)} hint="逐项目扫描耗时" />
                  <MetricCard testId="metric-p95" label="延迟 p95" value={fmtMs(selectedMetrics.latency.p95Ms)} hint="逐项目扫描耗时" />
                  <MetricCard
                    testId="metric-tokens"
                    label="token / 项目"
                    value={selectedMetrics.tokens.perProject === null ? '—' : selectedMetrics.tokens.perProject.toFixed(0)}
                    hint={`合计 ${selectedMetrics.tokens.total}`}
                  />
                  <MetricCard
                    testId="metric-counts"
                    label="TP / FP / FN"
                    value={`${selectedMetrics.totals.tp} / ${selectedMetrics.totals.fp} / ${selectedMetrics.totals.fn}`}
                    hint={`重复报警 ${selectedMetrics.totals.duplicates}（额外计 FP） · 标注 ${selectedMetrics.totals.annotationCount} · 候选 ${selectedMetrics.totals.candidateCount}`}
                  />
                </div>

                {/* 消融对比 */}
                <div>
                  <h3 className="mb-2 flex items-center gap-1 text-sm font-medium">
                    <FlaskConical className="h-4 w-4 text-primary" />
                    消融对比（同数据集 + 同划分，每模式取最近一次运行）
                  </h3>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-xs" data-testid="ablation-table">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th className="py-1.5 pr-3 font-medium">模式</th>
                          <th className="py-1.5 pr-3 font-medium">Precision</th>
                          <th className="py-1.5 pr-3 font-medium">Recall</th>
                          <th className="py-1.5 pr-3 font-medium">F1</th>
                          <th className="py-1.5 pr-3 font-medium">token/项目</th>
                          <th className="py-1.5 pr-3 font-medium">延迟 p50</th>
                          <th className="py-1.5 font-medium">provider</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ablationRows.map((r) => (
                          <tr key={r.id} className="border-b last:border-0">
                            <td className="py-1.5 pr-3">{r.metricsJson!.config.modeLabel}</td>
                            <td className="py-1.5 pr-3 font-mono">{pct(r.metricsJson!.totals.precision)}</td>
                            <td className="py-1.5 pr-3 font-mono">{pct(r.metricsJson!.totals.recall)}</td>
                            <td className="py-1.5 pr-3 font-mono">{pct(r.metricsJson!.totals.f1)}</td>
                            <td className="py-1.5 pr-3 font-mono">
                              {r.metricsJson!.tokens.perProject === null ? '—' : r.metricsJson!.tokens.perProject.toFixed(0)}
                            </td>
                            <td className="py-1.5 pr-3 font-mono">{fmtMs(r.metricsJson!.latency.p50Ms)}</td>
                            <td className="py-1.5">
                              {r.metricsJson!.config.mode === 'static_only' ? (
                                '—'
                              ) : (
                                <Badge variant={r.metricsJson!.config.providerIsMock ? 'muted' : 'ai'}>
                                  {r.metricsJson!.config.providerIsMock ? 'Mock' : r.metricsJson!.config.provider}
                                </Badge>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {ablationRows.length < 3 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      其余模式尚未运行：消融对比需要三种模式各运行一次（结果将自动汇入本表）。
                    </p>
                  )}
                </div>

                {/* 逐项目结果 */}
                <div>
                  <h3 className="mb-2 text-sm font-medium">逐项目结果（可回溯到原始扫描）</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[720px] text-xs" data-testid="project-table">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th className="py-1.5 pr-3 font-medium">项目</th>
                          <th className="py-1.5 pr-3 font-medium">类型</th>
                          <th className="py-1.5 pr-3 font-medium">类别</th>
                          <th className="py-1.5 pr-3 font-medium">标注</th>
                          <th className="py-1.5 pr-3 font-medium">TP</th>
                          <th className="py-1.5 pr-3 font-medium">FP</th>
                          <th className="py-1.5 pr-3 font-medium">FN</th>
                          <th className="py-1.5 pr-3 font-medium">P</th>
                          <th className="py-1.5 pr-3 font-medium">R</th>
                          <th className="py-1.5 pr-3 font-medium">延迟</th>
                          <th className="py-1.5 font-medium">扫描</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedMetrics.projects.map((p) => (
                          <tr key={p.projectId} className="border-b last:border-0">
                            <td className="py-1.5 pr-3 font-mono">{p.projectId}</td>
                            <td className="py-1.5 pr-3">{p.kind === 'defect' ? '缺陷' : '对照'}</td>
                            <td className="py-1.5 pr-3">{p.categoryKey}</td>
                            <td className="py-1.5 pr-3 font-mono">{p.metrics.annotationCount}</td>
                            <td className="py-1.5 pr-3 font-mono">{p.metrics.tp}</td>
                            <td className="py-1.5 pr-3 font-mono">{p.metrics.fp}</td>
                            <td className="py-1.5 pr-3 font-mono">{p.metrics.fn}</td>
                            <td className="py-1.5 pr-3 font-mono">{p.metrics.precision === null ? 'N/A' : p.metrics.precision.toFixed(3)}</td>
                            <td className="py-1.5 pr-3 font-mono">{p.metrics.recall === null ? 'N/A' : p.metrics.recall.toFixed(3)}</td>
                            <td className="py-1.5 pr-3 font-mono">{fmtMs(p.latencyMs)}</td>
                            <td className="py-1.5">
                              <Link href={`/scans/${p.scanId}`} className="text-primary hover:underline">
                                查看
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {selectedMetrics.failures.length > 0 && (
                  <div>
                    <h3 className="mb-1 text-sm font-medium text-destructive">失败样例（不隐藏）</h3>
                    <ul className="list-disc pl-5 text-xs text-muted-foreground" data-testid="eval-failures">
                      {selectedMetrics.failures.map((f) => (
                        <li key={f.projectId}>
                          <span className="font-mono">{f.projectId}</span>：{f.error}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <p className="py-4 text-center text-sm text-muted-foreground" data-testid="eval-running">
                {selected.status === 'failed'
                  ? '本次运行失败，未产生指标。'
                  : '评测进行中：指标将在运行完成后展示（每 2 秒自动刷新）。'}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function MetricCard(props: { testId: string; label: string; value: string; hint: string }) {
  return (
    <div className="rounded-md border p-3" data-testid={props.testId}>
      <div className="text-xs text-muted-foreground">{props.label}</div>
      <div className="mt-1 font-mono text-lg font-semibold">{props.value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{props.hint}</div>
    </div>
  )
}
