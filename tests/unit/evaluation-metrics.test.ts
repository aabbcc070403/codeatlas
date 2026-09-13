import { describe, expect, it } from 'vitest'
import type { Category } from '../../src/core/contracts/findings'
import {
  aggregateMetrics,
  computeProjectMetrics,
  matchFindings,
  percentile,
  type MetricAnnotation,
  type MetricCandidate,
} from '../../src/core/evaluation/metrics'

/**
 * 手算小型 TP/FP/FN 表（规格 13 / R08）：
 * Precision=TP/(TP+FP)，Recall=TP/(TP+FN)，F1 调和平均；分母为零 N/A（null）；
 * 匹配 = 文件 + 标注行段相交 + 类别一致 → 一对一；重复报警额外计 FP；
 * 无效引用单列计数但仍计入 FP。
 */

function ann(
  file: string,
  startLine: number,
  endLine: number,
  category: Category = 'security',
): MetricAnnotation {
  return { file, category, startLine, endLine, ruleId: 'r/x' }
}

function cand(
  path: string,
  startLine: number,
  endLine: number,
  category: Category = 'security',
  extra: Partial<MetricCandidate> = {},
): MetricCandidate {
  return { path, category, startLine, endLine, ruleId: 'r/x', source: 'static', ...extra }
}

describe('指标公式（手算表）', () => {
  it('全对：2 标注 2 候选一一对应 → TP=2 FP=0 FN=0，P=R=F1=1', () => {
    const annotations = [ann('a.ts', 5, 10), ann('b.ts', 1, 4, 'correctness')]
    const candidates = [cand('a.ts', 5, 10), cand('b.ts', 2, 3, 'correctness')]
    const m = computeProjectMetrics(annotations, candidates)
    expect(m.tp).toBe(2)
    expect(m.fp).toBe(0)
    expect(m.fn).toBe(0)
    expect(m.precision).toBe(1)
    expect(m.recall).toBe(1)
    expect(m.f1).toBe(1)
    expect(m.evidenceValidRate).toBe(1)
  })

  it('漏报：2 标注 1 候选 → TP=1 FP=0 FN=1，P=1，R=0.5，F1=2/3', () => {
    const annotations = [ann('a.ts', 5, 10), ann('b.ts', 1, 4)]
    const candidates = [cand('a.ts', 5, 10)]
    const m = computeProjectMetrics(annotations, candidates)
    expect(m.tp).toBe(1)
    expect(m.fp).toBe(0)
    expect(m.fn).toBe(1)
    expect(m.precision).toBe(1)
    expect(m.recall).toBeCloseTo(0.5)
    expect(m.f1).toBeCloseTo(2 * 1 * 0.5 / 1.5)
  })

  it('误报：1 标注 2 候选（仅 1 个相交） → TP=1 FP=1 FN=0，P=0.5，R=1', () => {
    const annotations = [ann('a.ts', 5, 10)]
    const candidates = [cand('a.ts', 6, 8), cand('z.ts', 1, 2)]
    const m = computeProjectMetrics(annotations, candidates)
    expect(m.tp).toBe(1)
    expect(m.fp).toBe(1)
    expect(m.fn).toBe(0)
    expect(m.precision).toBeCloseTo(0.5)
    expect(m.recall).toBe(1)
  })

  it('类别不一致不算匹配：候选为 FP，标注为 FN', () => {
    const annotations = [ann('a.ts', 5, 10, 'security')]
    const candidates = [cand('a.ts', 5, 10, 'correctness')]
    const m = computeProjectMetrics(annotations, candidates)
    expect(m.tp).toBe(0)
    expect(m.fp).toBe(1)
    expect(m.fn).toBe(1)
    expect(m.precision).toBe(0)
    expect(m.recall).toBe(0)
    expect(m.f1).toBeNull() // P+R=0 → N/A
  })

  it('文件不一致不算匹配（路径必须完全一致）', () => {
    const annotations = [ann('src/a.ts', 5, 10)]
    const candidates = [cand('a.ts', 5, 10)]
    const m = computeProjectMetrics(annotations, candidates)
    expect(m.tp).toBe(0)
    expect(m.fp).toBe(1)
    expect(m.fn).toBe(1)
  })

  it('零分母 → N/A：空标注空候选全为 null', () => {
    const m = computeProjectMetrics([], [])
    expect(m.tp).toBe(0)
    expect(m.fp).toBe(0)
    expect(m.fn).toBe(0)
    expect(m.precision).toBeNull()
    expect(m.recall).toBeNull()
    expect(m.f1).toBeNull()
    expect(m.evidenceValidRate).toBeNull()
  })

  it('零分母 → N/A：有标注无候选 → precision N/A、recall=0、F1 N/A', () => {
    const m = computeProjectMetrics([ann('a.ts', 1, 2)], [])
    expect(m.precision).toBeNull() // TP+FP=0
    expect(m.recall).toBe(0)
    expect(m.f1).toBeNull()
  })

  it('零分母 → N/A：无标注有候选 → precision=0、recall N/A、F1 N/A', () => {
    const m = computeProjectMetrics([], [cand('a.ts', 1, 2)])
    expect(m.precision).toBe(0)
    expect(m.recall).toBeNull() // TP+FN=0
    expect(m.f1).toBeNull()
  })
})

