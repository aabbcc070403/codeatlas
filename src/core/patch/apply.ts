import { normalizeLf } from '@/core/review/validate'
import type { PatchEdit } from '@/core/contracts/patch'

/**
 * 内存副本应用（规格 9.5）：把已通过校验链的编辑应用到快照文本的
 * 内存副本，产出补丁后文本。**绝不写入快照存储**——存储层只读。
 *
 * 行语义与导入/证据校验一致：content.split('\n')；区间 [startLine, endLine]
 * 为 1 起始闭区间；replacementText === '' 表示删除该区间行。
 * 多段编辑按行区间降序应用，与输入顺序无关。
 */
export function applyEdits(content: string, edits: PatchEdit[]): string {
  if (edits.length === 0) return content
  const lines = content.split('\n')
  const ordered = [...edits].sort(
    (a, b) => b.startLine - a.startLine || b.endLine - a.endLine,
  )
  for (const edit of ordered) {
    const replacement =
      edit.replacementText === '' ? [] : normalizeLf(edit.replacementText).split('\n')
    // 先删后插：splice 一步完成区间替换（降序应用不受前面编辑影响）
    lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...replacement)
  }
  return lines.join('\n')
}
