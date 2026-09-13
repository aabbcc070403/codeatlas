'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ArrowLeft, ArrowRightLeft, GitCompareArrows, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react'
import { formatTime } from '@/lib/utils'
import type { CompareChangeKind, CompareFindingView, CompareItem, CompareOutcome } from '@/core/report/compare'
import { COMPARE_DISCLAIMER, COMPARE_KIND_LABEL } from '@/core/report/compare'

/**
 * 快照对比客户端（R07）：项目内扫描双选择器、可比性提示条、四类变化列表、
 * 「未再检出 ≠ 已验证修复」固定说明。纯文本渲染（无 innerHTML）。
 */

export interface CompareScanOption {
  id: string
  status: string
  riskIndex: string | null
  createdAt: string
  snapshotCreatedAt: string
  modelId: string | null
  ruleVersion: string
}

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  completed: '已完成',
  partial: '局部完成',
  failed: '失败',
  cancelled: '已取消',
}
const SEVERITY_LABEL: Record<string, string> = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
  info: '提示',
}
const SEVERITY_BADGE: Record<string, 'destructive' | 'warning' | 'info' | 'muted'> = {
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
const EVIDENCE_LABEL: Record<string, string> = {
  valid: '证据有效',
  needs_review: '待核查',
}
const FEEDBACK_LABEL: Record<string, string> = {
  unreviewed: '未复核',
  confirmed: '已确认',
  false_positive: '误报',
}
const KIND_ORDER: CompareChangeKind[] = ['added', 'persisting', 'disappeared', 'incomparable']

function scanLabel(s: CompareScanOption): string {
  return `扫描 ${s.id.slice(0, 8)} · ${STATUS_LABEL[s.status] ?? s.status} · ${formatTime(s.createdAt)} · 规则 ${s.ruleVersion}${s.riskIndex !== null ? ` · 风险 ${s.riskIndex}` : ''}`
}

function FindingBadges({ f }: { f: CompareFindingView }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge variant={SEVERITY_BADGE[f.severity] ?? 'secondary'}>{SEVERITY_LABEL[f.severity] ?? f.severity}</Badge>
      <Badge variant="outline">{CATEGORY_LABEL[f.category] ?? f.category}</Badge>
      <Badge variant={f.source === 'static' ? 'secondary' : 'ai'}>{SOURCE_LABEL[f.source] ?? f.source}</Badge>
      {f.evidenceStatus === 'needs_review' && <Badge variant="warning">{EVIDENCE_LABEL[f.evidenceStatus]}</Badge>}
      {f.feedback === 'confirmed' && <Badge variant="success">{FEEDBACK_LABEL[f.feedback]}</Badge>}
      {f.feedback === 'false_positive' && <Badge variant="muted">{FEEDBACK_LABEL[f.feedback]}</Badge>}
    </span>
  )
}

function FindingLine({ f, prefix }: { f: CompareFindingView; prefix: string }) {
  return (
    <div className="min-w-0 flex-1 basis-64">
      <p className="truncate text-sm font-medium">
        <span className="mr-1 text-xs text-muted-foreground">{prefix}</span>
        {f.title}
      </p>
      <p className="truncate font-mono text-xs text-muted-foreground">
        {f.path}:{f.startLine}-{f.endLine}
      </p>
    </div>
  )
}

function CompareRow({ item }: { item: CompareItem }) {
  const showTarget = item.target !== null && item.kind !== 'persisting'
  return (
    <li className="space-y-1 rounded-md px-2 py-2 hover:bg-accent">
      <div className="flex flex-wrap items-center gap-2">
        {item.base && <FindingLine f={item.base} prefix="旧" />}
        {item.kind === 'persisting' && item.target && (
          <>
            <ArrowRightLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <FindingLine f={item.target} prefix="新" />
          </>
        )}
        {showTarget && <FindingLine f={item.target!} prefix="新" />}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {item.base && <FindingBadges f={item.base} />}
        {showTarget && <FindingBadges f={item.target!} />}
        {item.renamedFrom && (
          <Badge variant="outline">
            文件改名：{item.renamedFrom} → {item.target?.path}
          </Badge>
        )}
        {item.reason && <span className="text-amber-700">{item.reason}</span>}
      </div>
    </li>
  )
}

