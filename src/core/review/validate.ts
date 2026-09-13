import { z } from 'zod'
import { findingDraftSchema, type FindingDraft } from '@/core/contracts/findings'
import type { SnapshotFileIndex } from './tools'

/**
 * 证据校验（规格 9.3 / R04）：所有引文必须来自当前脱敏快照的真实行段，
 * 统一 LF 后**逐字符严格匹配**（不再接受首尾空白差异的宽松匹配）；
 * 引用范围必须被模型**实际读取的行段完全覆盖**（区间合并后整体包含，
 * 不允许仅有交集）；primary/related 引用与规范引用无效均记录原因。
 */

export const submitFindingsInput = z.object({
  findings: z.array(findingDraftSchema).max(20),
})
export type SubmitFindingsInput = z.infer<typeof submitFindingsInput>

export interface ValidationContext {
  /** 快照文件（内容与行数） */
  files: Map<string, SnapshotFileIndex>
  /** 模型通过工具实际读取的行段 */
  readLineRanges: Map<string, Array<[number, number]>>
  /** 本轮实际检索返回的规范块 id（R04：retrieve_guidelines 白名单，非全部可访问） */
  accessibleChunkIds: Set<string>
}

export interface DraftValidation {
  draft: FindingDraft
  valid: boolean
  errors: string[]
}

/** 统一换行：CRLF/CR → LF（快照内容已标准化，模型输出需再规范化） */
export function normalizeLf(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * 严格引文校验（validator 与 scanner 共用实现）：
 * 取快照 [startLine, endLine] 的行，与 quote 统一 LF 后逐字符比较。
 */
export function matchesQuote(
  content: string,
  startLine: number,
  endLine: number,
  quote: string,
): boolean {
  const lines = content.split('\n').slice(startLine - 1, endLine)
  return normalizeLf(quote) === lines.join('\n')
}

/** 合并重叠/相邻区间：[[1,50],[51,100],[200,210]] → [[1,100],[200,210]] */
export function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: Array<[number, number]> = [[sorted[0]![0], sorted[0]![1]]]
  for (const [s, e] of sorted.slice(1)) {
    const last = merged[merged.length - 1]!
    if (s <= last[1] + 1) {
      // 重叠或相邻（读到 1-50 与 51-100 等价于完整读 1-100）
      last[1] = Math.max(last[1], e)
    } else {
      merged.push([s, e])
    }
  }
  return merged
}

/** [start,end] 是否被合并后的读取区间完全覆盖（仅交集不算读过） */
export function isFullyCovered(
  start: number,
  end: number,
  mergedRanges: Array<[number, number]>,
): boolean {
  let cursor = start
  for (const [s, e] of mergedRanges) {
    if (e < cursor) continue
    if (s > cursor) return false // cursor 到 s 之间未读
    cursor = e + 1
    if (cursor > end) return true
  }
  return cursor > end
}

/** 校验单个引用：行段合法 + 引文严格匹配 + 读取范围完整覆盖 */
export function validateCodeRef(
  ref: { path: string; startLine: number; endLine: number; quote: string },
  files: Map<string, SnapshotFileIndex>,
  readLineRanges: Map<string, Array<[number, number]>>,
  requireRead: boolean,
): string[] {
  const errors: string[] = []
  const file = files.get(ref.path)
  if (!file) {
    return [`路径不在快照内: ${ref.path}`]
  }
  if (ref.startLine < 1 || ref.endLine < ref.startLine || ref.endLine > file.lineCount) {
    errors.push(`行段越界: ${ref.path}:${ref.startLine}-${ref.endLine}（共 ${file.lineCount} 行）`)
    return errors
  }
  if (!matchesQuote(file.content, ref.startLine, ref.endLine, ref.quote)) {
    errors.push(`引文与快照行不匹配: ${ref.path}:${ref.startLine}`)
  }
  if (requireRead) {
    const ranges = readLineRanges.get(ref.path) ?? []
    const covered = isFullyCovered(ref.startLine, ref.endLine, mergeRanges(ranges))
    if (!covered) {
      errors.push(`引用了未完整读取的内容: ${ref.path}:${ref.startLine}-${ref.endLine}`)
    }
  }
  return errors
}

export function validateDraft(
  draft: FindingDraft,
  ctx: ValidationContext,
): DraftValidation {
  const errors: string[] = []
  errors.push(...validateCodeRef(draft.primary, ctx.files, ctx.readLineRanges, true))
  for (const related of draft.related) {
    const relatedErrors = validateCodeRef(related, ctx.files, ctx.readLineRanges, true)
    if (relatedErrors.length > 0) {
      errors.push(`related 无效（已忽略）: ${relatedErrors[0]}`)
    }
  }
  for (const chunkId of draft.guidelineChunkIds) {
    if (!ctx.accessibleChunkIds.has(chunkId)) {
      errors.push(`规范引用无效（本轮未检索返回）: ${chunkId}`)
    }
  }
  return { draft: { ...draft, related: draft.related.filter((r) => validateCodeRef(r, ctx.files, ctx.readLineRanges, true).length === 0) }, valid: errors.length === 0, errors }
}

/** 批量校验：无效草稿剔除（保留错误清单供结构修复） */
export function validateDrafts(
  drafts: FindingDraft[],
  ctx: ValidationContext,
): { valid: FindingDraft[]; invalid: Array<{ draft: FindingDraft; errors: string[] }> } {
  const valid: FindingDraft[] = []
  const invalid: Array<{ draft: FindingDraft; errors: string[] }> = []
  for (const draft of drafts) {
    const result = validateDraft(draft, ctx)
    if (result.valid) valid.push(result.draft)
    else invalid.push({ draft: result.draft, errors: result.errors })
  }
  return { valid, invalid }
}
