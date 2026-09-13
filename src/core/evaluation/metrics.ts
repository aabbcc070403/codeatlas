import type { Category } from '@/core/contracts/findings'
import type { MetricSummary, MetricValue } from '@/core/contracts/evaluation'

/**
 * 评测指标（规格 13 / R08）：
 * - Precision = TP/(TP+FP)，Recall = TP/(TP+FN)，F1 调和平均；分母为零显示 N/A（null）。
 * - 匹配：文件 + 标注行段相交 + 类别一致为候选，再做一对一匹配（确定性贪心）。
 * - 重复报警额外计 FP（未匹配到的候选全部计入 FP）。
 * - 无效引用（引文与快照行不符）单列计数，但仍计入 FP，不丢弃美化。
 */

/** 人工标注（manifest annotations） */
export interface MetricAnnotation {
  file: string
  category: Category
  startLine: number
  endLine: number
  ruleId?: string
  symbol?: string
  condition?: string
}

/** 检测候选（来自扫描 findings） */
export interface MetricCandidate {
  path: string
  category: Category
  startLine: number
  endLine: number
  ruleId?: string | null
  source?: string
  /** 引文校验失败（与快照真实行不符）——true 时不参与匹配、直接计 FP */
  invalidCitation?: boolean
}

export interface MatchPair {
  candidateIndex: number
  annotationIndex: number
}

export interface MatchResult {
  pairs: MatchPair[]
  unmatchedCandidates: number[]
  unmatchedAnnotations: number[]
  /** 有效候选中，与「已被占用的标注」兼容却未匹配的数量（重复报警） */
  duplicateCount: number
}

function rangesIntersect(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart <= bEnd && bStart <= aEnd
}

/** 候选与标注是否兼容（文件 + 行段相交 + 类别一致） */
export function isCompatible(
  candidate: MetricCandidate,
  annotation: MetricAnnotation,
): boolean {
  if (candidate.path !== annotation.file) return false
  if (candidate.category !== annotation.category) return false
  return rangesIntersect(
    candidate.startLine,
    candidate.endLine,
    annotation.startLine,
    annotation.endLine,
  )
}

/**
 * 确定性一对一贪心匹配：
 * 1) 枚举全部兼容 (candidate, annotation) 对（无效引文候选不参与）；
 * 2) 按 (距离 |起点差|, candidate 键序, annotation 键序) 稳定排序；
 * 3) 依序占用双方均未配对的组合。
 * 相同输入永远产出相同配对（测试固定行为）。
 */
export function matchFindings(
  annotations: MetricAnnotation[],
  candidates: MetricCandidate[],
): MatchResult {
  const invalid = new Set<number>()
  const pool: number[] = []
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i]!.invalidCitation) invalid.add(i)
    else pool.push(i)
  }

  type Edge = { c: number; a: number; distance: number }
  const edges: Edge[] = []
  for (const ci of pool) {
    const candidate = candidates[ci]!
    for (let ai = 0; ai < annotations.length; ai++) {
      const annotation = annotations[ai]!
      if (isCompatible(candidate, annotation)) {
        edges.push({ c: ci, a: ai, distance: Math.abs(candidate.startLine - annotation.startLine) })
      }
    }
  }
  edges.sort((x, y) => {
    if (x.distance !== y.distance) return x.distance - y.distance
    const cx = candidates[x.c]!
    const cy = candidates[y.c]!
    const keyX = `${cx.path}|${cx.startLine}|${cx.endLine}|${cx.ruleId ?? ''}|${x.c}`
    const keyY = `${cy.path}|${cy.startLine}|${cy.endLine}|${cy.ruleId ?? ''}|${y.c}`
    if (keyX !== keyY) return keyX < keyY ? -1 : 1
    const ax = annotations[x.a]!
    const ay = annotations[y.a]!
    const keyAx = `${ax.file}|${ax.startLine}|${ax.endLine}|${x.a}`
    const keyAy = `${ay.file}|${ay.startLine}|${ay.endLine}|${y.a}`
    return keyAx === keyAy ? 0 : keyAx < keyAy ? -1 : 1
  })

  const takenCandidate = new Set<number>()
  const takenAnnotation = new Set<number>()
  const pairs: MatchPair[] = []
  for (const edge of edges) {
    if (takenCandidate.has(edge.c) || takenAnnotation.has(edge.a)) continue
    takenCandidate.add(edge.c)
    takenAnnotation.add(edge.a)
    pairs.push({ candidateIndex: edge.c, annotationIndex: edge.a })
  }

  const unmatchedCandidates = pool.filter((i) => !takenCandidate.has(i))
  const unmatchedAnnotations = annotations
    .map((_, i) => i)
    .filter((i) => !takenAnnotation.has(i))

  // 重复报警：与任一「已配对标注」兼容却未配对的有效候选
  let duplicateCount = 0
  for (const ci of unmatchedCandidates) {
    const candidate = candidates[ci]!
    const hitsTaken = pairs.some(
      (p) => p.candidateIndex !== ci && isCompatible(candidate, annotations[p.annotationIndex]!),
    )
    if (hitsTaken) duplicateCount++
  }

  return { pairs, unmatchedCandidates, unmatchedAnnotations, duplicateCount }
}

