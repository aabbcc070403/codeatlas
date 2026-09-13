'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useScanEvents } from './scan-events'
import { ToolTimeline } from './tool-timeline'
import {
  ArrowLeft,
  Ban,
  CircleAlert,
  FileWarning,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Wifi,
  WifiOff,
} from 'lucide-react'
import type { CoverageInfo, RiskInfo, UsageInfo } from '@/core/contracts/scan'
import type { FindingListItem, ScanSummary } from '@/server/queries/scans'

/* ---------------- API 形状（与 GET /api/scans/:id 真实返回一致，共享于 server/queries/scans.ts） ---------------- */

export type ScanApiBody = ScanSummary
export type { FindingListItem }

const TERMINAL = ['completed', 'partial', 'failed', 'cancelled']

const STAGES = ['ingest', 'index', 'static', 'ai', 'validate', 'report'] as const

const SEVERITY_LABEL: Record<string, string> = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
  info: '提示',
}
const SEVERITY_BADGE: Record<string, 'destructive' | 'warning' | 'info' | 'muted' | 'secondary'> = {
  critical: 'destructive',
  high: 'destructive',
  medium: 'warning',
  low: 'info',
  info: 'muted',
}
const CATEGORY_LABEL: Record<string, string> = {
  security: '安全',
  correctness: '正确性',
  performance: '性能',
  maintainability: '可维护性',
}
const SOURCE_LABEL: Record<string, string> = {
  static: '静态规则',
  ai: 'AI 审查',
  combined: '静态+AI',
}
const FEEDBACK_LABEL: Record<string, string> = {
  unreviewed: '未复核',
  confirmed: '已确认',
  false_positive: '误报',
}

function statusBadgeVariant(status: string): 'success' | 'warning' | 'destructive' | 'muted' | 'secondary' {
  if (status === 'completed') return 'success'
  if (status === 'partial') return 'warning'
  if (status === 'failed') return 'destructive'
  if (status === 'cancelled') return 'muted'
  return 'secondary'
}
const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  completed: '已完成',
  partial: '局部完成',
  failed: '失败',
  cancelled: '已取消',
}

