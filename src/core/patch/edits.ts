import { createHash } from 'node:crypto'
import {
  MAX_PATCH_CHANGED_LINES,
  type PatchEdit,
} from '@/core/contracts/patch'
import type { RedactedRange } from '@/server/db/schema'
import { normalizeLf } from '@/core/review/validate'

/**
 * 补丁编辑校验链（规格 9.5 / R06，全部服务端执行）：
 * - 仅单文件，且必须是快照内真实存在的文件（禁止创建/删除文件）；
 * - 禁止修改锁文件（导出补丁不应触碰依赖清单）；
 * - baseFileHash 必须与快照文件 content_hash 一致（过期基线拒绝）；
 * - expectedOldText 与快照行统一 LF 后逐字符严格匹配（复用 review/validate 思路）；
 * - 行范围合法（1 起始、start ≤ end、不越过文件末尾）；
 * - 编辑互不重叠；
 * - 总变更行数 ≤ 200（口径：Σ max(旧行数, 新行数)）；
 * - 命中脱敏区间（含 diff 上下文邻域）的编辑拒绝，避免导出补丁携带脱敏占位、
 *   应用到真实文件时破坏真实凭证（规格 8）。
 *
 * 本模块只读快照内容，绝不修改任何存储数据。
 */

export interface PatchTargetFile {
  path: string
  content: string
  contentHash: string
  lineCount: number
  redactedRanges: RedactedRange[]
}

/** 快照内容的 sha256（与导入侧同口径，供测试与校验使用） */
export function sha256OfContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

const LOCK_FILE_RE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock)$|(^|\/)[^/]*\.lock$|(^|\/)[^/]*-lock\.(json|yaml|yml)$/i

/** 锁文件路径：补丁禁止触碰（规格 9.5「改锁文件」禁止项） */
export function isLockfilePath(path: string): boolean {
  return LOCK_FILE_RE.test(path)
}

/** diff 上下文行数（与 diff.ts 生成 unified diff 的 context 一致） */
export const DIFF_CONTEXT_LINES = 3

export interface EditsValidation {
  ok: boolean
  /** 全部拒绝原因（不截断，供修复轮与 UI 展示） */
  reasons: string[]
  /** 通过校验后的编辑（按 startLine 升序） */
  ordered: PatchEdit[]
}

/**
 * 校验单文件编辑列表。输入假定已通过 patchEditListSchema（单文件约束），
 * 这里负责面向快照内容的全部业务校验。
 */
export function validateEdits(edits: PatchEdit[], file: PatchTargetFile): EditsValidation {
  const reasons: string[] = []

  // 仅单文件且必须就是目标文件（禁止创建/删除文件：目标不存在时调用方不会走到这里）
  const paths = new Set(edits.map((e) => e.path))
  if (paths.size !== 1) {
    reasons.push(`补丁只能修改单个文件（收到 ${paths.size} 个）`)
  } else if (edits.length > 0 && edits[0]!.path !== file.path) {
    reasons.push(`编辑路径与目标文件不一致: ${edits[0]!.path} ≠ ${file.path}`)
  }
  if (isLockfilePath(file.path)) {
    reasons.push('禁止修改锁文件')
  }

  // 过期基线：baseFileHash 必须与快照文件哈希一致
  const stale = edits.filter((e) => e.baseFileHash !== file.contentHash)
  if (stale.length > 0) {
    reasons.push(
      `baseFileHash 与快照文件不一致（过期基线）: ${stale[0]!.baseFileHash.slice(0, 12)}… ≠ ${file.contentHash.slice(0, 12)}…`,
    )
  }

  const lines = file.content.split('\n')
  for (const edit of edits) {
    // 行范围合法
    if (edit.startLine > edit.endLine) {
      reasons.push(`行范围非法: ${edit.startLine} > ${edit.endLine}`)
      continue
    }
    if (edit.endLine > file.lineCount) {
      reasons.push(`行段越界: ${edit.startLine}-${edit.endLine}（共 ${file.lineCount} 行）`)
      continue
    }
    // 旧文本与快照行严格匹配（统一 LF 后逐字符比较）
    const actual = lines.slice(edit.startLine - 1, edit.endLine).join('\n')
    if (normalizeLf(edit.expectedOldText) !== actual) {
      reasons.push(`旧文本与快照行不匹配: ${file.path}:${edit.startLine}-${edit.endLine}`)
    }
  }

  // 编辑互不重叠（按 startLine 排序后相邻比较）
  const sorted = [...edits].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!
    const cur = sorted[i]!
    if (cur.startLine <= prev.endLine) {
      reasons.push(`编辑行区间重叠: ${prev.startLine}-${prev.endLine} 与 ${cur.startLine}-${cur.endLine}`)
      break
    }
  }

  // 脱敏区间：编辑行段（扩展 diff 上下文邻域）命中即拒绝
  for (const edit of edits) {
    const from = Math.max(1, edit.startLine - DIFF_CONTEXT_LINES)
    const to = Math.min(file.lineCount, edit.endLine + DIFF_CONTEXT_LINES)
    const hit = file.redactedRanges.find((r) => r.line >= from && r.line <= to)
    if (hit) {
      reasons.push(
        `编辑命中脱敏区间（第 ${hit.line} 行），禁止导出（避免应用补丁时破坏真实凭证）`,
      )
      break
    }
  }

  // 总变更行数 ≤ 200（Σ max(旧行数, 新行数)，保守口径）
  let changed = 0
  for (const edit of edits) {
    const oldCount = edit.endLine - edit.startLine + 1
    const newCount = edit.replacementText === '' ? 0 : normalizeLf(edit.replacementText).split('\n').length
    changed += Math.max(oldCount, newCount)
  }
  if (changed > MAX_PATCH_CHANGED_LINES) {
    reasons.push(`总变更行数 ${changed} 超过上限 ${MAX_PATCH_CHANGED_LINES}`)
  }

  return {
    ok: reasons.length === 0,
    reasons,
    ordered: sorted,
  }
}
