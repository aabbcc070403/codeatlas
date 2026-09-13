'use client'

import { useMemo } from 'react'
import { ExternalLink, Link2, ShieldQuestion } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { FindingDraft } from '@/core/contracts/findings'

/**
 * 证据面板（R05 拆分）：触发条件/影响/依据/建议 + 主引用/相关引用/规范引用。
 * 规范来源（标题/版本/来源 URL）必须来自保存的 citation snapshot（scan_citations）；
 * 无快照的 chunk id 标记「待核查」，不作为可信来源展示。
 */

export interface GuidelineCitationInfo {
  chunkId: string
  title: string
  version: number
  sourceUrl: string | null
}

export interface EvidencePanelProps {
  draft: FindingDraft
  /** 扫描时保存的规范引用快照（scan_citations）：标题/版本/来源 URL 的唯一可信来源 */
  guidelineCitations: GuidelineCitationInfo[]
  /** 引用定位：切换代码区查看目标行段 */
  onLocate: (ref: { path: string; startLine: number; endLine: number }) => void
  /** 当前查看的引用（用于“点击定位”提示） */
  viewing: { path: string } | null
}

export function EvidencePanel({ draft, guidelineCitations, onLocate, viewing }: EvidencePanelProps) {
  const citationIndex = useMemo(
    () => new Map(guidelineCitations.map((c) => [c.chunkId, c])),
    [guidelineCitations],
  )
  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold leading-snug">{draft.title}</h2>
      <div className="space-y-1 text-sm">
        <Field label="触发条件" value={draft.condition} />
        <Field label="影响" value={draft.impact} />
        <Field label="风险依据" value={draft.reasoningSummary} />
        <Field label="修复建议" value={draft.recommendation} />
      </div>

      {/* 主引用 */}
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">主引用</p>
        <button
          className="w-full rounded-md border bg-background px-2 py-1.5 text-left font-mono text-xs hover:bg-accent"
          onClick={() => onLocate(draft.primary)}
        >
          {draft.primary.path}:{draft.primary.startLine}-{draft.primary.endLine}
          {viewing?.path !== draft.primary.path && (
            <span className="text-muted-foreground">（点击定位）</span>
          )}
        </button>
      </div>

      {/* 相关引用 */}
      {draft.related.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">相关引用</p>
          <ul className="space-y-1">
            {draft.related.map((r, i) => (
              <li key={i}>
                <button
                  className="w-full rounded-md border bg-background px-2 py-1.5 text-left font-mono text-xs hover:bg-accent"
                  onClick={() => onLocate(r)}
                >
                  <Link2 className="mr-1 inline h-3 w-3" />
                  {r.path}:{r.startLine}-{r.endLine}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 规范引用：标题/版本/来源来自 citation snapshot；无快照 → 待核查 */}
      {draft.guidelineChunkIds.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">规范引用（扫描时检索快照）</p>
          <ul className="space-y-1.5">
            {draft.guidelineChunkIds.map((chunkId) => {
              const citation = citationIndex.get(chunkId) ?? null
              if (!citation) {
                return (
                  <li
                    key={chunkId}
                    className="flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-500/5 px-2 py-1.5 font-mono text-[11px] text-amber-800 dark:border-amber-800 dark:text-amber-300"
                  >
                    <ShieldQuestion className="h-3 w-3 shrink-0" />
                    <span className="truncate" title={chunkId}>
                      {chunkId}
                    </span>
                    <Badge variant="warning" className="ml-auto shrink-0">
                      来源快照缺失/待核查
                    </Badge>
                  </li>
                )
              }
              return (
                <li key={chunkId} className="rounded-md border bg-background px-2 py-1.5 text-xs">
                  <p className="truncate font-medium" title={citation.title}>
                    {citation.title}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                    <span>版本 v{citation.version}</span>
                    {citation.sourceUrl && (
                      <a
                        href={citation.sourceUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-0.5 hover:underline"
                      >
                        来源
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </p>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{value}</p>
    </div>
  )
}
