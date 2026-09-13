'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Download, FileDiff, Loader2, ShieldAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { PatchValidation } from '@/core/contracts/patch'

/**
 * 补丁提案面板（R06）：生成按钮（提交中/超时/限额/失败状态）、前后 diff 展示
 * （逐行着色 +/−/上下文，长行在容器内横向滚动，不撑破布局）、三项验证状态分开显示
 * （应用校验 applicable / 语法校验 syntax / 测试恒为 not_run 并提示自行测试）、
 * 有效提案提供下载按钮（无效提案不给下载）。刷新后从 GET 恢复既有提案。
 * 全部纯文本渲染（无 innerHTML/dangerouslySetInnerHTML）。
 */

interface PatchInfo {
  id: string
  baseFileHash: string
  diffText: string
  validation: PatchValidation
  status: string
  note?: string | null
}

interface GenerateResponse {
  status: 'proposed' | 'invalid' | 'existing'
  patch: { id: string; baseFileHash: string; diffText: string; validation: PatchValidation; note: string | null }
  reasons: string[]
  usage: { provider: string; modelCalls: number } | null
}

type ErrorState = { code: string; message: string } | null

const SYNTAX_LABEL: Record<PatchValidation['syntax'], { badge: string; text: string; ok: boolean }> = {
  pass: { badge: '语法可用', text: '通过（基线与补丁后均无语法错误）', ok: true },
  fail: { badge: '语法退化', text: '未通过（引入基线不存在的新语法错误）', ok: false },
  baseline_failed: { badge: '语法未验证', text: '基线已有语法错误，无法证明补丁未引入新错误（保守不可下载）', ok: false },
  not_checkable: { badge: '语法未比较', text: '未进行语法比较', ok: false },
}

/** 解析 unified diff 文本为逐行分类（+ 添加 / − 删除 / 上下文 / 头部） */
type DiffLineKind = 'add' | 'del' | 'context' | 'meta'
function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('@@')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

const LINE_CLASS: Record<DiffLineKind, string> = {
  add: 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
  del: 'bg-red-500/10 text-red-800 dark:text-red-300',
  context: 'text-muted-foreground',
  meta: 'text-muted-foreground/70',
}
const LINE_PREFIX: Record<DiffLineKind, string> = { add: '+', del: '−', context: ' ', meta: ' ' }