export function CompareClient({
  projectId,
  projectName,
  scans,
}: {
  projectId: string
  projectName: string
  scans: CompareScanOption[]
}) {
  const [baseId, setBaseId] = useState(scans[0]?.id ?? '')
  const [targetId, setTargetId] = useState(scans[scans.length - 1]?.id ?? '')
  const [result, setResult] = useState<CompareOutcome | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/projects/${projectId}/compare?baseScanId=${encodeURIComponent(baseId)}&targetScanId=${encodeURIComponent(targetId)}`,
      )
      const body = (await res.json().catch(() => null)) as
        | (CompareOutcome & { error?: { message: string } })
        | null
      if (!res.ok) {
        setError(body?.error?.message ?? `对比失败（${res.status}）`)
        setResult(null)
        return
      }
      setResult(body)
    } catch {
      setError('网络错误，请重试')
    } finally {
      setLoading(false)
    }
  }

  const itemsByKind = (kind: CompareChangeKind): CompareItem[] =>
    result?.items.filter((i) => i.kind === kind) ?? []
  const noDirectChanges =
    result !== null &&
    result.counts.added === 0 &&
    result.counts.persisting === 0 &&
    result.counts.disappeared === 0

  return (
    <div className="mx-auto max-w-7xl space-y-4 px-4 py-8">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href={`/projects/${projectId}`}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          返回「{projectName}」
        </Link>
        <h1 className="text-xl font-semibold">快照对比</h1>
      </div>

      {scans.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <GitCompareArrows className="h-10 w-10 text-muted-foreground/40" />
            <p className="font-medium">该项目还没有扫描记录</p>
            <p className="text-sm text-muted-foreground">
              先在项目页上传快照并完成至少一次扫描，才能进行前后对比。
            </p>
            <Link href={`/projects/${projectId}`}>
              <Button variant="outline" size="sm" className="mt-2">
                去项目页
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">选择两次扫描</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">基准扫描（修复前）</span>
                <select
                  data-testid="base-select"
                  value={baseId}
                  onChange={(e) => setBaseId(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm"
                >
                  {scans.map((s) => (
                    <option key={s.id} value={s.id}>
                      {scanLabel(s)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">目标扫描（修复后）</span>
                <select
                  data-testid="target-select"
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm"
                >
                  {scans.map((s) => (
                    <option key={s.id} value={s.id}>
                      {scanLabel(s)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void run()} disabled={loading || !baseId || !targetId} data-testid="compare-run">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitCompareArrows className="h-4 w-4" />}
                {loading ? '对比中…' : '查看对比'}
              </Button>
              <span className="text-xs text-muted-foreground">
                匹配不依赖行号：按规则/类别、路径、符号与去空白代码哈希对应；文件改名仅当整文件内容一致时自动识别。
              </span>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>
        </Card>
      )}

      {result && (
        <>
          {!result.comparable && (
            <div
              data-testid="compare-config-note"
              className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800"
            >
              <p className="flex items-center gap-1.5 font-medium">
                <TriangleAlert className="h-4 w-4" />
                两次扫描的版本配置不同，结果不可直接比较
              </p>
              <ul className="mt-1 list-disc pl-5">
                {result.configDifferences.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
          )}
          {result.scopeNote && (
            <p
              data-testid="compare-scope-note"
              className="rounded-md border px-4 py-3 text-sm text-muted-foreground"
            >
              {result.scopeNote}
            </p>
          )}

          <Card>
            <CardContent className="space-y-3 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">变化摘要</span>
                {KIND_ORDER.map((kind) => (
                  <Badge
                    key={kind}
                    variant={kind === 'disappeared' ? 'success' : kind === 'added' ? 'warning' : kind === 'incomparable' ? 'muted' : 'info'}
                    data-testid={`count-${kind}`}
                  >
                    {COMPARE_KIND_LABEL[kind]} {result.counts[kind]}
                  </Badge>
                ))}
              </div>
              <p
                data-testid="compare-disclaimer"
                className="flex items-start gap-1.5 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground"
              >
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {COMPARE_DISCLAIMER}
              </p>
              {noDirectChanges && (
                <p className="text-sm text-muted-foreground">
                  没有可直接对比的变化结果：两次扫描之间没有可建立一一对应或明确新增/未再检出的条目。
                </p>
              )}
            </CardContent>
          </Card>

          {KIND_ORDER.map((kind) => {
            const items = itemsByKind(kind)
            return (
              <Card key={kind} data-testid={`section-${kind}`}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base" data-testid={`heading-${kind}`}>
                    {COMPARE_KIND_LABEL[kind]}（{items.length}）
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {items.length === 0 ? (
                    <p className="py-2 text-sm text-muted-foreground">
                      {kind === 'incomparable'
                        ? '没有因重复匹配、范围未覆盖或版本不同而无法比较的条目。'
                        : kind === 'disappeared'
                          ? '没有「未再检出」的条目。'
                          : '暂无此类条目。'}
                    </p>
                  ) : (
                    <ul className="divide-y">
                      {items.map((item, idx) => (
                        <CompareRow key={`${item.base?.findingId ?? ''}-${item.target?.findingId ?? ''}-${idx}`} item={item} />
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </>
      )}
    </div>
  )
}
