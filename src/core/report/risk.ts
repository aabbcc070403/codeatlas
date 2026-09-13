import type { Severity } from '@/core/contracts/findings'
import type { RiskInfo } from '@/core/contracts/scan'
import type { EvidenceStatus, Feedback } from '@/core/contracts/findings'

export interface RiskFindingLike {
  severity: Severity
  evidenceStatus: EvidenceStatus
  feedback: Feedback
}

/**
 * 风险指标（规格 12）：riskIndex = min(100, 20*critical + 10*high + 4*medium + low)
 * 仅计入 evidenceStatus=valid、非 false_positive、非低置信待核查的去重结果；info 不计分。
 */
export function computeRisk(findings: RiskFindingLike[]): RiskInfo {
  const counts: Record<string, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  }
  let countedFindings = 0
  let needsReview = 0
  let falsePositives = 0

  for (const f of findings) {
    if (f.feedback === 'false_positive') {
      falsePositives++
      continue
    }
    if (f.evidenceStatus === 'needs_review') {
      needsReview++
      continue
    }
    counts[f.severity] = (counts[f.severity] ?? 0) + 1
    countedFindings++
  }

  const riskIndex = Math.min(
    100,
    20 * counts.critical! + 10 * counts.high! + 4 * counts.medium! + counts.low!,
  )

  return {
    riskIndex,
    counts,
    countedFindings,
    needsReview,
    falsePositives,
    formula: 'riskIndex = min(100, 20×critical + 10×high + 4×medium + low)',
    note: '仅计入证据有效、非误报、非低置信待核查的去重结果；info 不计分；未按项目规模归一化，不能用于跨项目排名',
  }
}