export function PatchDiffPanel({ findingId }: { findingId: string }) {
  const [patch, setPatch] = useState<PatchInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<ErrorState>(null)

  // 刷新后从 GET 恢复既有提案（与当前快照文件哈希绑定）
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/findings/${findingId}/patch`)
      .then(async (res) => {
        if (!res.ok) return
        const body = (await res.json()) as { patch: PatchInfo | null }
        if (!cancelled) setPatch(body.patch)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [findingId])

  const generate = useCallback(async () => {
    if (generating) return
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch(`/api/findings/${findingId}/patch`, { method: 'POST' })
      if (res.ok) {
        const body = (await res.json()) as GenerateResponse
        setPatch({
          id: body.patch.id,
          baseFileHash: body.patch.baseFileHash,
          diffText: body.patch.diffText ?? '',
          validation: body.patch.validation,
          status: body.status,
          note: body.patch.note,
        })
      } else {
        const body = (await res.json().catch(() => null)) as
          | { error?: { code?: string; message?: string } }
          | null
        setError({
          code: body?.error?.code ?? 'internal_error',
          message:
            body?.error?.message ??
            (res.status === 504
              ? '补丁提案生成超时'
              : res.status === 429
                ? '预算耗尽，稍后再试'
                : res.status === 503
                  ? 'AI 未配置，无法生成补丁提案'
                  : '补丁提案生成失败，稍后再试'),
        })
      }
    } catch {
      setError({ code: 'network', message: '网络错误，请重试' })
    } finally {
      setGenerating(false)
    }
  }, [findingId, generating])

  const diffLines = useMemo(
    () => (patch?.diffText ? patch.diffText.split('\n') : []),
    [patch],
  )
  // A02：与下载路由 isDownloadable 同判据——仅 pass（基线干净且补丁后干净）可下载；
  // baseline_failed（无法证明不退化）不提供下载入口
  const downloadable = patch ? patch.validation.applicable && patch.validation.syntax === 'pass' : false

  return (
    <div className="space-y-2" data-testid="patch-panel">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <FileDiff className="h-3.5 w-3.5" />
          修复补丁提案（单文件）
        </p>
        <p className="text-[11px] text-muted-foreground">≤2 次模型请求 · 60s</p>
      </div>

      <Button
        size="sm"
        variant="outline"
        className="w-full"
        data-testid="patch-generate"
        disabled={generating}
        onClick={() => void generate()}
      >
        {generating ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            生成中（≤60s）
          </>
        ) : (
          '生成补丁提案'
        )}
      </Button>
      <p className="text-[11px] text-muted-foreground">
        提案只在内存副本中应用并生成 diff，不会修改快照原件，也不会写入任何仓库。
      </p>

      {error && (
        <div className="flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error.message}</span>
        </div>
      )}

      {loading && !patch && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> 加载提案…
        </p>
      )}

      {patch && (
        <div className="space-y-2" data-testid="patch-proposal">
          {/* Mock 标签：持久化在 validationJson，刷新后仍如实标注 */}
          {patch.validation.provider === 'mock' && (
            <Badge variant="warning" className="gap-1">
              <ShieldAlert className="h-3 w-3" />
              Mock 示例提案，非真实 AI 修复
            </Badge>
          )}

          {/* 三项验证状态分开显示：applicable / syntax / tests=not_run */}
          <ul className="space-y-1 text-xs">
            <li className="flex items-center gap-1.5" data-testid="patch-status-applicable">
              <Badge variant={patch.validation.applicable ? 'success' : 'destructive'}>
                {patch.validation.applicable ? '可应用' : '不可应用'}
              </Badge>
              <span className="text-muted-foreground">旧文本匹配快照行（applicable）</span>
            </li>
            <li className="flex items-center gap-1.5" data-testid="patch-status-syntax">
              <Badge variant={SYNTAX_LABEL[patch.validation.syntax].ok ? 'success' : 'destructive'}>
                {SYNTAX_LABEL[patch.validation.syntax].badge}
              </Badge>
              <span className="text-muted-foreground">
                {SYNTAX_LABEL[patch.validation.syntax].text}
                （基线 {patch.validation.baselineSyntaxErrors} → 补丁后 {patch.validation.patchedSyntaxErrors}）
              </span>
            </li>
            <li className="flex items-center gap-1.5" data-testid="patch-status-tests">
              <Badge variant="muted">测试</Badge>
              <span className="text-muted-foreground">not_run（未执行任何测试）——请在你的环境中自行测试</span>
            </li>
          </ul>

          {patch.validation.reasons.length > 0 && (
            <ul className="space-y-0.5 rounded-md border border-red-300 bg-red-500/5 px-2 py-1.5 text-[11px] text-red-700 dark:border-red-800 dark:text-red-300">
              {patch.validation.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}

          {patch.note && (
            <p className="rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground">{patch.note}</p>
          )}

          {/* 前后 diff：逐行着色；长行在容器内横向滚动，不撑破布局 */}
          <div className="overflow-x-auto rounded-md border bg-background" data-testid="patch-diff">
            <pre className="w-max min-w-full font-mono text-[11px] leading-4">
              {diffLines.map((line, i) => {
                const kind = classifyDiffLine(line)
                return (
                  <div key={i} className={`whitespace-pre px-2 ${LINE_CLASS[kind]}`}>
                    <span className="select-none pr-1 text-muted-foreground/50">{LINE_PREFIX[kind]}</span>
                    {line === '' ? ' ' : line}
                  </div>
                )
              })}
            </pre>
          </div>

          {downloadable ? (
            <a
              href={`/api/patches/${patch.id}/download`}
              data-testid="patch-download"
              className={cn(buttonVariants({ size: 'sm' }), 'w-full')}
            >
              <Download className="h-3.5 w-3.5" />
              下载 .patch
            </a>
          ) : (
            <p className="text-[11px] text-muted-foreground">提案未通过校验，无法下载。</p>
          )}
        </div>
      )}
    </div>
  )
}
