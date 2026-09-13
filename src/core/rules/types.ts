import ts from 'typescript'
import type { Category, FindingDraft, Severity } from '@/core/contracts/findings'
import type { AnalyzedFile } from '@/core/index/analyzer'
import { nodeLineRange, quoteLines, enclosingSymbol } from '@/core/index/analyzer'

export type StaticFinding = FindingDraft & {
  ruleId: string
  fingerprint: string
  /** true → evidenceStatus=needs_review（候选，待人工核查） */
  needsReview: boolean
}

export interface RuleContext {
  file: AnalyzedFile
  /** 导入时等长脱敏记录的区间（疑似密钥候选） */
  redactedRanges: Array<{ line: number; start: number; end: number }>
}

export interface FindingInput {
  ruleId: string
  node?: ts.Node
  lineRange?: [number, number]
  title: string
  category: Category
  severity: Severity
  confidence: number
  condition: string
  impact: string
  reasoningSummary: string
  recommendation: string
  needsReview?: boolean
  related?: Array<{ node: ts.Node }>
}

/** 构造带真实引文的静态 finding；指纹 = rule + path + 行段（去重键） */
export function makeFinding(ctx: RuleContext, input: FindingInput): StaticFinding {
  const { file } = ctx
  const range = input.lineRange ?? nodeLineRange(file, input.node!)
  const quote = quoteLines(file, range[0], range[1])
  const symbol = input.node ? enclosingSymbol(file, input.node.getStart(file.sourceFile)) : null
  const finding: StaticFinding = {
    title: input.title,
    category: input.category,
    severity: input.severity,
    confidence: input.confidence,
    primary: { path: file.path, startLine: range[0], endLine: range[1], quote },
    related: (input.related ?? []).map((r) => {
      const range = nodeLineRange(file, r.node)
      return {
        path: file.path,
        startLine: range[0],
        endLine: range[1],
        quote: quoteLines(file, range[0], range[1]),
      }
    }),
    condition: input.condition,
    impact: input.impact,
    reasoningSummary: input.reasoningSummary,
    recommendation: input.recommendation,
    guidelineChunkIds: [],
    symbol: symbol?.name,
    ruleId: input.ruleId,
    fingerprint: `static:${input.ruleId}:${file.path}:${range[0]}-${range[1]}`,
    needsReview: input.needsReview ?? false,
  }
  return finding
}

/** 相邻（行段重叠/紧邻）的同规则同路径 finding 合并为一个（规格 9.3 去重） */
export function dedupeStaticFindings(findings: StaticFinding[]): StaticFinding[] {
  const byKey = new Map<string, StaticFinding[]>()
  for (const f of findings) {
    const key = `${f.ruleId}:${f.primary.path}`
    byKey.set(key, [...(byKey.get(key) ?? []), f])
  }
  const result: StaticFinding[] = []
  for (const [, group] of byKey) {
    group.sort((a, b) => a.primary.startLine - b.primary.startLine)
    let current: StaticFinding | null = null
    for (const f of group) {
      if (
        current &&
        f.primary.startLine <= current.primary.endLine
      ) {
        // 覆盖行段重叠：保留首个（行号更小），扩展行段
        current.primary.endLine = Math.max(current.primary.endLine, f.primary.endLine)
        current.primary.quote = quoteJoin(current.primary.quote, f.primary.quote)
        current.fingerprint = `static:${f.ruleId}:${f.primary.path}:${current.primary.startLine}-${current.primary.endLine}`
      } else {
        if (current) result.push(current)
        current = { ...f, primary: { ...f.primary } }
      }
    }
    if (current) result.push(current)
  }
  return result.sort(
    (a, b) =>
      a.primary.path.localeCompare(b.primary.path) || a.primary.startLine - b.primary.startLine,
  )
}

function quoteJoin(a: string, b: string): string {
  return a === b ? a : `${a}\n${b}`
}