describe('重复报警额外计 FP', () => {
  it('两个候选指向同一标注 → 先匹配为 TP，后到者为重复（FP）', () => {
    const annotations = [ann('a.ts', 5, 10)]
    const candidates = [cand('a.ts', 6, 8), cand('a.ts', 7, 9)]
    const m = computeProjectMetrics(annotations, candidates)
    expect(m.tp).toBe(1)
    expect(m.fp).toBe(1)
    expect(m.fn).toBe(0)
    expect(m.duplicates).toBe(1)
    expect(m.precision).toBeCloseTo(0.5)
    expect(m.recall).toBe(1)
    // 一对一：同一标注只被占用一次
    const match = matchFindings(annotations, candidates)
    expect(match.pairs.length).toBe(1)
  })

  it('两个标注两个重复候选 → TP=2 FP=1（重复额外计）', () => {
    const annotations = [ann('a.ts', 5, 10), ann('a.ts', 30, 40)]
    const candidates = [
      cand('a.ts', 5, 10),
      cand('a.ts', 7, 9), // 与标注 1 兼容但标注已被占用 → 重复
      cand('a.ts', 30, 40),
    ]
    const m = computeProjectMetrics(annotations, candidates)
    expect(m.tp).toBe(2)
    expect(m.fp).toBe(1)
    expect(m.fn).toBe(0)
    expect(m.duplicates).toBe(1)
  })

  it('跨文件重复不算重复（与不同标注各配一个）', () => {
    const annotations = [ann('a.ts', 5, 10), ann('b.ts', 5, 10)]
    const candidates = [cand('a.ts', 5, 10), cand('b.ts', 5, 10)]
    const m = computeProjectMetrics(annotations, candidates)
    expect(m.tp).toBe(2)
    expect(m.duplicates).toBe(0)
    expect(m.fp).toBe(0)
  })
})

describe('无效引用：单列计数但仍计入 FP', () => {
  it('无效引文候选不参与匹配、计入 FP 与 invalidCitations，不丢弃', () => {
    const annotations = [ann('a.ts', 5, 10)]
    const candidates = [
      cand('a.ts', 5, 10, 'security', { invalidCitation: true }), // 引文与快照行不符
      cand('b.ts', 1, 2),
    ]
    const m = computeProjectMetrics(annotations, candidates)
    expect(m.invalidCitations).toBe(1)
    expect(m.tp).toBe(0) // 无效引文不得充当 TP（不美化）
    expect(m.fp).toBe(2) // 原始报警仍参与 FP 统计
    expect(m.fn).toBe(1)
    expect(m.evidenceValidRate).toBeCloseTo(0.5)
    expect(m.precision).toBe(0)
    expect(m.recall).toBe(0)
  })

  it('全部候选引文有效 → 证据有效率 1', () => {
    const m = computeProjectMetrics([ann('a.ts', 1, 2)], [cand('a.ts', 1, 2)])
    expect(m.evidenceValidRate).toBe(1)
    expect(m.invalidCitations).toBe(0)
  })
})

describe('一对一匹配确定性', () => {
  it('相同输入产出相同配对（贪心稳定排序）', () => {
    const annotations = [ann('a.ts', 5, 10), ann('a.ts', 50, 60)]
    const candidates = [
      cand('a.ts', 51, 55),
      cand('a.ts', 6, 9),
      cand('a.ts', 52, 58),
    ]
    const r1 = matchFindings(annotations, candidates)
    const r2 = matchFindings(annotations, candidates)
    expect(r1).toEqual(r2)
    // 距离最近优先：c1(6-9)→a1、c0(51-55)→a2；c2(52-58) 为重复
    expect(r1.pairs).toContainEqual({ candidateIndex: 1, annotationIndex: 0 })
    expect(r1.pairs).toContainEqual({ candidateIndex: 0, annotationIndex: 1 })
    expect(r1.pairs.length).toBe(2)
    expect(r1.duplicateCount).toBe(1)
  })

  it('距离相同按候选键序破坏平局（固定行为）', () => {
    const annotations = [ann('a.ts', 10, 20)]
    const candidates = [cand('a.ts', 10, 12), cand('a.ts', 10, 15)]
    const r = matchFindings(annotations, candidates)
    // 键序：path|startLine|endLine → endLine 较小者（10-12）胜出
    expect(r.pairs).toEqual([{ candidateIndex: 0, annotationIndex: 0 }])
    expect(r.unmatchedCandidates).toEqual([1])
  })

  it('行段相交判定：边缘相接算相交，相离不算', () => {
    const annotations = [ann('a.ts', 10, 20)]
    expect(matchFindings(annotations, [cand('a.ts', 20, 25)]).pairs.length).toBe(1)
    expect(matchFindings(annotations, [cand('a.ts', 21, 25)]).pairs.length).toBe(0)
    expect(matchFindings(annotations, [cand('a.ts', 5, 10)]).pairs.length).toBe(1)
    expect(matchFindings(annotations, [cand('a.ts', 5, 9)]).pairs.length).toBe(0)
  })
})

describe('聚合与百分位', () => {
  it('聚合先求和再算派生指标（不做项目间平均）', () => {
    const a = computeProjectMetrics([ann('a.ts', 1, 2)], [cand('a.ts', 1, 2)])
    const b = computeProjectMetrics([ann('b.ts', 1, 2)], [cand('c.ts', 1, 2)])
    const t = aggregateMetrics([a, b])
    expect(t.tp).toBe(1)
    expect(t.fp).toBe(1)
    expect(t.fn).toBe(1)
    expect(t.precision).toBeCloseTo(0.5)
    expect(t.recall).toBeCloseTo(0.5)
    expect(t.f1).toBeCloseTo(0.5)
  })

  it('percentile 线性插值；空样本 N/A', () => {
    expect(percentile([], 0.5)).toBeNull()
    expect(percentile([5], 0.95)).toBe(5)
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5)
    expect(percentile([10, 20], 0.95)).toBeCloseTo(19.5)
    const values = [30, 10, 20, 40]
    expect(percentile(values, 0.5)).toBe(25)
  })
})