/** 扫描工作台：状态/风险/覆盖/阶段进度 + 问题筛选列表 + 工具轨迹（R02 静态闭环） */
export function ScanWorkbench({
  scanId,
  projectId,
  projectName,
  initial,
  initialFindings,
}: {
  scanId: string
  projectId: string
  projectName: string
  initial: ScanApiBody
  initialFindings: FindingListItem[]
}) {
  const [scan, setScan] = useState(initial.scan)
  const [severityCounts, setSeverityCounts] = useState(initial.severityCounts)
  const [toolCalls, setToolCalls] = useState(initial.toolCalls)
  const [cancelRequested, setCancelRequested] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const refreshSeq = useRef(0)

  const isTerminal = TERMINAL.includes(scan.status)

  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current
    try {
      const res = await fetch(`/api/scans/${scanId}`)
      if (!res.ok) return
      const body = (await res.json()) as ScanApiBody
      if (seq !== refreshSeq.current) return
      setScan(body.scan)
      setSeverityCounts(body.severityCounts)
      setToolCalls(body.toolCalls)
    } catch {
      /* 网络错误：下个事件/轮询再试 */
    }
  }, [scanId])

  const mode = useScanEvents(scanId, { enabled: !isTerminal, onRefresh: refresh })
  // 首次挂载即刷新一次，避免服务端渲染后 worker 已推进
  useEffect(() => {
    void refresh()
  }, [refresh])

  async function cancelScan() {
    setCancelling(true)
    try {
      await fetch(`/api/scans/${scanId}/cancel`, { method: 'POST' })
      setCancelRequested(true)
      void refresh()
    } catch {
      /* 网络错误时按钮恢复 */
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4 px-4 py-6">
      {/* 头部：返回 / 状态 / 阶段 / 取消 */}
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/projects/${projectId}`} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          返回「{projectName}」
        </Link>
        <Badge variant={statusBadgeVariant(scan.status)}>
          {STATUS_LABEL[scan.status] ?? scan.status}
        </Badge>
        {!isTerminal && (
          <Badge variant="secondary" className="gap-1">
            {mode === 'sse' && <Wifi className="h-3 w-3" />}
            {mode === 'polling' && <WifiOff className="h-3 w-3" />}
            {mode === 'sse' ? '实时推送' : mode === 'polling' ? '轮询降级' : '连接中'}
          </Badge>
        )}
        {scan.errorText && (
          <span className="truncate text-sm text-destructive" title={scan.errorText}>
            {scan.errorText}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {isTerminal && (
            <div className="flex items-center gap-1 text-xs" data-testid="export-links">
              <span className="hidden text-muted-foreground sm:inline">导出报告</span>
              <a
                data-testid="export-json"
                className="rounded-md border px-2 py-1 transition-colors hover:bg-accent"
                href={`/api/scans/${scanId}/export?format=json`}
              >
                JSON
              </a>
              <a
                data-testid="export-markdown"
                className="rounded-md border px-2 py-1 transition-colors hover:bg-accent"
                href={`/api/scans/${scanId}/export?format=markdown`}
              >
                Markdown
              </a>
              <a
                data-testid="export-html"
                className="rounded-md border px-2 py-1 transition-colors hover:bg-accent"
                href={`/api/scans/${scanId}/export?format=html`}
              >
                HTML
              </a>
            </div>
          )}
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
          {!isTerminal && (
            <Button variant="outline" size="sm" onClick={() => void cancelScan()} disabled={cancelling || cancelRequested}>
              {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
              {cancelRequested ? '已请求取消' : '取消扫描'}
            </Button>
          )}
        </div>
      </div>

      {/* 取消过渡态 */}
      {cancelRequested && !isTerminal && (
        <Card>
          <CardContent className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            已请求取消：worker 将在当前阶段边界停止，已持久化的结果会保留。
          </CardContent>
        </Card>
      )}

      {/* 阶段进度 */}
      <Card>
        <CardContent className="py-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {STAGES.map((s, i) => {
              const currentIdx = STAGES.indexOf(scan.stage as (typeof STAGES)[number])
              const done = isTerminal || (currentIdx > -1 && i < currentIdx)
              const active = !isTerminal && scan.stage === s
              return (
                <span key={s} className="flex items-center gap-2">
                  {i > 0 && <span className="text-muted-foreground/40">→</span>}
                  <span
                    className={`rounded-md border px-2 py-1 ${
                      done
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                        : active
                          ? 'border-sky-300 bg-sky-50 text-sky-700'
                          : 'border-border text-muted-foreground'
                    }`}
                  >
                    {s}
                    {done && ' ✓'}
                    {active && '…'}
                  </span>
                </span>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* 风险 + 覆盖 */}
      <div className="grid gap-4 md:grid-cols-2">
        <RiskPanel risk={scan.risk} severityCounts={severityCounts} />
        <CoveragePanel coverage={scan.coverage} usage={scan.usage} scan={scan} />
      </div>

      {/* 问题列表 */}
      <FindingsPanel scanId={scanId} scanStatus={scan.status} initialItems={initialFindings} />

      {/* 工具轨迹：仅工具名、输入摘要、耗时、状态（不显示内部思维链/结果原文）；
          空轨迹区分纯静态/AI 跳过/AI 未完成，词法降级按真实结果摘要识别 */}
      <ToolTimeline toolCalls={toolCalls} coverage={scan.coverage} usage={scan.usage} />
    </div>
  )
}

/* ---------------- 风险面板 ---------------- */

function RiskPanel({
  risk,
  severityCounts,
}: {
  risk: RiskInfo | null
  severityCounts: ScanApiBody['severityCounts']
}) {
  const bySeverity = useMemo(() => {
    const m: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
    for (const r of severityCounts) {
      if (r.feedback === 'false_positive') continue
      m[r.severity] = (m[r.severity] ?? 0) + r.c
    }
    return m
  }, [severityCounts])
  const needsReview = useMemo(
    () => severityCounts.filter((r) => r.evidenceStatus === 'needs_review' && r.feedback !== 'false_positive').reduce((a, r) => a + r.c, 0),
    [severityCounts],
  )

  if (!risk) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          风险指标尚未生成（扫描进行中或已取消）。
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="text-sm font-medium">风险指数</span>
          <span
            className={`text-3xl font-semibold ${
              risk.riskIndex >= 60 ? 'text-destructive' : risk.riskIndex >= 25 ? 'text-amber-600' : 'text-emerald-600'
            }`}
          >
            {risk.riskIndex}
          </span>
          <span className="text-xs text-muted-foreground">{risk.formula}</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(SEVERITY_LABEL) as Array<keyof typeof SEVERITY_LABEL>).map((sev) =>
            bySeverity[sev] ? (
              <Badge key={sev} variant={SEVERITY_BADGE[sev]}>
                {SEVERITY_LABEL[sev]} {bySeverity[sev]}
              </Badge>
            ) : null,
          )}
        </div>
        <div className="flex flex-wrap gap-1.5 text-xs">
          <Badge variant="outline">
            <CircleAlert className="mr-1 h-3 w-3" />
            待核查 {needsReview}（不进入风险指数）
          </Badge>
          {risk.falsePositives > 0 && <Badge variant="muted">误报标记 {risk.falsePositives}（已剔除）</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">{risk.note}</p>
      </CardContent>
    </Card>
  )
}

/* ---------------- 覆盖面板 ---------------- */

function CoveragePanel({
  coverage,
  usage,
  scan,
}: {
  coverage: CoverageInfo | null
  usage: UsageInfo | null
  scan: ScanApiBody['scan']
}) {
  if (!coverage) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">覆盖统计尚未生成。</CardContent>
      </Card>
    )
  }
  const ai = coverage.ai
  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-sm font-medium">覆盖</span>
          <Badge variant="outline">文件 {coverage.totalFiles}</Badge>
          <Badge variant="outline">可分析 {coverage.analyzableFiles}</Badge>
          <Badge variant="outline">静态检查 {coverage.staticCheckedFiles}</Badge>
          <Badge variant="outline">忽略 {coverage.ignoredFiles}</Badge>
          {coverage.parseFailedFiles > 0 && <Badge variant="warning">解析失败 {coverage.parseFailedFiles}</Badge>}
        </div>
        <div className="space-y-1.5 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-purple-700">AI 审查</span>
            {!ai.enabled ? (
              <Badge variant="muted">未启用（仅本地静态规则，未外发代码）</Badge>
            ) : (
              <>
                <Badge variant={ai.completed ? 'ai' : 'warning'}>{ai.completed ? '完成' : '未完成'}</Badge>
                {ai.degradedReason && <Badge variant="muted">降级：{ai.degradedReason}</Badge>}
                <Badge variant="outline">选中 {ai.selectedFiles.length} / 读取 {ai.readFiles.length} 文件</Badge>
                {ai.notReadCount > 0 && <Badge variant="muted">未读取 {ai.notReadCount}</Badge>}
              </>
            )}
          </div>
          <p className="text-muted-foreground">{ai.selectionBasis}</p>
          {usage && (usage.modelCalls > 0 || usage.toolCalls > 0) && (
            <p className="text-muted-foreground">
              模型请求 {usage.modelCalls} 次 · 工具调用 {usage.toolCalls} 次
              {usage.inputTokensMeasured !== null && ` · 输入 token（实测）${usage.inputTokensMeasured}`}
              {usage.outputTokensMeasured !== null && ` · 输出 token（实测）${usage.outputTokensMeasured}`}
              {usage.provider === 'mock' && '（Mock provider，非真实模型）'}
            </p>
          )}
          {scan.modelId && <p className="text-muted-foreground">模型：{scan.modelId}</p>}
          <p className="text-muted-foreground">
            规则版本 {scan.ruleVersion} · 提示词版本 {scan.promptVersion}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

/* ---------------- 问题列表面板 ---------------- */

const FILTER_OPTIONS = {
  severity: ['critical', 'high', 'medium', 'low', 'info'] as const,
  category: ['security', 'correctness', 'performance', 'maintainability'] as const,
  source: ['static', 'ai', 'combined'] as const,
  feedback: ['unreviewed', 'confirmed', 'false_positive'] as const,
}

function FindingsPanel({
  scanId,
  scanStatus,
  initialItems,
}: {
  scanId: string
  scanStatus: string
  initialItems: FindingListItem[]
}) {
  const [filters, setFilters] = useState<Record<string, string[]>>({})
  const [items, setItems] = useState<FindingListItem[] | null>(initialItems)
  const [error, setError] = useState<string | null>(null)

  const queryString = useMemo(() => {
    const parts: string[] = []
    for (const [k, v] of Object.entries(filters)) {
      if (v.length > 0) parts.push(`${k}=${v.join(',')}`)
    }
    return parts.length > 0 ? `?${parts.join('&')}` : ''
  }, [filters])

  // 轮询任务状态（等 findings 生成）+ 过滤变化即拉取
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch(`/api/scans/${scanId}/findings${queryString}`)
        if (!res.ok) throw new Error('加载问题列表失败')
        const body = (await res.json()) as { items: FindingListItem[] }
        if (!cancelled) {
          setItems(body.items)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载失败')
      }
    }
    void load()
    // 扫描未终态时每 2 秒刷新（与 SSE/轮询叠加最多造成一次多余请求，保证列表最终一致）
    if (!TERMINAL.includes(scanStatus)) {
      const timer = setInterval(load, 2000)
      return () => {
        cancelled = true
        clearInterval(timer)
      }
    }
    return () => {
      cancelled = true
    }
  }, [scanId, queryString, scanStatus])

  const toggleFilter = (key: string, value: string) => {
    setFilters((prev) => {
      const cur = prev[key] ?? []
      const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]
      return { ...prev, [key]: next }
    })
  }

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          <span className="text-sm font-medium">问题列表</span>
          {(Object.keys(FILTER_OPTIONS) as Array<keyof typeof FILTER_OPTIONS>).map((key) => (
            <span key={key} className="flex flex-wrap items-center gap-1">
              <span className="text-muted-foreground">
                {{ severity: '严重度', category: '类别', source: '来源', feedback: '反馈' }[key]}：
              </span>
              {FILTER_OPTIONS[key].map((v) => {
                const active = (filters[key] ?? []).includes(v)
                const label =
                  key === 'severity'
                    ? SEVERITY_LABEL[v]
                    : key === 'category'
                      ? CATEGORY_LABEL[v]
                      : key === 'source'
                        ? SOURCE_LABEL[v]
                        : FEEDBACK_LABEL[v]
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => toggleFilter(key, v)}
                    className={`rounded-full border px-2 py-0.5 transition-colors ${
                      active ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:border-foreground/30'
                    }`}
                  >
                    {label}
                  </button>
                )
              })}
            </span>
          ))}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {items === null && !error && (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> 加载问题…
          </p>
        )}
        {items !== null && items.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <ShieldCheck className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm font-medium">当前条件下未显示问题</p>
            <p className="text-xs text-muted-foreground">
              静态规则与 AI 均为启发式检查，未检出问题不代表代码安全。
            </p>
          </div>
        )}
        {items !== null && items.length > 0 && (
          <ul className="divide-y">
            {items.map((f) => (
              <li key={f.id}>
                <Link
                  href={`/scans/${scanId}/findings/${f.id}`}
                  className="flex flex-wrap items-center gap-2 rounded-md px-2 py-2 transition-colors hover:bg-accent"
                >
                  <Badge variant={SEVERITY_BADGE[f.severity] ?? 'secondary'}>{SEVERITY_LABEL[f.severity] ?? f.severity}</Badge>
                  <span className="min-w-0 flex-1 basis-48 truncate text-sm font-medium">{f.title}</span>
                  <Badge variant="outline">{CATEGORY_LABEL[f.category] ?? f.category}</Badge>
                  <Badge variant={f.source === 'static' ? 'secondary' : 'ai'}>{SOURCE_LABEL[f.source] ?? f.source}</Badge>
                  {f.evidenceStatus === 'needs_review' && <Badge variant="warning">待核查</Badge>}
                  {f.feedback === 'confirmed' && <Badge variant="success">已确认</Badge>}
                  {f.feedback === 'false_positive' && <Badge variant="muted">误报</Badge>}
                  <span className="font-mono text-xs text-muted-foreground">
                    {f.path}:{f.startLine}-{f.endLine}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {items !== null && items.length >= 100 && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <FileWarning className="h-3 w-3" /> 仅显示前 100 条，可用筛选缩小范围。
          </p>
        )}
      </CardContent>
    </Card>
  )
}
