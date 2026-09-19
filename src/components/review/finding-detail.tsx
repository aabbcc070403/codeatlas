'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ArrowLeft, Check, FileWarning, Loader2, RotateCcw, X } from 'lucide-react'
import type { RiskInfo } from '@/core/contracts/scan'
import type {
  FindingDetailRow,
  FindingListItem,
  SnapshotFileContent,
} from '@/server/queries/scans'
import { ConversationPanel } from './conversation-panel'
import { EvidencePanel, type GuidelineCitationInfo } from './evidence-panel'
import { PatchDiffPanel } from './patch-diff'

/* ---------------- API 形状（共享于 server/queries/scans.ts） ---------------- */

type FindingApiBody = FindingDetailRow
type FileApiBody = SnapshotFileContent

const SEVERITY_LABEL: Record<string, string> = { critical: '严重', high: '高', medium: '中', low: '低', info: '提示' }
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
const SOURCE_LABEL: Record<string, string> = { static: '静态规则', ai: 'AI 审查', combined: '静态+AI' }

type Tab = 'list' | 'code' | 'evidence'

/**
 * 问题详情工作台（R02/R05）：左问题列表（260px）/ 中只读代码（min-width:0）/
 * 右证据+追问面板（360px）；1024px 以下以「问题 / 代码 / 解释」标签切换。
 * 服务端预取 initial* 首屏直出；反馈成功后用 PATCH 返回的风险摘要更新展示；
 * 追问消息刷新后从 GET messages 恢复；引用定位失败标记「证据无效/待核查」。
 */
