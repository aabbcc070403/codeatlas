'use client'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import type { CoverageInfo, UsageInfo } from '@/core/contracts/scan'

/**
 * 工具轨迹（R05 拆分）：仅工具名、输入摘要、耗时、状态——不显示内部思维链与结果原文。
 * 空轨迹区分：纯静态扫描 / AI 阶段跳过（未配置）/ AI 阶段未完成 / 没有工具调用；
 * 词法降级从 retrieve_guidelines 的真实结果摘要识别。
 */

export type ScanToolCall = {
  sequence: number
  tool_name: string
  input_summary: string
  result_summary: string
  elapsed_ms: number
  status: string
}

const TOOL_STATUS_LABEL: Record<string, string> = {
  ok: '成功',
  error: '失败',
  budget_exceeded: '预算耗尽',
}
const TOOL_STATUS_BADGE: Record<string, 'success' | 'destructive' | 'warning'> = {
  ok: 'success',
  error: 'destructive',
  budget_exceeded: 'warning',
}

export function ToolTimeline({
  toolCalls,
  coverage,
  usage,
}: {
  toolCalls: ScanToolCall[]
  coverage: CoverageInfo | null
  usage: UsageInfo | null
}) {
  const ai = coverage?.ai
  const aiEnabled = ai?.enabled === true
  const failedCount = toolCalls.filter((t) => t.status !== 'ok').length

  let emptyNote: string
  if (toolCalls.length > 0) {
    emptyNote = ''
  } else if (!aiEnabled) {
    emptyNote = '纯静态扫描在本地完成，不外发代码、无工具调用。'
  } else if (ai?.degradedReason === 'ai_unavailable') {
    emptyNote = 'AI 阶段跳过：AI 未配置，未发起模型与工具调用。'
  } else if (aiEnabled && ai && !ai.completed) {
    emptyNote = `AI 阶段未完成${ai.degradedReason ? `（降级：${ai.degradedReason}）` : ''}，无工具调用记录。`
  } else {
    emptyNote = 'AI 阶段没有产生工具调用记录。'
  }

  return (
    <Card>
      <CardContent className="space-y-2 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">工具轨迹</span>
          {usage && usage.modelCalls > 0 && (
            <Badge variant="outline">模型请求 {usage.modelCalls} 次</Badge>
          )}
          {failedCount > 0 && <Badge variant="destructive">失败 {failedCount} 次</Badge>}
        </div>
        {toolCalls.length === 0 ? (
          <p className="text-xs text-muted-foreground">{emptyNote}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">#</th>
                  <th className="py-1.5 pr-3 font-medium">工具</th>
                  <th className="py-1.5 pr-3 font-medium">输入摘要</th>
                  <th className="py-1.5 pr-3 font-medium">耗时</th>
                  <th className="py-1.5 font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {toolCalls.map((t) => (
                  <tr key={t.sequence} className="border-b last:border-b-0">
                    <td className="py-1.5 pr-3 text-muted-foreground">{t.sequence}</td>
                    <td className="py-1.5 pr-3 font-mono">{t.tool_name}</td>
                    <td
                      className="max-w-md truncate py-1.5 pr-3 font-mono text-muted-foreground"
                      title={t.input_summary}
                    >
                      {t.input_summary}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                      {t.elapsed_ms} ms
                    </td>
                    <td className="py-1.5">
                      <span className="flex flex-wrap items-center gap-1">
                        <Badge variant={TOOL_STATUS_BADGE[t.status] ?? 'secondary'}>
                          {TOOL_STATUS_LABEL[t.status] ?? t.status}
                        </Badge>
                        {t.tool_name === 'retrieve_guidelines' &&
                          t.status === 'ok' &&
                          t.result_summary.includes('lexical_only') && (
                            <Badge variant="warning">词法降级</Badge>
                          )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