function ratio(numerator: number, denominator: number): MetricValue {
  if (denominator <= 0) return null // 分母为零 → N/A
  return numerator / denominator
}

/** 单项目指标（手算表见 tests/unit/evaluation-metrics.test.ts） */
export function computeProjectMetrics(
  annotations: MetricAnnotation[],
  candidates: MetricCandidate[],
): MetricSummary {
  const { pairs, unmatchedCandidates, duplicateCount } = matchFindings(annotations, candidates)
  const tp = pairs.length
  // 全部未匹配候选计入 FP：含重复报警、类别/位置不符、以及无效引文候选（不丢弃）
  const fp = unmatchedCandidates.length + candidates.filter((c) => c.invalidCitation).length
  const fn = Math.max(0, annotations.length - tp)
  const invalidCitations = candidates.filter((c) => c.invalidCitation).length
  const precision = ratio(tp, tp + fp)
  const recall = ratio(tp, tp + fn)
  const f1: MetricValue =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null
  return {
    tp,
    fp,
    fn,
    precision,
    recall,
    f1,
    annotationCount: annotations.length,
    candidateCount: candidates.length,
    duplicates: duplicateCount,
    invalidCitations,
    evidenceValidRate:
      candidates.length > 0
        ? (candidates.length - invalidCitations) / candidates.length
        : null,
  }
}

/** 跨项目聚合：先求和再计算派生指标（不做项目间平均掩盖） */
export function aggregateMetrics(
  perProject: MetricSummary[],
): MetricSummary {
  const sum = (pick: (m: MetricSummary) => number): number =>
    perProject.reduce((acc, m) => acc + pick(m), 0)
  const tp = sum((m) => m.tp)
  const fp = sum((m) => m.fp)
  const fn = sum((m) => m.fn)
  const candidateCount = sum((m) => m.candidateCount)
  const invalidCitations = sum((m) => m.invalidCitations)
  const precision = ratio(tp, tp + fp)
  const recall = ratio(tp, tp + fn)
  const f1: MetricValue =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null
  return {
    tp,
    fp,
    fn,
    precision,
    recall,
    f1,
    annotationCount: sum((m) => m.annotationCount),
    candidateCount,
    duplicates: sum((m) => m.duplicates),
    invalidCitations,
    evidenceValidRate:
      candidateCount > 0 ? (candidateCount - invalidCitations) / candidateCount : null,
  }
}

/** 线性插值百分位（升序样本；空样本 → N/A） */
export function percentile(values: number[], q: number): MetricValue {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 1) return sorted[0]!
  const pos = (sorted.length - 1) * q
  const lower = Math.floor(pos)
  const upper = Math.ceil(pos)
  if (lower === upper) return sorted[lower]!
  const frac = pos - lower
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * frac
}

export function formatMetric(value: MetricValue, digits = 3): string {
  if (value === null) return 'N/A'
  return value.toFixed(digits)
}