export function FindingDetail({
  findingId,
  scanId,
  projectName,
  initialFinding = null,
  initialSnapshotId = null,
  initialFile = null,
  initialRisk = null,
  initialGuidelineCitations = [],
}: {
  findingId: string
  scanId: string
  projectName: string
  initialFinding?: FindingApiBody | null
  initialSnapshotId?: string | null
  initialFile?: FileApiBody | null
  initialRisk?: RiskInfo | null
  initialGuidelineCitations?: GuidelineCitationInfo[]
}) {
  const router = useRouter()
  const [finding, setFinding] = useState<FindingApiBody | null>(initialFinding)
  const [snapshotId, setSnapshotId] = useState<string | null>(initialSnapshotId)
  const [file, setFile] = useState<FileApiBody | null>(initialFile)
  const [fileError, setFileError] = useState<string | null>(null)
  const [risk, setRisk] = useState<RiskInfo | null>(initialRisk)
  const [viewing, setViewing] = useState<{ path: string; startLine: number; endLine: number } | null>(
    initialFinding
      ? {
          path: initialFinding.draft.primary.path,
          startLine: initialFinding.draft.primary.startLine,
          endLine: initialFinding.draft.primary.endLine,
        }
      : null,
  )
  const [list, setList] = useState<FindingListItem[]>([])
  const [tab, setTab] = useState<Tab>('code')
  const [feedbackPending, setFeedbackPending] = useState(false)
  const [feedbackError, setFeedbackError] = useState<string | null>(null)
  /** 引用定位失败的路径集合：文件不在快照/加载失败/行段越界（追问引用标「待核查」） */
  const [failedPaths, setFailedPaths] = useState<Set<string>>(new Set())
  const codeAnchorRef = useRef<HTMLTableRowElement | null>(null)
  const codeScrollRef = useRef<HTMLDivElement | null>(null)
  /** 服务端已预取的问题 id：仅首次挂载跳过客户端重复拉取 */
  const prefetchedFindingId = useRef<string | null>(initialFinding?.id ?? null)
  /** 服务端已预取的主引用文件（快照内容不可变，可跨 viewing 切换复用） */
  const prefetchedFile = useRef<FileApiBody | null>(initialFile)

  // 问题详情 + 扫描（快照 id / 风险摘要）
  useEffect(() => {
    if (prefetchedFindingId.current === findingId) return
    let cancelled = false
    setFinding(null)
    setFile(null)
    setFileError(null)
    setViewing(null)
    fetch(`/api/findings/${findingId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('问题不存在或无权访问')
        const body = (await res.json()) as FindingApiBody
        if (cancelled) return
        setFinding(body)
        setViewing({
          path: body.draft.primary.path,
          startLine: body.draft.primary.startLine,
          endLine: body.draft.primary.endLine,
        })
        const scanRes = await fetch(`/api/scans/${body.scanId}`)
        if (!scanRes.ok) return
        const scanBody = (await scanRes.json()) as {
          scan: { snapshotId: string; risk: RiskInfo | null }
        }
        if (!cancelled) {
          setSnapshotId(scanBody.scan.snapshotId)
          setRisk(scanBody.scan.risk)
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setFileError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [findingId])

  // 问题列表（左栏）
  useEffect(() => {
    let cancelled = false
    fetch(`/api/scans/${scanId}/findings?limit=100`)
      .then(async (res) => {
        if (!res.ok) return
        const body = (await res.json()) as { items: FindingListItem[] }
        if (!cancelled) setList(body.items)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [scanId])

  // 代码内容（跟随 viewing）；服务端预取的主引用文件直接复用（快照内容不可变）
  useEffect(() => {
    if (!snapshotId || !viewing) return
    if (prefetchedFile.current?.path === viewing.path) {
      setFile(prefetchedFile.current)
      setFileError(null)
      markPathValidity(prefetchedFile.current, viewing)
      return
    }
    let cancelled = false
    setFile(null)
    setFileError(null)
    fetch(`/api/snapshots/${snapshotId}/files?path=${encodeURIComponent(viewing.path)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('代码不可用（文件不在快照内或已被清理）')
        const body = (await res.json()) as FileApiBody
        if (!cancelled) {
          setFile(body)
          markPathValidity(body, viewing)
        }
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setFileError(e.message)
          setFailedPaths((prev) => new Set(prev).add(viewing.path))
        }
      })
    return () => {
      cancelled = true
    }
  }, [snapshotId, viewing])

  /** 行段越界或加载失败 → 路径进入无效集合；恢复正常则移除 */
  const markPathValidity = (body: FileApiBody, target: { path: string; endLine: number }) => {
    setFailedPaths((prev) => {
      const invalid = body.lineCount < target.endLine
      const has = prev.has(target.path)
      if (invalid && !has) return new Set(prev).add(target.path)
      if (!invalid && has) {
        const next = new Set(prev)
        next.delete(target.path)
        return next
      }
      return prev
    })
  }

  // 定位到 primary 起始行
  useEffect(() => {
    const container = codeScrollRef.current
    const anchor = codeAnchorRef.current
    if (file && container && anchor && container.clientHeight > 0) {
      const offset = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top
      container.scrollTop += offset - container.clientHeight / 2 + anchor.clientHeight / 2
    }
  }, [file, viewing, tab])

  const locateCode = useCallback((ref: { path: string; startLine: number; endLine: number }) => {
    setViewing(ref)
    setTab('code')
  }, [])

  /** 当前查看文件中的相关引用行段 */
  const relatedRangesInViewing = useMemo(() => {
    if (!finding || !viewing) return []
    return finding.draft.related
      .filter((r) => r.path === viewing.path)
      .map((r) => [r.startLine, r.endLine] as [number, number])
  }, [finding, viewing])

  const submitFeedback = useCallback(
    async (feedback: 'confirmed' | 'false_positive' | 'unreviewed') => {
      if (!finding) return
      setFeedbackPending(true)
      setFeedbackError(null)
      try {
        const res = await fetch(`/api/findings/${finding.id}/feedback`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ feedback }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          throw new Error(body?.error?.message ?? '反馈保存失败，请重试')
        } else {
          const body = (await res.json()) as { id: string; feedback: typeof feedback; risk: RiskInfo }
          setFinding({ ...finding, feedback: body.feedback })
          setRisk(body.risk)
        }
      } catch (err) {
        setFeedbackError(err instanceof Error ? err.message : '网络异常，反馈未保存，请重试')
      } finally {
        setFeedbackPending(false)
      }
    },
    [finding],
  )

  if (!finding && fileError) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <FileWarning className="h-10 w-10 text-muted-foreground/40" />
            <p className="font-medium">{fileError}</p>
            <Link href={`/scans/${scanId}`} className="text-sm text-primary hover:underline">
              返回扫描
            </Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] min-w-0 flex-col overflow-hidden">
      {/* 顶栏 */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-card px-4 py-2">
        <Link href={`/scans/${scanId}`} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          返回「{projectName}」扫描
        </Link>
        {finding && (
          <>
            <Badge variant={SEVERITY_BADGE[finding.draft.severity] ?? 'muted'}>
              {SEVERITY_LABEL[finding.draft.severity] ?? finding.draft.severity}
            </Badge>
            <Badge variant="outline">{CATEGORY_LABEL[finding.draft.category] ?? finding.draft.category}</Badge>
            <Badge variant={finding.source === 'static' ? 'secondary' : 'ai'}>
              {SOURCE_LABEL[finding.source] ?? finding.source}
            </Badge>
            {finding.evidenceStatus === 'needs_review' && <Badge variant="warning">待核查</Badge>}
            {finding.feedback === 'confirmed' && <Badge variant="success">已确认</Badge>}
            {finding.feedback === 'false_positive' && <Badge variant="muted">误报</Badge>}
          </>
        )}
        {/* 1024px 以下标签切换 */}
        <div className="ml-auto flex gap-1 xl:hidden">
          {(['list', 'code', 'evidence'] as Tab[]).map((t) => (
            <Button key={t} size="sm" aria-pressed={tab === t} variant={tab === t ? 'default' : 'ghost'} onClick={() => setTab(t)}>
              {{ list: '问题', code: '代码', evidence: '解释' }[t]}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_380px]">
        {/* 左：问题列表 */}
        <aside className={`${tab === 'list' ? 'block' : 'hidden'} min-h-0 min-w-0 overflow-auto overscroll-contain border-r bg-card xl:block`}>
          <p className="px-3 pt-3 text-xs text-muted-foreground">共 {list.length} 项（前 100）</p>
          <ul>
            {list.map((f) => (
              <li key={f.id}>
                <button
                  className={`flex w-full flex-wrap items-center gap-1.5 border-b px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${
                    f.id === findingId ? 'bg-accent' : ''
                  }`}
                  onClick={() => router.replace(`/scans/${scanId}/findings/${f.id}`)}
                >
                  <Badge variant={SEVERITY_BADGE[f.severity] ?? 'muted'} className="shrink-0">
                    {SEVERITY_LABEL[f.severity] ?? f.severity}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate">{f.title}</span>
                  <span className="w-full truncate font-mono text-[11px] text-muted-foreground">
                    {f.path}:{f.startLine}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        {/* 中：只读代码 */}
        <section className={`${tab === 'code' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-col overflow-hidden xl:flex`}>
          {viewing && (
            <div className="flex items-center gap-2 border-b bg-card px-3 py-1.5 text-xs text-muted-foreground">
              <span className="truncate font-mono">{viewing.path}</span>
              <Badge variant="secondary" className="shrink-0">
                定位 {viewing.startLine}-{viewing.endLine}
              </Badge>
              {finding?.draft.related.some((r) => r.path === viewing.path) && (
                <Badge variant="info" className="shrink-0">
                  含相关引用
                </Badge>
              )}
            </div>
          )}
          <div ref={codeScrollRef} className="min-h-0 flex-1 overflow-auto overscroll-contain" data-testid="code-scroll">
            {!finding && (
              <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> 加载问题…
              </p>
            )}
            {finding && fileError && (
              <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
                <FileWarning className="h-8 w-8 text-muted-foreground/40" />
                {fileError}
              </div>
            )}
            {finding && file && viewing && (
              <table className="w-full border-collapse font-mono text-[13px] leading-6">
                <tbody>
                  {file.content.split('\n').map((line, i) => {
                    const lineNo = i + 1
                    const inPrimary = lineNo >= viewing.startLine && lineNo <= viewing.endLine
                    const inRelated = relatedRangesInViewing.some(([s, e]) => lineNo >= s && lineNo <= e)
                    const redacted = file.redactedRanges.some((r) => r.line === lineNo)
                    return (
                      <tr
                        key={lineNo}
                        ref={lineNo === viewing.startLine ? codeAnchorRef : undefined}
                        className={
                          inPrimary
                            ? 'bg-red-500/10'
                            : inRelated
                              ? 'bg-sky-500/10'
                              : redacted
                                ? 'bg-amber-500/5'
                                : undefined
                        }
                      >
                        <td className="w-12 select-none border-r px-2 py-0 text-right align-top text-muted-foreground/60">
                          {lineNo}
                        </td>
                        <td className="whitespace-pre px-2 py-0">{line === '' ? ' ' : line}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {/* 右：证据面板 + 追问 */}
        <aside className={`${tab === 'evidence' ? 'block' : 'hidden'} min-h-0 min-w-0 overflow-auto overscroll-contain border-l bg-card [overflow-wrap:anywhere] xl:block`}>
          {finding ? (
            <div className="space-y-4 p-4">
              <EvidencePanel
                draft={finding.draft}
                guidelineCitations={initialGuidelineCitations}
                viewing={viewing}
                onLocate={locateCode}
              />
              <p className="text-xs text-muted-foreground">
                evidence={finding.evidenceStatus}：仅代表代码引用有效，不代表漏洞已证实。
              </p>
              {finding.ruleId && <p className="font-mono text-xs text-muted-foreground">规则：{finding.ruleId}</p>}

              {/* 追问：历史消息 + 输入（刷新后从 GET messages 恢复） */}
              <div className="border-t pt-3">
                <ConversationPanel findingId={finding.id} onCite={locateCode} invalidPaths={failedPaths} />
              </div>

              {/* 修复补丁提案：diff + 三项验证状态（R06，刷新后从 GET 恢复） */}
              <div className="border-t pt-3">
                <PatchDiffPanel findingId={finding.id} />
              </div>

              {/* 人工反馈 + 风险摘要（PATCH 返回重算结果实时更新） */}
              <div className="space-y-2 border-t pt-3">
                <p className="text-xs font-medium text-muted-foreground">人工反馈</p>
                {feedbackError && <p role="alert" className="text-sm text-destructive">{feedbackError}</p>}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant={finding.feedback === 'confirmed' ? 'default' : 'outline'} disabled={feedbackPending} onClick={() => void submitFeedback('confirmed')}>
                    <Check className="h-3.5 w-3.5" />
                    确认问题
                  </Button>
                  <Button size="sm" variant={finding.feedback === 'false_positive' ? 'default' : 'outline'} disabled={feedbackPending} onClick={() => void submitFeedback('false_positive')}>
                    <X className="h-3.5 w-3.5" />
                    标记误报
                  </Button>
                  <Button size="sm" variant="outline" disabled={feedbackPending || finding.feedback === 'unreviewed'} onClick={() => void submitFeedback('unreviewed')}>
                    <RotateCcw className="h-3.5 w-3.5" />
                    重置
                  </Button>
                </div>
                {risk && (
                  <p className="text-xs text-muted-foreground">
                    扫描风险指数：
                    <span
                      className={`font-semibold ${
                        risk.riskIndex >= 60 ? 'text-destructive' : risk.riskIndex >= 25 ? 'text-amber-600' : 'text-emerald-600'
                      }`}
                      data-testid="risk-index"
                    >
                      {risk.riskIndex}
                    </span>
                    （{risk.formula}；误报 {risk.falsePositives} 条已剔除）
                  </p>
                )}
                <p className="text-xs text-muted-foreground">反馈将实时更新扫描的风险指数。</p>
              </div>
            </div>
          ) : (
            <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> 加载证据…
            </p>
          )}
        </aside>
      </div>
    </div>
  )
}
