import { createTwoFilesPatch } from 'diff'

/**
 * unified diff 生成（规格 6/9.5）：使用 `diff` 包在内存中对基线与补丁后文本
 * 生成 unified diff。上下文 3 行（与 edits.ts 的脱敏邻域检查一致）。
 * 不触碰文件系统、不修改快照原件。
 */

export const DIFF_CONTEXT = 3

export interface UnifiedDiffOptions {
  /** 自定义页眉说明（写入 diff 的 ---/+++ 行尾，如基线哈希摘要） */
  header?: string
}

/** 生成 `a/<path>` → `b/<path>` 的 unified diff 文本 */
export function makeUnifiedDiff(path: string, baseline: string, patched: string, opts: UnifiedDiffOptions = {}): string {
  const header = opts.header ?? ''
  return createTwoFilesPatch(
    `a/${path}`,
    `b/${path}`,
    baseline,
    patched,
    header,
    header,
    { context: DIFF_CONTEXT },
  )
}

/**
 * 提案可下载判据（A02 收紧）：可应用 且 语法状态为 pass（基线干净且补丁后干净）。
 * - fail（补丁引入基线不存在的语法错误）不可下载；
 * - baseline_failed（基线已有语法错误，无法证明补丁不引入新错误）同样不可下载，
 *   不得作为已验证提案；
 * - not_checkable（未进行语法比较）不可下载。
 */
export function isDownloadable(validation: { applicable: boolean; syntax: string }): boolean {
  return validation.applicable && validation.syntax === 'pass'
}
