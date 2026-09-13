import type { FindingDraft } from '@/core/contracts/findings'

/**
 * 去重与合并（规格 9.3）：
 * - AI 内部去重：相同规范化路径 + 重叠行范围 + 相同 category 归组（无 ruleId）。
 * - 跨源合并：AI finding 与 static finding 同路径同 category 行段重叠 → combined
 *   （保留静态确定性结论，合并 AI 的依据与规范引用，不额外建行）。
 * - 禁止仅靠标题相似自动合并不同风险。
 */

export interface ExistingStaticFinding {
  findingId: string
  ruleId: string | null
  fingerprint: string
  path: string
  startLine: number
  endLine: number
  category: string
}

export interface AiFindingPlan {
  /** 直接插入的新 AI finding */
  inserts: Array<{ draft: FindingDraft; fingerprint: string }>
  /** 与静态 finding 合并（更新既有行） */
  merges: Array<{
    findingId: string
    draft: FindingDraft
    guidelineChunkIds: string[]
  }>
}

function overlaps(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1]
}

export function planAiFindings(
  drafts: FindingDraft[],
  existingStatic: ExistingStaticFinding[],
): AiFindingPlan {
  const inserts: AiFindingPlan['inserts'] = []
  const merges: AiFindingPlan['merges'] = []
  const usedStaticIds = new Set<string>()
  const aiRanges = new Map<string, Array<[number, number, string]>>() // path → [start, end, category]

  // 按严重程度排序（保持确定序）
  const ordered = [...drafts].sort(
    (a, b) =>
      a.primary.path.localeCompare(b.primary.path) ||
      a.primary.startLine - b.primary.startLine ||
      a.category.localeCompare(b.category),
  )

  for (const draft of ordered) {
    const path = draft.primary.path
    const range: [number, number] = [draft.primary.startLine, draft.primary.endLine]

    // AI 内部去重：同路径重叠行段 + 同 category
    const sameGroup = (aiRanges.get(path) ?? []).find(
      ([s, e, cat]) => overlaps(range, [s, e]) && cat === draft.category,
    )
    if (sameGroup) continue

    // 跨源合并：静态 finding 同路径同 category 行段重叠
    const staticMatch = existingStatic.find(
      (s) =>
        !usedStaticIds.has(s.findingId) &&
        s.path === path &&
        s.category === draft.category &&
        overlaps(range, [s.startLine, s.endLine]),
    )
    if (staticMatch) {
      usedStaticIds.add(staticMatch.findingId)
      merges.push({
        findingId: staticMatch.findingId,
        draft,
        guidelineChunkIds: draft.guidelineChunkIds,
      })
    } else {
      aiRanges.set(path, [
        ...(aiRanges.get(path) ?? []),
        [range[0], range[1], draft.category],
      ])
      inserts.push({
        draft,
        fingerprint: `ai:${draft.category}:${path}:${range[0]}-${range[1]}`,
      })
    }
  }
  return { inserts, merges }
}
